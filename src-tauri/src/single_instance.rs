//! Single-instance ownership for MKMN on Windows.
//!
//! Why this exists (seen on an installed build): with no instance guard,
//! every launch — including rapid re-launches after a hang — started a full second
//! app: another WebView2 environment, another sidecar, another model-server lease on
//! the same port. Worse, the old `cleanup_stray_webview_processes` heuristics let each
//! new launch kill the WebView2 processes of every OLDER instance, including live
//! ones: the victim kept running with a dead webview (wry logged HRESULT 0x8007139F
//! on every 5-second metrics emit), showed nothing, never exited, and Windows recorded
//! Application Hangs. Seven MKMN.exe processes with six sidecars accumulated from four
//! double-clicks within a minute.
//!
//! Design:
//! - A named mutex (`Local\…`, one per session — each logged-in user gets their own
//!   instance, which is correct for a per-user application) is acquired FIRST, before
//!   the job object, the stray-webview cleanup, or the Tauri runtime exist. A second
//!   launch can therefore never spawn a sidecar, a model runtime, or cleanup that
//!   could touch a live instance.
//! - Stale ownership cannot happen: the kernel destroys the mutex when the owning
//!   process dies (cleanly or crashed), so a fresh launch always acquires it.
//! - A later launch signals the existing instance through a message-only window
//!   (`WM_APP+1`); the first instance restores, unminimizes, and focuses its main
//!   window, and the second process exits cleanly — nothing else is initialized.
//! - Privilege levels: a non-elevated process cannot post to an elevated window
//!   (Windows UIPI blocks it). That failure is detected and reported with an
//!   actionable message instead of silently piling up background processes.
//! - Development versus installed builds are EXPLICITLY separate scopes: distinct
//!   mutex names and distinct WebView2 data directories (see
//!   `crate::paths::webview_data_dir`). A `tauri dev` run never touches the
//!   installed app's profile, lock, or single-instance state, and both may run at
//!   the same time without profile contention.

use std::hash::{BuildHasher, Hasher};
use std::time::{Duration, Instant};

use tauri::AppHandle;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE, HWND, LPARAM, WPARAM,
};
use windows::Win32::System::Threading::{
    CreateEventW, CreateMutexW, OpenEventW, WaitForSingleObject, SYNCHRONIZATION_SYNCHRONIZE,
};
use windows::Win32::UI::WindowsAndMessaging::{
    ChangeWindowMessageFilterEx, CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW,
    GetMessageW, MessageBoxW, PostMessageW, PostQuitMessage, RegisterClassExW, TranslateMessage,
    HWND_MESSAGE, MB_ICONWARNING, MB_SETFOREGROUND, MB_TOPMOST, MSG, MSGFLT_ALLOW,
    WINDOW_EX_STYLE, WINDOW_STYLE, WM_APP, WM_DESTROY, WNDCLASSEXW,
};
use windows::Win32::Foundation::{LRESULT, WAIT_OBJECT_0};

/// The custom message the second instance posts to bring the first instance up.
const WM_APP_RESTORE: u32 = WM_APP + 1;

/// How long a second launch waits for the first instance's restore window to exist.
/// Covers the race where the first instance is still between mutex acquisition and
/// window creation (its setup has not run yet). If it expires, the conflict is
/// reported and the second launch still exits — it never starts a competing app.
const RESTORE_WINDOW_TIMEOUT: Duration = Duration::from_secs(8);
const RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// Which flavor of the app this process is. Development builds (cargo debug, the
/// `tauri dev` flow) and installed release builds are deliberately separate scopes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BuildFlavor {
    Installed,
    Development,
}

pub fn current_flavor() -> BuildFlavor {
    if cfg!(debug_assertions) {
        BuildFlavor::Development
    } else {
        BuildFlavor::Installed
    }
}

/// The mutex and window-class names for this build flavor. Distinct names keep a
/// `tauri dev` run and the installed app from ever fighting over the same instance
/// state or the same WebView2 profile.
fn instance_scope_suffix() -> &'static str {
    match current_flavor() {
        BuildFlavor::Installed => "",
        BuildFlavor::Development => "-dev",
    }
}

/// The named mutex guarding instance ownership for this build flavor.
pub fn instance_mutex_name() -> String {
    format!("Local\\app.mkmn.desktop.single-instance{}", instance_scope_suffix())
}

/// The class of the message-only window the owning instance listens on.
fn restore_window_class() -> String {
    format!("MKMN_SingleInstance{}", instance_scope_suffix())
}

/// How long a second launch waits for the owner to CONFIRM it restored its
/// window (the ack event being signalled). Distinct from `RESTORE_WINDOW_TIMEOUT`
/// (waiting for the window to exist): a posted message is delivery, not a result.
/// Stays well above the owner's own retry budget (`RESTORE_RETRY_BUDGET`), so an
/// owner that is still working — or about to report an honest failure — is heard
/// before this launch gives up on it.
const ACK_TIMEOUT: Duration = Duration::from_secs(10);
/// Interval for opening the owner-created ack event that may not exist yet.
const ACK_OPEN_INTERVAL: Duration = Duration::from_millis(20);

