//! The ONE coordinated, idempotent shutdown path for every exit: the title-bar close
//! button, the native window close, the tray Quit, and the application exit itself.
//!
//! Order (each step bounded, failures logged, never allowed to hang the exit):
//!   1. raise the shutdown flag — command entry points refuse NEW work from here on;
//!   2. tell the renderer to abort its in-flight work (streams, fetches, UI timers);
//!   3. cancel the active benchmark (its geniex-infer child dies at the next poll);
//!   4. the Node sidecar: a graceful `appShutdown` call (cancels downloads, kills
//!      tool runs, stops the voice worker, stops the benchmark runner) with a short
//!      grace period, then a bounded kill;
//!   5. the model server (geniex.exe) via the supervisor's unconditional stop;
//!   6. terminate whatever owned descendant remains through the verified job object.
//!
//! Idempotency: exactly one caller runs the sequence; every other caller (a second
//! Quit click, the Exit event racing a tray Quit) waits for it to finish, with a
//! bounded timeout. Whatever still hangs after the timeout is terminated by the
//! job object when the process exits (KILL_ON_JOB_CLOSE), or explicitly in step 6.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

/// Grace period for the sidecar's own cooperative cleanup (cancel downloads, stop
/// runs, close the voice worker). Long enough for local cancellations, short enough
/// that quitting never feels stuck.
const SIDECAR_GRACE: Duration = Duration::from_secs(3);
/// Bound for the supervisor's server stop (it kills the child and waits for exit).
const SUPERVISOR_TIMEOUT: Duration = Duration::from_secs(5);
/// Total bound a late joiner (the final Exit event) waits on the running sequence;
/// the job object covers anything left after this.
const WAIT_TIMEOUT: Duration = Duration::from_secs(10);
/// Absolute ceiling for the whole teardown. The title-bar close must never leave a
/// windowless process behind; Windows itself allows roughly 5 s at session end.
const WATCHDOG_TIMEOUT: Duration = Duration::from_millis(4500);

static STARTED: AtomicBool = AtomicBool::new(false);
static DONE: AtomicBool = AtomicBool::new(false);

/// Command entry points consult this to refuse NEW work while the application is
/// shutting down (a chat request, a benchmark, a download started in the same instant
/// the user clicked Quit must not spin the runtime back up).
pub fn is_shutting_down() -> bool {
    STARTED.load(Ordering::SeqCst)
}

fn log(line: &str) {
    crate::paths::append_log("mkmn", &format!("[shutdown] {}", line));
}

/// Runs the full coordinated shutdown exactly once. Concurrent and repeated callers
/// wait for the running sequence instead of starting a second one.
pub async fn run(app: &AppHandle) {
    if DONE.load(Ordering::SeqCst) {
        return;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        // Someone is already running the sequence: wait for it, bounded.
        let _ = wait_done(WAIT_TIMEOUT).await;
        return;
    }
    let t0 = Instant::now();
    // The exit line carries the process identity: a log full of several
    // processes' lines (dev + installed, older + current) must say WHOSE exit
    // this sequence belongs to.
    log(&format!("starting coordinated shutdown ({})", crate::paths::process_identity()));
    log("step 1/6 shutdown flag raised; new work is refused");

    // A native watchdog, armed before any await: the reported hang never reached the
    // Tauri exit event, so no async path could recover it. This thread only ends THIS
    // process; the job object takes its owned descendants with it.
    arm_watchdog();

    // 2. the renderer aborts its in-flight work (the event also stops the UI from
    // starting anything that would need the runtime we are about to tear down).
    log("step 2/6 renderer: app-shutdown event");
    let _ = app.emit("app-shutdown", ());

    // 3. the active benchmark (Rust side): its child is killed at the next poll.
    log("step 3/6 benchmark: cancel");
    crate::bench::cancel_benchmark();

    // 4. the Node sidecar: cooperative cleanup first, then a bounded kill. A dead or
    // never-started sidecar must not fail the exit — and must not be SPAWNED just to
    // be shut down (a plain call would ensure_spawned first).
    log("step 4/6 sidecar: appShutdown, then bounded stop");
    let mut inventory: Vec<String> = Vec::new();
    if let Some(host) = app.try_state::<crate::sidecar::SidecarHost>() {
        let host = host.inner();
        if host.is_running().await {
            match tokio::time::timeout(SIDECAR_GRACE, host.call("appShutdown", serde_json::json!([]))).await {
                Ok(Ok(_)) => log("sidecar acknowledged appShutdown"),
                Ok(Err(e)) => log(&format!("sidecar appShutdown refused ({}); killing it", e)),
                Err(_) => log("sidecar did not answer appShutdown in time; killing it"),
            }
            host.shutdown().await;
            log("sidecar stopped");
            inventory.push("sidecar stopped".to_string());
        } else {
            inventory.push("sidecar was not running".to_string());
        }
    } else {
        inventory.push("sidecar host was not managed".to_string());
    }

    // 4b. the Computer Use driver: a bounded kill (no cooperative state; the run
    // in the sidecar was just told to stop by appShutdown's abort of its runs).
    log("step 4b/6 agent-desktop driver: bounded stop");
    if let Some(driver) = app.try_state::<crate::agent_driver::AgentDriverHost>() {
        driver.shutdown().await;
        inventory.push("agent-desktop driver stopped".to_string());
    }

    // 5. the model server: an unconditional kill (no busy-lease refusal on the exit
    // path — the process is going away either way).
    log("step 5/6 model server: unconditional stop");
    if let Some(sup) = app.try_state::<crate::supervisor::GenieXSupervisor>() {
        match tokio::time::timeout(SUPERVISOR_TIMEOUT, sup.inner().stop()).await {
            Ok(_) => {
                log("model server stopped");
                inventory.push("model server stopped".to_string());
            }
            Err(_) => {
                log("model server stop timed out; the job object or the explicit termination below finishes it");
                inventory.push("model server stop timed out".to_string());
            }
        }
    }

    // 6. whatever owned descendant remains (a hung voice worker, an orphaned
    // geniex-infer, a code-run child) dies here — or with the job handle at exit.
    log("step 6/6 inventory owned descendants and reap them");
    let owned_before = crate::job_object::app_job()
        .map(|j| j.process_ids().len())
        .unwrap_or(0);
    crate::job_object::reap_remaining_owned(app).await;
    let owned_after = crate::job_object::app_job()
        .map(|j| j.process_ids().len())
        .unwrap_or(0);
    inventory.push(format!(
        "owned-job processes: {owned_before} before reap, {owned_after} after"
    ));

    DONE.store(true, Ordering::SeqCst);
    let elapsed = t0.elapsed();
    log(&format!("inventory: {}", inventory.join("; ")));
    write_clean_exit_marker(elapsed, &inventory);
    log(&format!("coordinated shutdown finished in {} ms", elapsed.as_millis()));
}

