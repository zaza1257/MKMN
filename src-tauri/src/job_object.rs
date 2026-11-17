use std::sync::OnceLock;
use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Threading::*;

pub struct JobObjectGuard {
    handle: HANDLE,
}

unsafe impl Send for JobObjectGuard {}
unsafe impl Sync for JobObjectGuard {}

/// Actionable Win32 error text for the last failed call in this thread.
fn last_error(action: &str) -> String {
    let code = unsafe { GetLastError() };
    let detail = match code {
        0 => "no error reported".to_string(),
        5 => "access denied (another elevated instance may already own the process)".to_string(),
        87 => "invalid parameter".to_string(),
        _ => format!("Win32 error {}", code),
    };
    format!("{} failed: {}", action, detail)
}

impl JobObjectGuard {
    /// Creates a job object with KILL_ON_JOB_CLOSE: when the last handle to the job
    /// closes (normally when MKMN.exe exits, however it exits), every process still
    /// inside the job is terminated. `kill_on_close = false` exists for tests, which
    /// must not terminate the test runner when a guard is dropped.
    pub fn new() -> Option<Self> {
        Self::new_with_flags(true)
    }

    pub fn new_with_flags(kill_on_close: bool) -> Option<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error("CreateJobObjectW")));
                return None;
            }

            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            if kill_on_close {
                info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            }

            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );

            if ok == 0 {
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error("SetInformationJobObject")));
                CloseHandle(handle);
                return None;
            }

            Some(Self { handle })
        }
    }

    pub fn assign_current_process(&self) -> bool {
        unsafe {
            let proc_handle = GetCurrentProcess();
            let ok = AssignProcessToJobObject(self.handle, proc_handle) != 0;
            if !ok {
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error("AssignProcessToJobObject(current process)")));
            }
            ok
        }
    }

    pub fn assign_process(&self, pid: u32) -> bool {
        unsafe {
            let proc_handle = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if proc_handle.is_null() {
                crate::paths::append_log("mkmn", &format!("[job_object] cannot open pid {} to assign it: {}", pid, last_error("OpenProcess")));
                return false;
            }
            let res = AssignProcessToJobObject(self.handle, proc_handle);
            if res == 0 {
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error(&format!("AssignProcessToJobObject(pid {})", pid))));
            }
            CloseHandle(proc_handle);
            res != 0
        }
    }

    /// Every process id currently inside THIS job: the one ownership list that
    /// cannot lie or overreach. A process not assigned here (a foreign server, a
    /// user's own geniex) is by construction absent — job membership is inherited
    /// at spawn and can only be granted by this app.
    pub fn process_ids(&self) -> Vec<u32> {
        #[repr(C)]
        struct ProcessIdList {
            assigned: u32,
            listed: u32,
            pids: [usize; 512],
        }
        unsafe {
            let mut list: ProcessIdList = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.handle,
                JobObjectBasicProcessIdList,
                &mut list as *mut _ as *mut _,
                std::mem::size_of::<ProcessIdList>() as u32,
                std::ptr::null_mut(),
            );
            if ok == 0 {
                // A job with more members than the buffer holds fails the query:
                // report nothing rather than a truncated (wrong) list.
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error("QueryInformationJobObject(process id list)")));
                return Vec::new();
            }
            list.pids[..(list.listed as usize).min(list.pids.len())]
                .iter()
                .map(|&p| p as u32)
                .collect()
        }
    }

    /// Read-back verification: the limits must say KILL_ON_JOB_CLOSE, or containment
    /// is a promise the job will not keep. Returns false (with a logged reason) when
    /// the query fails or the flag is missing.
    pub fn verify_kill_on_close(&self) -> bool {
        unsafe {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            let ok = QueryInformationJobObject(
                self.handle,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                std::ptr::null_mut(),
            );
            if ok == 0 {
                crate::paths::append_log("mkmn", &format!("[job_object] {}", last_error("QueryInformationJobObject")));
                return false;
            }
            let kill = info.BasicLimitInformation.LimitFlags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE != 0;
            if !kill {
                crate::paths::append_log("mkmn", "[job_object] VERIFICATION FAILED: the job object lost KILL_ON_JOB_CLOSE; owned children may outlive a crash. Restart MKMN; if it persists, check antivirus interference with Job Objects.");
            }
            kill
        }
    }

    /// Terminates every process still inside the job. FOR TESTS ONLY (the caller
    /// must not be inside the job itself): TerminateJobObject on the app's own job
    /// would terminate MKMN.exe mid-shutdown — in the real exit path, containment
    /// is the job's KILL_ON_JOB_CLOSE firing at process exit (verified by the
    /// tests below and by the packaged acceptance run).
    pub fn terminate_all(&self) -> bool {
        unsafe { TerminateJobObject(self.handle, 0) != 0 }
    }
}