/// Name of the ack event the OWNER creates to confirm a restore with a given
/// token. Both flavors share the token namespace shape but differ by the scope
/// suffix, like the mutex and window class.
fn ack_event_name(token: u32) -> String {
    format!(
        "Local\\app.mkmn.desktop.restore-ack-{:08x}{}",
        token,
        instance_scope_suffix()
    )
}

/// Name of the existence-only event the owner creates when its restore listener
/// understands ack tokens. A second launch only waits for an ack when this object
/// exists, so an owner built before the ack protocol is never waited on (it would
/// restore the window but never signal).
fn ack_supported_event_name() -> String {
    format!(
        "Local\\app.mkmn.desktop.restore-ack-supported{}",
        instance_scope_suffix()
    )
}

/// A nonzero token that is very unlikely to collide across launches. Zero is
/// reserved: it is what a non-ack-aware launch posts, and the owner must never
/// try to acknowledge it.
fn new_restore_token() -> u32 {
    loop {
        let candidate =
            std::collections::hash_map::RandomState::new().build_hasher().finish() as u32;
        if candidate != 0 {
            return candidate;
        }
    }
}

/// True when the window found belongs to an owner whose listener understands
/// ack tokens (it created the marker event at startup).
fn ack_capable_owner() -> bool {
    let name = wide(&ack_supported_event_name());
    match unsafe { OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(name.as_ptr())) } {
        Ok(h) => {
            unsafe { let _ = CloseHandle(h); }
            true
        }
        Err(_) => false,
    }
}

/// Handles of named ack events (and the ack-support marker) that must stay open
/// for the process lifetime: a named event object with no open handle is
/// destroyed by the kernel, even while signalled, which would lose an
/// acknowledgement that had not been observed yet. Restores are human-scale
/// rare, so the set stays tiny. Stored as raw values because the raw `HANDLE`
/// type is not `Send`; the numeric value is all that must be preserved.
static PERSISTENT_EVENT_HANDLES: std::sync::Mutex<Vec<isize>> = std::sync::Mutex::new(Vec::new());

fn keep_event_handle_open(handle: HANDLE) {
    PERSISTENT_EVENT_HANDLES
        .lock()
        .expect("ack handle registry poisoned")
        .push(handle.0 as isize);
}

/// Name of the failure event the OWNER creates when it received a restore request
/// (token) but could NOT bring its window up within its retry budget. Its existence
/// lets the requesting launch report an honest failure instead of assuming success.
fn restore_failure_event_name(token: u32) -> String {
    format!(
        "Local\\app.mkmn.desktop.restore-failed-{:08x}{}",
        token,
        instance_scope_suffix()
    )
}

/// Owner side: confirm to the requesting launch that its window-restore request
/// was PROCESSED AND SUCCEEDED. Creates the token-named event already signalled,
/// so the requester — whatever its privilege level relative to ours — can observe
/// it. A restore that failed must NOT create this event (see
/// `report_restore_failure`): an acknowledgement would tell the second launch
/// everything went well while nothing appeared on screen.
fn acknowledge_restore(token: u32) {
    let name = ack_event_name(token);
    let name_w = wide(&name);
    match unsafe { CreateEventW(None, true, true, PCWSTR(name_w.as_ptr())) } {
        Ok(handle) => {
            // Already created signalled; keep the handle open so the object
            // outlives this call (see `PERSISTENT_EVENT_HANDLES`).
            keep_event_handle_open(handle);
            crate::paths::startup_log(
                "instance-restore-listener",
                &format!("restore request acknowledged (token {name})"),
            );
        }
        Err(e) => crate::paths::startup_log(
            "instance-restore-listener",
            &format!("could not create ack event: {e}"),
        ),
    }
}

/// Owner side: tell the requesting launch — honestly — that the restore failed.
/// The reason itself is in this process's log; the event only carries the fact.
fn report_restore_failure(token: u32) {
    let name = restore_failure_event_name(token);
    let name_w = wide(&name);
    match unsafe { CreateEventW(None, true, true, PCWSTR(name_w.as_ptr())) } {
        Ok(handle) => {
            keep_event_handle_open(handle);
            crate::paths::startup_log(
                "instance-restore-listener",
                &format!("restore failure reported to the requesting launch (token {name})"),
            );
        }
        Err(e) => crate::paths::startup_log(
            "instance-restore-listener",
            &format!("could not create the restore-failure event: {e}"),
        ),
    }
}

/// How long the OWNING instance retries a restore that failed (for example while
/// its main window is still being created during startup). Must stay comfortably
/// inside `ACK_TIMEOUT` (the requesting launch's patience) so the requester is
/// still waiting when the owner gives up and reports the failure.
const RESTORE_RETRY_BUDGET: Duration = Duration::from_secs(5);

/// A UTF-16, NUL-terminated copy of `s` for Win32 wide-string APIs.
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Outcome of the ownership attempt.
pub enum Ownership {
    /// This process owns the instance; startup proceeds.
    Acquired,
    /// Another instance owns it; it was signaled (or the failure reported) and this
    /// process must exit cleanly without initializing anything else.
    AlreadyRunning,
}

#[derive(Debug)]
enum MutexAttempt {
    Created(HANDLE),
    Exists,
    Failed(String),
}

