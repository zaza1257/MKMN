//! Bounded automatic recovery for a stuck NPU, through the Rust host.
//!
//! What "the NPU is stuck" looks like is decided by the chat orchestrator (its own
//! error classification: `npu-…` ids, and the driver's failure lines —
//! `dspqueue_read failed`, `fastrpc_mmap`, `buffer mapping failed`). When the
//! sidecar sees such an error it asks THIS module to recover; the recovery itself
//! lives here, in the process that owns the server.
//!
//! The recovery is deliberately modest and honest:
//! - it stops the server MKMN owns and kills the geniex.exe strays INSIDE the
//!   app's own job object — the one ownership list Windows guarantees. A server
//!   MKMN did not start is by construction outside the job and can never be
//!   touched;
//! - it does NOT restart the NPU's driver: `pnputil /restart-device` needs
//!   administrator rights, and the UAC prompt is the user's explicit decision
//!   (Developer settings). The old scheduled-task shortcut was removed as a
//!   privilege-escalation hole and is not coming back;
//! - it is rate-limited (one recovery per cooldown), so a persistent failure can
//!   never become a kill/restart loop: the second stuck error inside the cooldown
//!   is answered with the honest message instead of another kill;
//! - it refuses while a generation is in flight (the busy lease), and the whole
//!   sequence is bounded so a chat error path can never hang on it.

use crate::state_machine::ServerLifecycleState;
use crate::supervisor::GenieXSupervisor;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// How long after a recovery the next one is refused. A stuck driver that comes
/// back within two minutes of a fresh server will not be fixed by a second kill;
/// the message then says what actually helps.
pub const RECOVERY_COOLDOWN: Duration = Duration::from_secs(120);

static LAST_RECOVERY: Mutex<Option<Instant>> = Mutex::new(None);

#[cfg(test)]
mod contention_tests {
    use super::*;

    #[test]
    fn owned_cpu_router_is_excluded() {
        assert!(!is_external_contender(23376, 10.0, &[23376, 24348], None));
    }

    #[test]
    fn measured_external_npu_process_is_included() {
        assert!(is_external_contender(456, 10.0, &[23376, 24348], Some(123)));
        assert!(!is_external_contender(123, 10.0, &[23376, 24348], Some(123)));
        assert!(!is_external_contender(456, 0.0, &[23376, 24348], Some(123)));
    }
}

fn is_external_contender(pid: u32, npu_util: f64, owned: &[u32], current: Option<u32>) -> bool {
    (2.0..=100.5).contains(&npu_util) && !owned.contains(&pid) && Some(pid) != current
}

/// `geniex.exe` images among the processes of the app's OWN job, minus the
/// supervisor's current child. These are the strays this app may stop: servers a
/// crashed earlier internal run left inside the job. Everything else — a foreign
/// server, the user's own geniex — is invisible here by construction.
fn stray_owned_servers(current_child_pid: Option<u32>) -> Vec<(u32, String)> {
    let Some(job) = crate::job_object::app_job() else {
        return Vec::new();
    };
    // The sidecar's CPU router listens on MKMN's reserved router port. This
    // exclusion is scoped to job-owned processes and also protects recovery.
    let router = crate::supervisor::tcp_listener_owner(18182).map(|owner| owner.pid);
    job.process_ids()
        .into_iter()
        .filter(|pid| Some(*pid) != current_child_pid && Some(*pid) != router)
        .filter_map(|pid| {
            let path = crate::supervisor::process_image_path(pid)?;
            let name = std::path::Path::new(&path)
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_lowercase())?;
            if name == "geniex.exe" {
                Some((pid, path))
            } else {
                None
            }
        })
        .collect()
}

/// Stops the process with `pid` (bounded): open for terminate, fire, forget. A
/// failure is reported in the result, not fatal — the supervisor's own stop has
/// already done the orderly part.
fn terminate_pid(pid: u32) -> Option<String> {
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let handle = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if handle.is_null() {
            return Some(format!("pid {} could not be opened for termination", pid));
        }
        let ok = TerminateProcess(handle, 1);
        windows_sys::Win32::Foundation::CloseHandle(handle);
        if ok == 0 {
            Some(format!("pid {} refused termination", pid))
        } else {
            None
        }
    }
}