/// Hard upper bound: if the sequence has not completed by WATCHDOG_TIMEOUT, end this
/// process explicitly. It must never sleep forever waiting for an exit event that the
/// hang may prevent Tauri from delivering (the report wrote no [shutdown] line).
fn arm_watchdog() {
    std::thread::spawn(|| {
        std::thread::sleep(WATCHDOG_TIMEOUT);
        if DONE.load(Ordering::SeqCst) {
            return;
        }
        log("watchdog expired before the coordinated shutdown finished; forcing process exit");
        std::process::exit(1);
    });
}

/// Written only after step 6 completed: the check after a close can tell a real clean
/// exit from a kill, a crash, or the watchdog forcing the process down.
fn write_clean_exit_marker(elapsed: Duration, inventory: &[String]) {
    let dir = crate::paths::get_logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    let marker = dir.join("last-clean-exit.json");
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let payload = serde_json::json!({
        "clean": true,
        "pid": std::process::id(),
        "at": at,
        "durationMs": elapsed.as_millis() as u64,
        "inventory": inventory,
    });
    let serialized = serde_json::to_string_pretty(&payload).unwrap_or_default();
    match std::fs::write(&marker, serialized) {
        Ok(_) => log(&format!("clean-exit marker written to {:?}", marker)),
        Err(e) => log(&format!("clean-exit marker could not be written to {:?}: {e}", marker)),
    }
}

async fn wait_done(timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !DONE.load(Ordering::SeqCst) {
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    true
}

/// Fires the shutdown sequence without waiting for it: used from ExitRequested, so
/// the teardown overlaps with the window teardown instead of starting after it.
pub fn kick(app: &AppHandle) {
    if DONE.load(Ordering::SeqCst) || STARTED.load(Ordering::SeqCst) {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        run(&app).await;
    });
}

/// The last event before the process exits: make sure the sequence ran (or started
/// now, if this exit path skipped ExitRequested), waiting at most WAIT_TIMEOUT.
/// Everything left after that is killed by the job object at process exit.
pub async fn finish(app: &AppHandle) {
    if !STARTED.load(Ordering::SeqCst) {
        run(app).await;
        return;
    }
    if !wait_done(WAIT_TIMEOUT).await {
        log("shutdown did not finish in time; exiting anyway (the job object terminates the rest)");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_flag_is_not_raised_before_any_exit_starts() {
        // The command gates must not refuse work in a freshly started app. This
        // process never ran the shutdown sequence; DONE/STARTED are process state,
        // and in the test binary they are still false.
        assert!(!is_shutting_down());
        assert!(!DONE.load(Ordering::SeqCst));
    }
}