/// One attempt to create (take ownership of) the instance mutex.
fn try_create_mutex(name: &str) -> MutexAttempt {
    let name_w = wide(name);
    match unsafe { CreateMutexW(None, false, PCWSTR(name_w.as_ptr())) } {
        Ok(handle) => {
            if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
                // The object already existed: someone else owns it. We must NOT keep
                // this handle (it would keep the named object alive after we exit,
                // which is harmless, but closing it is the honest thing to do).
                unsafe { let _ = CloseHandle(handle); }
                MutexAttempt::Exists
            } else {
                MutexAttempt::Created(handle)
            }
        }
        Err(e) => MutexAttempt::Failed(format!(
            "CreateMutexW({name}) failed: {e} — if an MKMN instance was started as \
             administrator, close it from its own tray icon first"
        )),
    }
}

/// The instance entry point: acquire ownership, or signal the owner and report.
///
/// MUST run before the job-object guard, the stray-webview cleanup, or any Tauri
/// runtime initialization — those must never run in a losing process.
pub fn acquire() -> Ownership {
    let name = instance_mutex_name();
    let deadline = Instant::now() + RESTORE_WINDOW_TIMEOUT;
    loop {
        match try_create_mutex(&name) {
            MutexAttempt::Created(handle) => {
                // HANDLE has no destructor: the handle simply stays open for the
                // whole process lifetime (never Closed), so while we live the named
                // object exists; when we die — however we die — the kernel releases
                // it, and a later launch always acquires cleanly.
                let _ = handle;
                return Ownership::Acquired;
            }
            MutexAttempt::Exists => {
                match signal_running_instance() {
                    SignalOutcome::Signaled => {
                        crate::paths::startup_log(
                            "instance-conflict",
                            "another MKMN instance is running; restore requested, exiting cleanly",
                        );
                        return Ownership::AlreadyRunning;
                    }
                    SignalOutcome::SignalingFailed(reason) => {
                        // Do not accumulate a second background process: report and exit.
                        crate::paths::startup_log(
                            "instance-conflict",
                            &format!("another MKMN instance is running but could not be restored: {reason}"),
                        );
                        show_recovery_error(&reason);
                        return Ownership::AlreadyRunning;
                    }
                    SignalOutcome::Unconfirmed(reason) => {
                        // The notification reached the owner; its outcome is unknown.
                        // Exiting is still correct: a competing instance must never start.
                        crate::paths::startup_log(
                            "instance-conflict",
                            &format!("restore request delivered but not confirmed: {reason}"),
                        );
                        show_recovery_error(&reason);
                        return Ownership::AlreadyRunning;
                    }
                    SignalOutcome::WindowNotFound => {
                        if Instant::now() >= deadline {
                            crate::paths::startup_log(
                                "instance-conflict",
                                "another MKMN instance holds the instance lock but never exposed a \
                                 restore window (it may still be starting, hung, or shutting down); \
                                 exiting without starting a second instance",
                            );
                            return Ownership::AlreadyRunning;
                        }
                        std::thread::sleep(RETRY_INTERVAL);
                        // Loop back and retry the mutex too: if the first instance died
                        // in those milliseconds, ownership is free and THIS launch wins.
                    }
                }
            }
            MutexAttempt::Failed(reason) => {
                crate::paths::startup_log("instance-conflict", &reason);
                show_recovery_error(&reason);
                return Ownership::AlreadyRunning;
            }
        }
    }
}

enum SignalOutcome {
    /// The owner confirmed it processed the restore request (or is an older
    /// build whose listener restores the window without acknowledging).
    Signaled,
    /// The notification itself was refused (for example by Windows' privilege
    /// filtering between an ordinary launch and an elevated owner).
    SignalingFailed(String),
    /// The notification reached the owner, but it never confirmed restoring its
    /// window within the ack budget. Delivery is proven; the outcome is not.
    Unconfirmed(String),
    WindowNotFound,
}