impl Drop for JobObjectGuard {
    fn drop(&mut self) {
        if !self.handle.is_null() {
            unsafe {
                CloseHandle(self.handle);
            }
        }
    }
}

static APP_JOB_GUARD: OnceLock<JobObjectGuard> = OnceLock::new();
static CONTAINMENT_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// True when the current process was successfully assigned to a verified
/// kill-on-close job: owned children (WebView2, sidecar, its workers, geniex
/// servers, benchmark children) are guaranteed to terminate with the host.
pub fn containment_active() -> bool {
    CONTAINMENT_ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

/// The app's own job guard, when containment was set up. Callers use it to scope
/// ownership questions (which geniex processes are OURS?) to the one list Windows
/// guarantees: job membership.
pub fn app_job() -> Option<&'static JobObjectGuard> {
    APP_JOB_GUARD.get()
}

// NOTE: the shutdown path does NOT call TerminateJobObject on the app job — the
// current process is a member of it, and terminating the job would terminate
// MKMN.exe mid-shutdown. Containment relies on KILL_ON_JOB_CLOSE firing when the
// process exits; the uncontained fallback lives in shutdown.rs (reap_remaining_owned).

/// Enforces that the current process (MKMN.exe) and all its spawned children (WebView2, sidecars)
/// are bound to a Win32 Job Object with KILL_ON_JOB_CLOSE. Every failure is logged with an
/// actionable reason; the safe fallback (no job) is explicit termination of the known owned
/// processes during the coordinated shutdown (src-tauri/src/shutdown.rs) plus the scoped
/// process matching in the installer.
pub fn init_process_lifecycle_guard() {
    match JobObjectGuard::new() {
        Some(guard) => {
            if !guard.assign_current_process() {
                // The most common cause: this process is already inside another job
                // (a debugger, a CI runner, a launcher) that does not allow nesting.
                crate::paths::append_log("mkmn", "[job_object] FALLBACK: running without a job object — owned children are terminated explicitly during shutdown instead; a hard kill of MKMN.exe (Task Manager, crash) may leave them behind.");
                return;
            }
            if !guard.verify_kill_on_close() {
                // Assigned, but the configuration cannot be proven: keep the guard
                // (assignment cannot be undone) but report containment as unverified.
                CONTAINMENT_ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
                let _ = APP_JOB_GUARD.set(guard);
                return;
            }
            CONTAINMENT_ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
            crate::paths::append_log("mkmn", "[job_object] process lifecycle guard active (KILL_ON_JOB_CLOSE verified).");
            let _ = APP_JOB_GUARD.set(guard);
        }
        None => {
            crate::paths::append_log("mkmn", "[job_object] FALLBACK: the job object could not be created (see the error above) — owned children are terminated explicitly during shutdown instead; a hard kill of MKMN.exe may leave them behind.");
        }
    }
}