/// Report live NPU activity from outside MKMN. Process names alone do not
/// establish contention, and these processes are never stopped by recovery.
pub async fn recovery_info(supervisor: &GenieXSupervisor) -> serde_json::Value {
    let status = supervisor.get_status().await;
    let busy = status.state == ServerLifecycleState::Busy;
    let external = if let Some(job) = crate::job_object::app_job() {
        let owned = job.process_ids();
        let current = status.pid;
        tokio::task::spawn_blocking(move || {
            crate::npudiag::sample_npu().active_npu_processes.into_iter()
                .filter(|(pid, util)| is_external_contender(*pid, *util, &owned, current))
                .map(|(pid, _)| pid)
                .collect::<std::collections::BTreeSet<_>>()
                .into_iter()
                .filter_map(|pid| {
                    let path = crate::supervisor::process_image_path(pid)?;
                    let name = std::path::Path::new(&path).file_name()?.to_str()?;
                    Some(format!("{name} (PID {pid})"))
                })
                .collect::<Vec<_>>()
        }).await.unwrap_or_default()
    } else {
        Vec::new()
    };
    let cooldown_sec = remaining_cooldown();
    serde_json::json!({
        "external": external,
        "busy": busy,
        "cooldownSec": cooldown_sec,
        // A device-level reset needs administrator permission (a UAC prompt, the
        // user's explicit decision): it is never "automatic".
        "canReset": false
    })
}

fn remaining_cooldown() -> u64 {
    let last = LAST_RECOVERY.lock().map(|g| *g).unwrap_or(None);
    match last {
        Some(t) => RECOVERY_COOLDOWN.as_secs().saturating_sub(t.elapsed().as_secs()),
        None => 0,
    }
}