/// Ask the owning instance to show its main window. Bounded; never hangs.
fn signal_running_instance() -> SignalOutcome {
    let class_w = wide(&restore_window_class());
    let class = PCWSTR(class_w.as_ptr());
    let deadline = Instant::now() + RESTORE_WINDOW_TIMEOUT;
    loop {
        // Message-only windows live under the HWND_MESSAGE parent.
        let found = unsafe { FindWindowExW(Some(HWND_MESSAGE), None, class, PCWSTR::null()) };
        match found {
            Ok(hwnd) if !hwnd.is_invalid() => return signal_owner(hwnd),
            _ => {
                if Instant::now() >= deadline {
                    return SignalOutcome::WindowNotFound;
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
        }
    }
}

/// Post the restore request to the owner's window and, when it understands the
/// ack protocol, wait — bounded — for its confirmation. The three failure shapes
/// are kept apart on purpose:
/// - post refused: the message never got through (privilege filtering);
/// - ack timeout: the message got through, the owner never confirmed a result;
/// - no window: the owner exists but exposes no restore listener (yet).
fn signal_owner(hwnd: HWND) -> SignalOutcome {
    let capable = ack_capable_owner();
    // Zero means "no ack expected": the owner only acknowledges real tokens.
    let token = if capable { new_restore_token() } else { 0 };
    let posted =
        unsafe { PostMessageW(Some(hwnd), WM_APP_RESTORE, WPARAM(token as usize), LPARAM(0)) };
    if let Err(e) = posted {
        return SignalOutcome::SignalingFailed(format!(
            "Windows refused the restore notification ({e}). This happens when the \
             running MKMN was started with administrator rights while this launch was \
             ordinary: Windows blocks the request from a lower privilege level. Restore \
             MKMN from the running instance's own tray icon, close it from that tray, or \
             end the elevated MKMN.exe in Task Manager"
        ));
    }
    if !capable {
        return SignalOutcome::Signaled;
    }

    match wait_for_restore_outcome(token, ACK_TIMEOUT) {
        AckOutcome::Confirmed => SignalOutcome::Signaled,
        AckOutcome::Failed => SignalOutcome::SignalingFailed("the running MKMN accepted the restore request but could not bring its \
             window up (the reason is in its log, %LOCALAPPDATA%\\MKMN\\Logs\\mkmn.log). \
             Quit MKMN from its tray icon and start it again".to_string()),
        AckOutcome::NeverCreated => SignalOutcome::Unconfirmed(format!(
            "the running instance accepted the restore request but never created its \
             acknowledgement (token {token:08x}); it may be hung or shutting down"
        )),
        AckOutcome::Unconfirmed => SignalOutcome::Unconfirmed(format!(
            "the running instance accepted the restore request but did not confirm \
             restoring its window within {} s; it may be busy, hung, or shutting down. \
             Its tray icon may still bring the window up; if nothing appears, quit MKMN \
             from that tray icon and start it again",
            ACK_TIMEOUT.as_secs()
        )),
    }
}

/// Outcome of waiting for the owner's acknowledgement.
enum AckOutcome {
    /// The owner signalled the token's ack event: the window is up.
    Confirmed,
    /// The owner reported that the restore FAILED (the failure event exists).
    Failed,
    /// No outcome event ever appeared.
    NeverCreated,
    /// The ack event existed but was never signalled within the budget.
    Unconfirmed,
}

/// Wait — bounded — for the owner's verdict on a restore request. The events are
/// created BY THE OWNER (named for the token the requester posted), which keeps
/// the wait correct in both privilege directions: waiting on another process's
/// event is a read-like access that Windows permits regardless of which side is
/// elevated, while a sender-created event could be unwritable by an elevated
/// owner. The ack event means SUCCESS; the failure event means the owner tried
/// and could not. An owner signals at most one of them (it acknowledges only a
/// restore that succeeded, and reports failure only after giving up), so the
/// ack is checked first: a signalled ack is final, and a failure is observed as
/// soon as it appears while no ack exists.
fn wait_for_restore_outcome(token: u32, timeout: Duration) -> AckOutcome {
    let ack_name = wide(&ack_event_name(token));
    let fail_name = wide(&restore_failure_event_name(token));
    let deadline = Instant::now() + timeout;
    loop {
        match unsafe {
            OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(ack_name.as_ptr()))
        } {
            Ok(handle) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                let waited =
                    unsafe { WaitForSingleObject(handle, remaining.as_millis() as u32) };
                unsafe { let _ = CloseHandle(handle); }
                return match waited {
                    WAIT_OBJECT_0 => AckOutcome::Confirmed,
                    _ => AckOutcome::Unconfirmed,
                };
            }
            Err(_) => {
                // No ack event yet: has the owner reported a failure instead?
                if let Ok(handle) = unsafe {
                    OpenEventW(SYNCHRONIZATION_SYNCHRONIZE, false, PCWSTR(fail_name.as_ptr()))
                } {
                    let state = unsafe { WaitForSingleObject(handle, 0) };
                    unsafe { let _ = CloseHandle(handle); }
                    if state == WAIT_OBJECT_0 {
                        return AckOutcome::Failed;
                    }
                }
                if Instant::now() >= deadline {
                    return AckOutcome::NeverCreated;
                }
                std::thread::sleep(ACK_OPEN_INTERVAL);
            }
        }
    }
}

/// The ack token rides in the message's WPARAM as a plain unsigned value.
fn restore_token_from_wparam(wparam: WPARAM) -> u32 {
    wparam.0 as u32
}