/// The last step of the coordinated shutdown. With verified containment, nothing
/// more is needed: the job's KILL_ON_JOB_CLOSE terminates every owned descendant
/// (sidecar, its voice worker, geniex servers, benchmark children) the instant this
/// process exits — however it exits. TerminateJobObject must NOT be called on the
/// app's own job: the current process is a member, and it would die mid-shutdown.
/// Without containment (the logged fallback above), the one process that can be
/// orphaned silently — a voice worker forked from the bundled node.exe by the now
/// dead sidecar — is killed explicitly, path-scoped to THIS installation.
pub async fn reap_remaining_owned(app: &AppHandle) {
    if containment_active() {
        crate::paths::append_log("mkmn", "[shutdown] containment verified: the job object reaps remaining owned descendants at process exit");
        return;
    }
    let node = app.try_state::<crate::sidecar::SidecarHost>().map(|h| h.node_path());
    let Some(node) = node else { return };
    let target = node.to_string_lossy().to_string();
    crate::paths::append_log("mkmn", &format!("[shutdown] no verified job object: path-scoped cleanup of owned runtime processes under {}", target));
    let script = format!(
        "Get-Process node -ErrorAction SilentlyContinue | Where-Object {{ $_.Path -eq '{}' }} | ForEach-Object {{ Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }}; exit 0",
        target.replace('\'', "''")
    );
    let _ = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tauri::async_runtime::spawn_blocking(move || {
            let mut cmd = std::process::Command::new("powershell.exe");
            cmd.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
            }
            cmd.status()
        }),
    )
    .await;
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    /// Spawns a process chain whose GRANDCHILD does not exist yet: the outer cmd
    /// first idles ~2 s (ping), then starts `cmd /c ping -n 30 …` (inner cmd → ping).
    /// The caller must assign the outer process to a job within that window, so the
    /// grandchild is CREATED INSIDE the job and inherits its membership (a process
    /// spawned before assignment would sit outside it).
    // the job object these tests assign the process to ends it: nothing waits on the child here
    #[allow(clippy::zombie_processes)]
    fn spawn_delayed_chain() -> u32 {
        let child = Command::new("cmd")
            .args(["/c", "ping -n 3 127.0.0.1 >nul & cmd /c ping -n 30 127.0.0.1"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test chain");
        child.id()
    }

    /// Waits for the grandchild (the inner cmd) to appear and returns its pid.
    fn wait_grandchild(parent: u32) -> u32 {
        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            let out = Command::new("powershell")
                .args([
                    "-NoProfile",
                    "-Command",
                    &format!(
                        "(Get-CimInstance Win32_Process -Filter \"ParentProcessId = {}\" | Select-Object -First 1).ProcessId",
                        parent
                    ),
                ])
                .output()
                .expect("run powershell");
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if let Ok(pid) = s.parse::<u32>() {
                return pid;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        panic!("test setup: the grandchild never appeared");
    }

    fn alive(pid: u32) -> bool {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let _ = GetExitCodeProcess(h, &mut code);
            CloseHandle(h);
            // STILL_ACTIVE == 259
            code == 259
        }
    }

    fn wait_dead(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        !alive(pid)
    }

    #[test]
    fn job_configuration_verifies_kill_on_close() {
        let guard = JobObjectGuard::new().expect("job object creation should succeed on Windows");
        assert!(guard.verify_kill_on_close(), "a freshly configured job must verify as KILL_ON_JOB_CLOSE");
    }

    #[test]
    #[allow(clippy::zombie_processes)] // the job object this test assigns the child to ends it
    fn assignment_result_is_reported_for_a_real_child() {
        let mut child = Command::new("cmd").args(["/c", "ping -n 30 127.0.0.1"]).stdout(Stdio::null()).spawn().expect("spawn");
        let pid = child.id();
        let guard = JobObjectGuard::new().expect("job object");
        assert!(guard.assign_process(pid), "assigning a live child must succeed (result is no longer ignored)");
        let _ = child.kill();
    }

    #[test]
    fn closing_the_job_kills_the_child_and_grandchild() {
        // The containment contract after a forced host termination: closing the job
        // handle (what happens when the host exits, however it exits) must take down
        // the whole tree — child AND grandchild — without anyone calling kill on them.
        let child = spawn_delayed_chain();
        let guard = JobObjectGuard::new().expect("job object");
        assert!(guard.assign_process(child)); // inside the 2 s window, before the grandchild is created
        let grandchild = wait_grandchild(child);
        std::thread::sleep(Duration::from_millis(300));
        drop(guard); // KILL_ON_JOB_CLOSE fires here
        assert!(wait_dead(grandchild, Duration::from_secs(10)), "grandchild must die with the job");
        assert!(wait_dead(child, Duration::from_secs(10)), "child must die with the job");
    }

    #[test]
    fn terminate_all_stops_the_whole_tree() {
        let child = spawn_delayed_chain();
        let guard = JobObjectGuard::new().expect("job object");
        assert!(guard.assign_process(child));
        let grandchild = wait_grandchild(child);
        std::thread::sleep(Duration::from_millis(300));
        assert!(guard.terminate_all());
        assert!(wait_dead(grandchild, Duration::from_secs(10)));
        assert!(wait_dead(child, Duration::from_secs(10)));
    }

    #[test]
    fn a_job_without_kill_on_close_leaves_processes_alive() {
        // The control for the two tests above: without KILL_ON_JOB_CLOSE, dropping the
        // guard must NOT kill the tree (so a green kill test really tested the flag).
        let child = spawn_delayed_chain();
        let guard = JobObjectGuard::new_with_flags(false).expect("job object");
        assert!(guard.assign_process(child));
        std::thread::sleep(Duration::from_millis(300));
        drop(guard);
        std::thread::sleep(Duration::from_millis(500));
        assert!(alive(child), "control: the child must survive a plain job close");
        let _ = Command::new("taskkill").args(["/PID", &child.to_string(), "/T", "/F"]).output();
    }
}