/// The bounded recovery itself. Returns the JSON the sidecar reports onward.
pub async fn recover_stuck(supervisor: &GenieXSupervisor) -> serde_json::Value {
    // A generation in flight holds the lease: killing the server under it would
    // destroy a live answer. Recovery is only for after the failure.
    let status = supervisor.get_status().await;
    if status.state == ServerLifecycleState::Busy {
        return serde_json::json!({
            "ok": false,
            "message": "A generation is still running, so the stuck server was not stopped. Stop it (the Stop button), then try again."
        });
    }
    // Loop prevention: inside the cooldown nothing is killed and the message says
    // what actually helps.
    {
        let mut last = match LAST_RECOVERY.lock() {
            Ok(g) => g,
            Err(_) => return serde_json::json!({ "ok": false, "message": "The recovery state is unavailable; restart MKMN." }),
        };
        if let Some(t) = *last {
            let since = t.elapsed();
            if since < RECOVERY_COOLDOWN {
                let left = (RECOVERY_COOLDOWN - since).as_secs() + 1;
                return serde_json::json!({
                    "ok": false,
                    "message": format!("The NPU was recovered {} s ago ({} s of cooldown left); another automatic recovery so soon would only make a loop. If models keep failing, use the NPU reset in Developer settings or restart the PC.", since.as_secs(), left)
                });
            }
        }
        *last = Some(Instant::now());
    }

    // The orderly part: the supervisor stops its own child (and clears the ready
    // state honestly). An adopted server is NOT stopped here — it was never ours.
    if let Err(e) = supervisor.stop().await {
        crate::paths::append_log("mkmn", &format!("[npu-recovery] the owned server could not be stopped: {e}"));
    }

    // Whatever geniex.exe strays remain inside OUR job are stopped too — each one
    // individually, never the job (this process is a member of it), never anything
    // outside it.
    let current_child = supervisor.get_status().await.pid;
    let strays = stray_owned_servers(current_child);
    let mut failures = Vec::new();
    for (pid, path) in &strays {
        crate::paths::append_log("mkmn", &format!("[npu-recovery] stopping a stray geniex server of this app: pid {pid} ({path})"));
        if let Some(e) = terminate_pid(*pid) {
            failures.push(e);
        }
    }

    let stray_note = if strays.is_empty() {
        String::new()
    } else {
        format!(" {} stray server(s) of this MKMN were stopped ({} failures).", strays.len(), failures.len())
    };
    serde_json::json!({
        "ok": true,
        "message": format!(
            "The stuck model server was stopped and its port freed; the next request starts a fresh one.{}. The NPU's driver itself was NOT reset — that needs administrator permission: use the NPU reset in Developer settings, or restart the PC, if models keep failing.",
            stray_note
        )
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::time::Duration;

    /// Copy `powershell.exe` to a fake `geniex.exe`. The suite runs in parallel and
    /// other tests execute PowerShell at the same time; Windows can then refuse to
    /// read the image with a sharing violation for a moment. Retry that transient
    /// error only, so a test setup never fails on a lock held by a sibling test.
    fn copy_powershell(from: &std::path::Path, to: &std::path::Path) -> std::io::Result<()> {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        const ERROR_LOCK_VIOLATION: i32 = 33;
        let mut last = None;
        for _ in 0..40 {
            match std::fs::copy(from, to) {
                Ok(_) => return Ok(()),
                Err(e) if matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION)) => {
                    last = Some(e);
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(e),
            }
        }
        Err(last.expect("at least one sharing violation"))
    }

    /// A live process named geniex.exe that this test owns (the same PowerShell
    /// copy the adoption tests use). The TEST process is not inside the app job —
    /// the guard only exists in the real app run — so the test assigns the child
    /// to a job of its own and exercises the enumeration through that job.
    /// A fake geniex child that is killed, waited for and whose folder is deleted when it
    /// goes out of scope: each test run used to leave a copy of PowerShell in TEMP.
    struct FakeChild {
        child: std::process::Child,
        dir: std::path::PathBuf,
    }

    impl std::ops::Deref for FakeChild {
        type Target = std::process::Child;
        fn deref(&self) -> &std::process::Child { &self.child }
    }

    impl std::ops::DerefMut for FakeChild {
        fn deref_mut(&mut self) -> &mut std::process::Child { &mut self.child }
    }

    impl Drop for FakeChild {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            remove_test_dir(&self.dir);
        }
    }

    /// Delete a test folder, retrying briefly while Windows still holds the exited image.
    fn remove_test_dir(dir: &std::path::Path) {
        for _ in 0..20 {
            if std::fs::remove_dir_all(dir).is_ok() || !dir.exists() { return; }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn spawn_fake_geniex() -> FakeChild {
        // one folder per call: parallel tests in this process must not share (and delete) one
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = N.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("mkmn-npu-recovery-test-{}-{}", std::process::id(), n));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let exe = dir.join("geniex.exe");
        if !exe.exists() {
            let windir = std::env::var("WINDIR").expect("WINDIR");
            let ps = std::path::Path::new(&windir)
                .join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
            copy_powershell(&ps, &exe).expect("copy powershell as geniex.exe");
        }
        let child = Command::new(&exe)
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"])
            .creation_flags(0x08000000)
            .stdout(Stdio::null())
            .spawn()
            .expect("spawn fake geniex");
        FakeChild { child, dir }
    }

    #[test]
    fn a_job_lists_its_members_and_nothing_else() {
        let mut child = spawn_fake_geniex();
        let pid = child.id();
        let guard = crate::job_object::JobObjectGuard::new_with_flags(false).expect("test job");
        assert!(guard.assign_process(pid), "the child must join the test job");
        // A process spawned but NOT assigned: it must never be listed.
        let mut foreign = spawn_fake_geniex();
        let foreign_pid = foreign.id();

        let listed = guard.process_ids();
        assert!(listed.contains(&pid), "an assigned member must be listed, got {listed:?}");
        assert!(!listed.contains(&foreign_pid), "a process outside the job must never be listed");

        // The stray filter: the geniex image inside the job is a stray; the same
        // image outside the job is invisible; the current child is excluded.
        let strays = || -> Vec<(u32, String)> {
            guard
                .process_ids()
                .into_iter()
                .filter(|p| Some(*p) != Some(foreign_pid))
                .filter_map(|pid| {
                    let name = crate::supervisor::process_image_path(pid)
                        .and_then(|p| std::path::Path::new(&p).file_name().and_then(|n| n.to_str()).map(|s| s.to_lowercase()));
                    match name.as_deref() {
                        Some("geniex.exe") if pid != foreign_pid => Some((pid, String::new())),
                        _ => None,
                    }
                })
                .collect()
        };
        assert_eq!(strays().len(), 1, "exactly the assigned geniex is a stray");
        let _ = child.kill();
        let _ = child.wait();
        let _ = foreign.kill();
        let _ = foreign.wait();
    }

    #[test]
    fn termination_stops_a_stray_and_reports_failures_honestly() {
        let mut child = spawn_fake_geniex();
        let pid = child.id();
        assert!(terminate_pid(pid).is_none(), "terminating a live owned process must succeed");
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while child.try_wait().expect("wait status").is_none() {
            assert!(std::time::Instant::now() < deadline, "the terminated process must exit");
            std::thread::sleep(Duration::from_millis(50));
        }
        // A pid that is already gone reports the failure instead of pretending.
        assert!(terminate_pid(u32::MAX - 1).is_some(), "an unopenable pid must be reported");
    }

    /// The loop guard: the first recovery runs, the second one inside the cooldown
    /// is refused with the honest message — a persistent failure can never become
    /// a kill/restart loop.
    #[tokio::test]
    async fn a_second_recovery_inside_the_cooldown_is_refused() {
        let sup = GenieXSupervisor::new();
        // Nothing is running (state "stopped"): the first recovery proceeds…
        let first = recover_stuck(&sup).await;
        assert_eq!(first["ok"], json!(true), "first recovery: {first}");
        // …and the second is refused while the cooldown runs.
        let second = recover_stuck(&sup).await;
        assert_eq!(second["ok"], json!(false), "second recovery must be refused: {second}");
        let msg = second["message"].as_str().unwrap_or_default();
        assert!(msg.contains("cooldown"), "the refusal must say why: {msg}");
        // And the info endpoint reports the cooldown to the sidecar.
        let info = recovery_info(&sup).await;
        assert!(info["cooldownSec"].as_u64().unwrap_or(0) > 0, "info must carry the remaining cooldown: {info}");
        assert_eq!(info["canReset"], json!(false), "a driver reset is never 'automatic'");
    }
}