/// A visible, actionable error for a recovery failure — never a silent exit.
fn show_recovery_error(reason: &str) {
    let title = wide("MKMN is already running");
    let text_wide = wide(&format!("MKMN is already running, but its window could not be restored.\n\n{reason}"));
    unsafe {
        MessageBoxW(
            None,
            PCWSTR(text_wide.as_ptr()),
            PCWSTR(title.as_ptr()),
            MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

/// Starts the message-only restore listener for the OWNING instance. The window
/// lives on its own thread with its own message loop; Tauri window calls made from
/// there are dispatched to the main thread by Tauri itself.
pub fn start_restore_listener(app: AppHandle) {
    // Register the handle BEFORE the window exists, so a restore message that
    // arrives in the first milliseconds is never lost to an unset handle.
    let _ = LISTENER_APP.set(app);
    std::thread::Builder::new()
        .name("mkmn-single-instance".into())
        .spawn(run_restore_listener)
        .map_err(|e| {
            crate::paths::startup_log(
                "instance-restore-listener",
                &format!("could not start listener thread: {e}"),
            )
        })
        .ok();
}

fn run_restore_listener() {
    let class_name = restore_window_class();
    let class_w = wide(&class_name);
    let hinstance = match unsafe { windows::Win32::System::LibraryLoader::GetModuleHandleW(None) } {
        Ok(h) => h,
        Err(e) => {
            crate::paths::startup_log(
                "instance-restore-listener",
                &format!("GetModuleHandleW failed: {e}"),
            );
            return;
        }
    };
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(restore_wndproc),
        hInstance: hinstance.into(),
        lpszClassName: PCWSTR(class_w.as_ptr()),
        ..Default::default()
    };
    let atom = unsafe { RegisterClassExW(&wc) };
    if atom == 0 {
        crate::paths::startup_log(
            "instance-restore-listener",
            &format!("RegisterClassExW({class_name}) failed: {}", last_win32_error()),
        );
        return;
    }

    // A message-only window: never appears on screen, in the taskbar, or in any
    // window enumeration of top-level windows. Only FindWindowEx(HWND_MESSAGE, …)
    // can find it.
    let hwnd = unsafe {
        CreateWindowExW(
            WINDOW_EX_STYLE::default(),
            PCWSTR(class_w.as_ptr()),
            PCWSTR::null(),
            WINDOW_STYLE(0),
            0,
            0,
            0,
            0,
            Some(HWND_MESSAGE),
            None,
            Some(hinstance.into()),
            None,
        )
    };
    let hwnd = match hwnd {
        Ok(h) => h,
        Err(e) => {
            crate::paths::startup_log(
                "instance-restore-listener",
                &format!("could not create the restore window: {e}"),
            );
            return;
        }
    };
    crate::paths::startup_log(
        "instance-restore-listener",
        &format!("listening on class {class_name}"),
    );

    // Two things an owner must publish before it can receive restore requests
    // from a LOWER privilege level (an elevated owner otherwise rejects the
    // request with "access denied"):
    //
    // 1. A message filter exception for exactly one message — this window, this
    //    message. Windows' default filter blocks posts from lower-integrity
    //    processes; this opens a single narrow hole instead of relaxing anything
    //    globally.
    // 2. An existence marker telling second launches this owner acknowledges
    //    restore requests (they only wait for an ack when they can see it).
    if let Err(e) =
        unsafe { ChangeWindowMessageFilterEx(hwnd, WM_APP_RESTORE, MSGFLT_ALLOW, None) }
    {
        crate::paths::startup_log(
            "instance-restore-listener",
            &format!(
                "could not allow the restore message from lower-privilege launches: {e}; \
                 an elevated instance will not be restorable from an ordinary launch"
            ),
        );
    }
    match unsafe {
        CreateEventW(None, true, false, PCWSTR(wide(&ack_supported_event_name()).as_ptr()))
    } {
        Ok(handle) => keep_event_handle_open(handle),
        Err(e) => crate::paths::startup_log(
            "instance-restore-listener",
            &format!("could not create the ack-support marker: {e}; second launches will \
                      not wait for restore confirmations"),
        ),
    }

    let mut msg = MSG::default();
    loop {
        match unsafe { GetMessageW(&mut msg, Some(hwnd), 0, 0) } {
            // WM_QUIT: exit the loop (the process is going away anyway).
            r if !r.as_bool() => break,
            _ => {
                let _ = unsafe { TranslateMessage(&msg) };
                unsafe { DispatchMessageW(&msg) };
            }
        }
    }
}

unsafe extern "system" fn restore_wndproc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if msg == WM_APP_RESTORE {
        // Second-instance launch: bring the main window up. The AppHandle is not
        // carried through the message (there is nothing to marshal); it was
        // registered by `start_restore_listener` before the window existed.
        // SAFETY: the static is set exactly once, before the window is created, and
        // never changed afterwards.
        let token = restore_token_from_wparam(wparam);
        match LISTENER_APP.get() {
            Some(app) => restore_with_retry(app, token),
            None => {
                crate::paths::append_log(
                    "mkmn",
                    "[single-instance] restore requested but no app handle is registered",
                );
            }
        }
        // A zero token is a legacy request (or an ack-incapable launch): it waits
        // for nothing, so nothing is signalled back to it. A real token was
        // acknowledged (or honestly failed) inside `restore_with_retry`.
        LRESULT(0)
    } else if msg == WM_DESTROY {
        unsafe { PostQuitMessage(0) };
        LRESULT(0)
    } else {
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }
}

use std::sync::OnceLock;
static LISTENER_APP: OnceLock<AppHandle> = OnceLock::new();

/// The owner's restore path, with bounded retries: a request can arrive while this
/// instance is between mutex acquisition and its main window existing (a launch
/// double-clicked in the same second), or while a transient condition makes the
/// window refuse to come up. Retrying inside the OWNER — the process that owns the
/// window — is the honest place to absorb that race; the requesting launch is kept
/// waiting only within its `ACK_TIMEOUT` budget.
///
/// Success acknowledges the token; running out of budget reports the failure to the
/// requesting launch instead of letting it assume the window appeared. A zero token
/// (a legacy or ack-incapable requester) is restored the same way but signalled
/// nothing.
fn restore_with_retry(app: &AppHandle, token: u32) {
    let deadline = Instant::now() + RESTORE_RETRY_BUDGET;
    loop {
        match crate::tray::show_main_window(app) {
            Ok(()) => {
                if token != 0 {
                    acknowledge_restore(token);
                }
                return;
            }
            Err(reason) => {
                if Instant::now() >= deadline {
                    crate::paths::append_log(
                        "mkmn",
                        &format!(
                            "[single-instance] restore still failing after {} ms of \
                             retries: {reason}",
                            RESTORE_RETRY_BUDGET.as_millis()
                        ),
                    );
                    if token != 0 {
                        report_restore_failure(token);
                    }
                    return;
                }
                std::thread::sleep(RETRY_INTERVAL);
            }
        }
    }
}

/// True when this process holds a full administrator token; None when Windows would not say.
fn token_is_elevated() -> Option<bool> {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::Security::{
        GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY,
    };
    use windows::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};
    unsafe {
        let mut token = HANDLE::default();
        if OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).is_err() {
            return None;
        }
        let mut elevation = TOKEN_ELEVATION::default();
        let mut returned = 0u32;
        let ok = GetTokenInformation(
            token,
            TokenElevation,
            Some(&mut elevation as *mut _ as *mut _),
            std::mem::size_of::<TOKEN_ELEVATION>() as u32,
            &mut returned,
        );
        let _ = CloseHandle(token);
        if ok.is_err() {
            return None;
        }
        Some(elevation.TokenIsElevated != 0)
    }
}

/// Hands an elevated launch to the unelevated shell BEFORE the instance lock, the job
/// object or any sidecar exists, then asks the caller to exit. Explorer runs the target
/// with the user's normal token, which is the only way an elevated process (started by
/// an installer or an elevated shortcut) can hand itself back down. The child carries a
/// one-shot guard in its environment, so a relaunch can never loop.
///
/// Returns true when a relaunch was started: the caller must exit immediately.
pub fn ensure_unelevated_launch() -> bool {
    if std::env::var_os("MKMN_UNELEVATED_RETRY").is_some() {
        crate::paths::startup_log(
            "elevation",
            "this MKMN process carries the one-shot unelevated-retry guard; continuing \
             instead of handing itself to Explorer again",
        );
        return false;
    }
    match token_is_elevated() {
        Some(true) => {}
        Some(false) => return false,
        None => {
            crate::paths::startup_log(
                "elevation",
                "the process token could not be read; assuming a normal launch and \
                 continuing (no relaunch is attempted)",
            );
            return false;
        }
    }
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            crate::paths::startup_log(
                "elevation",
                &format!("elevated launch could not find its own path, so it continues elevated: {e}"),
            );
            return false;
        }
    };
    let mut cmd = std::process::Command::new("explorer.exe");
    cmd.arg(&exe);
    for a in std::env::args_os().skip(1) {
        cmd.arg(a);
    }
    cmd.env("MKMN_UNELEVATED_RETRY", "1");
    cmd.env("MKMN_UNELEVATED_FROM", std::process::id().to_string());
    match cmd.spawn() {
        Ok(child) => {
            crate::paths::startup_log(
                "elevation",
                &format!(
                    "this launch runs with ADMINISTRATOR rights; handing it to Explorer \
                     (pid {}) for an ordinary, unelevated instance and exiting: {}",
                    child.id(),
                    exe.display()
                ),
            );
            true
        }
        Err(e) => {
            crate::paths::startup_log(
                "elevation",
                &format!(
                    "this launch runs with ADMINISTRATOR rights; the unelevated relaunch \
                     through Explorer failed ({e}), so it continues elevated"
                ),
            );
            false
        }
    }
}

/// Logs an elevated instance that had to continue: MKMN never needs elevation, and an
/// elevated instance was once why an ordinary relaunch could not reach the running window
/// (Windows' privilege filtering, the 0x80070005 dialog). Never a silent surprise.
pub fn log_if_elevated() {
    if token_is_elevated() == Some(true) {
        crate::paths::startup_log(
            "elevation",
            "this MKMN instance runs with ADMINISTRATOR rights; MKMN does not need \
             them. It was most likely started by an elevated installer or shortcut. \
             Ordinary (non-elevated) launches can still reach this instance through \
             the restore-message exception, but MKMN should normally run unelevated",
        );
    }
}

fn last_win32_error() -> String {
    let code = unsafe { GetLastError() };
    format!("Win32 error {}", code.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The dev and installed flavors must never share instance state: distinct mutex
    /// names and distinct restore-window classes. The suffix rule is what keeps a
    /// `tauri dev` run from ever touching the installed app's instance state.
    #[test]
    fn dev_and_installed_scopes_differ() {
        // The test binary runs with debug_assertions (the Development flavor), so the
        // current names carry the dev suffix.
        if cfg!(debug_assertions) {
            assert_eq!(instance_mutex_name(), "Local\\app.mkmn.desktop.single-instance-dev");
            assert_eq!(restore_window_class(), "MKMN_SingleInstance-dev");
        } else {
            assert_eq!(instance_mutex_name(), "Local\\app.mkmn.desktop.single-instance");
            assert_eq!(restore_window_class(), "MKMN_SingleInstance");
        }
        // Either way, the scope is session-local and MKMN-specific.
        assert!(instance_mutex_name().starts_with("Local\\"));
        assert!(instance_mutex_name().contains("app.mkmn.desktop"));
    }

    /// The restore message is a WM_APP-range message: UIPI-safe to define, and
    /// distinct from any system message.
    #[test]
    fn restore_message_is_in_the_app_range() {
        const { assert!(WM_APP_RESTORE >= WM_APP && WM_APP_RESTORE < WM_APP + 0x2000) }
        assert_eq!(WM_APP_RESTORE, 0x8001);
    }

    /// A wide-string helper must produce NUL-terminated UTF-16.
    #[test]
    fn wide_strings_are_nul_terminated() {
        let w = wide("abc");
        assert_eq!(w, vec![b'a' as u16, b'b' as u16, b'c' as u16, 0]);
    }

    /// Real cross-process check with a FOREIGN process holding the mutex: while a
    /// live process owns the name, acquisition must report AlreadyRunning; after the
    /// owner dies (stale ownership), a fresh launch must acquire cleanly.
    #[test]
    fn a_live_foreign_owner_blocks_and_a_dead_one_releases() {
        use std::process::{Command, Stdio};
        let name = format!("Local\\mkmn-single-instance-test-{}", std::process::id());
        // PowerShell single-quoted strings have no backslash escapes: the name is
        // passed through byte-for-byte so the holder and this test use the SAME
        // kernel object.
        let script = format!(
            "$m=[System.Threading.Mutex]::new($true,'{name}'); [Console]::Out.WriteLine('held'); Start-Sleep -Seconds 30"
        );
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .stdout(Stdio::piped())
            .spawn()
            .expect("spawn mutex holder");
        // Wait until the holder actually created the mutex.
        let mut buf = [0u8; 16];
        use std::io::Read;
        let _ = child.stdout.as_mut().expect("stdout").read(&mut buf);

        match try_create_mutex(&name) {
            MutexAttempt::Exists => {} // correct: a live owner blocks
            other => panic!("expected the live foreign owner to block, got {other:?}"),
        }

        // Stale ownership: kill the holder; the kernel releases the mutex.
        let pid = child.id();
        let _ = child.kill();
        let _ = child.wait();
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        // Give the kernel a moment to tear the object down.
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match try_create_mutex(&name) {
                MutexAttempt::Created(_) => break, // acquired after the owner died
                _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(200)),
                other => panic!("expected to acquire after the owner died, got {other:?}"),
            }
        }
    }

    /// Ack names are session-local, app-specific, and carry the token so two
    /// concurrent restore requests can never observe each other's confirmation.
    #[test]
    fn ack_event_names_carry_the_token_and_scope() {
        let a = ack_event_name(0x1234abcd);
        let b = ack_event_name(0xcafe0001);
        assert!(a.starts_with("Local\\app.mkmn.desktop.restore-ack-"));
        assert!(a.contains("1234abcd"));
        assert_ne!(a, b);
        // The dev suffix rule applies here too (see dev_and_installed_scopes_differ).
        if cfg!(debug_assertions) {
            assert!(a.ends_with("-dev"));
        } else {
            assert!(!a.ends_with("-dev"));
        }
    }

    /// The ack-support marker is session-local and flavor-scoped, exactly like
    /// the mutex and window class.
    #[test]
    fn ack_support_marker_is_session_local_and_scoped() {
        let name = ack_supported_event_name();
        assert!(name.starts_with("Local\\app.mkmn.desktop.restore-ack-supported"));
        assert_eq!(name.ends_with("-dev"), cfg!(debug_assertions));
    }

    /// Tokens must be nonzero (zero is the legacy "no ack" marker) and should
    /// vary between calls so concurrent requests do not share an ack event.
    #[test]
    fn restore_tokens_are_nonzero_and_vary() {
        let a = new_restore_token();
        let b = new_restore_token();
        assert_ne!(a, 0);
        assert_ne!(b, 0);
        assert_ne!(a, b, "two tokens from the same process must differ");
    }

    /// The token arrives in WPARAM; zero must stay zero so the owner never
    /// acknowledges a legacy request that carries no ack event name.
    #[test]
    fn zero_wparam_means_no_acknowledgement() {
        assert_eq!(restore_token_from_wparam(WPARAM(0)), 0);
        assert_eq!(restore_token_from_wparam(WPARAM(0x9abc_def0)), 0x9abc_def0);
        // A wider value (never produced by the requester, but tolerated) truncates
        // rather than panics.
        assert_eq!(restore_token_from_wparam(WPARAM(usize::MAX)), u32::MAX);
    }

    /// Real cross-process ack round trip: a signal created by ANOTHER thread
    /// (standing in for the owner) is observed by the bounded waiter.
    #[test]
    fn a_signalled_ack_event_is_observed_by_the_waiter() {
        let token = new_restore_token();
        let name = ack_event_name(token);
        let name_w = wide(&name);
        let creator = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            let handle = unsafe {
                CreateEventW(None, true, true, PCWSTR(name_w.as_ptr()))
                    .expect("ack event creation in test")
            };
            // Manual-reset + already signalled: the waiter observes it whenever it
            // gets around to opening. Keep the handle open for the thread's
            // lifetime so the object is not destroyed before the waiter opens it.
            std::thread::sleep(Duration::from_millis(2_000));
            unsafe { let _ = CloseHandle(handle); }
        });
        assert!(
            matches!(
                wait_for_restore_outcome(token, Duration::from_secs(5)),
                AckOutcome::Confirmed
            ),
            "a signalled ack event must be observed as Confirmed"
        );
        creator.join().expect("creator thread");
    }

    /// The owner's honest-failure signal: when it reports that the restore FAILED
    /// (only the failure event exists), the requester must observe Failed — never a
    /// silent success and never a generic "unconfirmed".
    #[test]
    fn a_reported_restore_failure_is_observed_as_failed() {
        let token = new_restore_token();
        let name = restore_failure_event_name(token);
        let name_w = wide(&name);
        let creator = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            // Exactly what report_restore_failure does: manual-reset, signalled.
            let handle = unsafe {
                CreateEventW(None, true, true, PCWSTR(name_w.as_ptr()))
                    .expect("failure event creation in test")
            };
            std::thread::sleep(Duration::from_millis(2_000));
            unsafe { let _ = CloseHandle(handle); }
        });
        assert!(
            matches!(
                wait_for_restore_outcome(token, Duration::from_secs(5)),
                AckOutcome::Failed
            ),
            "an owner-reported failure must be observed as Failed"
        );
        creator.join().expect("creator thread");
    }

    /// Both events existing (a crashed or restarted owner left debris): a signalled
    /// ack is the stronger, final success verdict.
    #[test]
    fn a_signalled_ack_wins_over_leftover_failure_debris() {
        let token = new_restore_token();
        for name in [ack_event_name(token), restore_failure_event_name(token)] {
            let handle = unsafe {
                CreateEventW(None, true, true, PCWSTR(wide(&name).as_ptr()))
                    .expect("event creation in test")
            };
            keep_event_handle_open(handle);
        }
        assert!(matches!(
            wait_for_restore_outcome(token, Duration::from_millis(500)),
            AckOutcome::Confirmed
        ));
    }

    /// A token whose outcome events are never created must time out bounded — this
    /// is exactly what a hung owner produces, and it must never block a launch.
    #[test]
    fn a_never_created_ack_times_out_bounded() {
        let started = Instant::now();
        let outcome = wait_for_restore_outcome(new_restore_token(), Duration::from_millis(300));
        assert!(matches!(outcome, AckOutcome::NeverCreated));
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "the wait must respect its budget, took {:?}",
            started.elapsed()
        );
    }

    /// The failure event is namespaced and token-scoped exactly like the ack event,
    /// so two concurrent restores can never observe each other's verdict, and the
    /// two outcomes can never be the same object.
    #[test]
    fn failure_and_ack_events_are_distinct_and_scoped() {
        let token = new_restore_token();
        let ack = ack_event_name(token);
        let fail = restore_failure_event_name(token);
        assert_ne!(ack, fail);
        assert!(fail.starts_with("Local\\app.mkmn.desktop.restore-failed-"));
        assert!(fail.contains(&format!("{token:08x}")));
        assert_eq!(fail.ends_with("-dev"), cfg!(debug_assertions));
        assert_ne!(
            restore_failure_event_name(0x1234abcd),
            restore_failure_event_name(0xcafe0001)
        );
    }

    /// Simultaneous launches racing for a free lock: exactly ONE may win ownership;
    /// every loser must see the lock as taken (and go on to signal the winner).
    #[test]
    fn simultaneous_launches_elect_exactly_one_owner() {
        let name = format!("Local\\mkmn-single-instance-race-{}", std::process::id());
        let mut handles = Vec::new();
        for _ in 0..8 {
            let n = name.clone();
            handles.push(std::thread::spawn(move || {
                (0..50).find_map(|_| match try_create_mutex(&n) {
                    // HANDLE is not Send: keep only its numeric value here; a won
                    // handle simply leaks for the test's lifetime, which is what
                    // keeps the named object alive for the losers.
                    MutexAttempt::Created(h) => Some(h.0 as isize),
                    MutexAttempt::Exists => None,
                    MutexAttempt::Failed(e) => panic!("mutex attempt failed: {e}"),
                })
            }));
        }
        let winners: Vec<_> = handles
            .into_iter()
            .filter_map(|h| h.join().expect("racer thread"))
            .collect();
        assert_eq!(
            winners.len(),
            1,
            "exactly one racer may acquire the instance lock"
        );
        // The winner's handle stays open; the named object must now exist for a
        // newcomer (a late loser sees Exists, never Created).
        assert!(matches!(try_create_mutex(&name), MutexAttempt::Exists));
    }

    /// The requester's patience must outlast the owner's retry budget, so an owner
    /// that is about to succeed (or about to report an honest failure) is always
    /// heard before the requester gives up.
    #[test]
    fn the_requester_outlasts_the_owner_retry_budget() {
        assert!(
            ACK_TIMEOUT > RESTORE_RETRY_BUDGET + Duration::from_secs(2),
            "ack timeout {:?} must exceed the owner's retry budget {:?} with margin",
            ACK_TIMEOUT,
            RESTORE_RETRY_BUDGET
        );
    }
}
