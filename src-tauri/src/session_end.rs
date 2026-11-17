//! Windows session end: logoff, shutdown and Restart Manager.
//!
//! tao 0.37 processes `WM_ENDSESSION` only on its internal message-only window
//! ("Tao Thread Event Target", event_loop.rs ~line 2340) — but Windows
//! broadcasts session-end messages to TOP-LEVEL windows only, and never to a
//! message-only window. The main window's own procedure does not handle
//! `WM_ENDSESSION` at all, so without this module a Windows logoff/shutdown
//! would let the system force-terminate the host after its grace period,
//! skipping the coordinated shutdown (sidecar, model server, descendants).
//!
//! This module subclasses the main window (`SetWindowSubclass`, same thread
//! ownership rules as tao) and reacts to `WM_ENDSESSION(wParam != 0)` by
//! running the ONE coordinated shutdown, then exiting the process — the same
//! behavior tao itself uses for the (unreachable) handler it ships.
//!
//! `WM_QUERYENDSESSION` needs no interception: tao ignores it and
//! `DefWindowProc` answers TRUE, so the session may end. We deliberately do
//! NOT shut down on `WM_QUERYENDSESSION`: the user can still cancel the
//! logoff at that point, and `WM_ENDSESSION(wParam != 0)` is the only
//! reliable "the session IS ending" signal (it also covers the Restart
//! Manager, which never sends the query).

use std::sync::OnceLock;

use tauri::AppHandle;
use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::UI::Shell::{DefSubclassProc, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::WM_ENDSESSION;

/// Arbitrary but stable subclass id for this module (never reused elsewhere).
const SUBCLASS_ID: usize = 0x0000_4D4B_4D4E; // "MKMN"

/// The one installed handler. Set once at setup; never swapped (the main
/// window exists for the whole process lifetime).
static HANDLER: OnceLock<Box<dyn Fn() + Send + Sync>> = OnceLock::new();

/// Subclasses the main window so session end runs the coordinated shutdown.
/// Must be called on the main thread (the window's owner) — Tauri's `setup`
/// hook guarantees that. Failing to install is logged but not fatal: the job
/// object still reaps every descendant when the system terminates the process.
pub fn install(app: &AppHandle, hwnd: HWND) -> Result<(), &'static str> {
    let app = app.clone();
    let handler: Box<dyn Fn() + Send + Sync> = Box::new(move || {
        crate::paths::append_log(
            "mkmn",
            "[session_end] WM_ENDSESSION received; running the coordinated shutdown",
        );
        // The process has ~5 seconds before Windows terminates it; the
        // coordinated shutdown is bounded well below that.
        tauri::async_runtime::block_on(crate::shutdown::run(&app));
        crate::paths::append_log(
            "mkmn",
            "[session_end] coordinated shutdown finished; exiting before the session closes",
        );
        std::process::exit(0);
    });
    install_with_handler(hwnd, handler)
}

/// Testable core: installs `handler` for `WM_ENDSESSION(wParam != 0)` on
/// `hwnd`. Must run on the thread that owns the window.
fn install_with_handler(
    hwnd: HWND,
    handler: Box<dyn Fn() + Send + Sync>,
) -> Result<(), &'static str> {
    HANDLER
        .set(handler)
        .map_err(|_| "session-end handler already installed")?;
    let ok = unsafe { SetWindowSubclass(hwnd, Some(session_end_proc), SUBCLASS_ID, 0) }.as_bool();
    if ok {
        Ok(())
    } else {
        Err("SetWindowSubclass failed")
    }
}

/// Does this message+wParam mean "the session IS ending, act now"?
fn is_session_ending(msg: u32, wparam: WPARAM) -> bool {
    msg == WM_ENDSESSION && wparam.0 != 0
}

unsafe extern "system" fn session_end_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _uidsubclass: usize,
    _dwrefdata: usize,
) -> LRESULT {
    if is_session_ending(msg, wparam)
        && let Some(handler) = HANDLER.get() {
            handler();
            // The production handler exits the process; if a test handler
            // returns, claim the session end was handled so the default
            // procedure does nothing further.
            return LRESULT(0);
        }
    // Everything else — including WM_QUERYENDSESSION and the wParam == 0
    // (session end cancelled) case — is not ours.
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::{Duration, Instant};

    use windows::Win32::Foundation::HINSTANCE;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostMessageW,
        RegisterClassExW, TranslateMessage, DestroyWindow, MSG, WINDOW_EX_STYLE, WINDOW_STYLE,
        WM_CLOSE, WM_ENDSESSION, WNDCLASSEXW,
    };

    fn is_session_ending_values() -> [(u32, usize, bool); 4] {
        [
            (WM_ENDSESSION, 1, true),  // session IS ending
            (WM_ENDSESSION, 0, false), // session end cancelled
            (0x0011, 1, false),        // WM_QUERYENDSESSION: not ours
            (WM_CLOSE, 0, false),      // unrelated
        ]
    }

    #[test]
    fn only_a_true_endsession_counts() {
        for (msg, wparam, expected) in is_session_ending_values() {
            assert_eq!(
                is_session_ending(msg, WPARAM(wparam)),
                expected,
                "msg=0x{msg:04X} wparam={wparam}"
            );
        }
    }

    #[test]
    fn wm_endsession_reaches_the_subclass_handler_on_a_top_level_window() {
        // This mirrors the production path exactly: a top-level window owned by
        // the calling thread, subclassed by install_with_handler, messaged with
        // WM_ENDSESSION — what Windows broadcasts at logoff/shutdown.
        static CALLED: AtomicBool = AtomicBool::new(false);

        unsafe {
            let hmodule = GetModuleHandleW(None).expect("module handle");
            let hinstance = HINSTANCE(hmodule.0);

            unsafe extern "system" fn test_wndproc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // The body of an `unsafe extern` fn is safe-by-default in edition 2024, and
        // forwarding to the default window procedure is exactly the unsafe call here.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    let class_name = windows::core::w!("mkmn_session_end_test");
            let wc = WNDCLASSEXW {
                cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                lpfnWndProc: Some(test_wndproc),
                hInstance: hinstance,
                lpszClassName: class_name,
                ..Default::default()
            };
            RegisterClassExW(&wc);

            let hwnd = CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                class_name,
                windows::core::w!("mkmn session end test"),
                WINDOW_STYLE(0), // hidden top-level window: still gets session-end broadcasts
                0,
                0,
                64,
                64,
                None,
                None,
                Some(hinstance),
                None,
            )
            .expect("test window");

            install_with_handler(
                hwnd,
                Box::new(|| CALLED.store(true, Ordering::SeqCst)),
            )
            .expect("subclass install");

            // Broadcast what Windows sends: ENDSESSION with wParam = TRUE.
            let posted = PostMessageW(Some(hwnd), WM_ENDSESSION, WPARAM(1), LPARAM(0));
            assert!(posted.is_ok(), "PostMessage WM_ENDSESSION failed");

            // Pump this thread's queue until the flag flips (bounded).
            let deadline = Instant::now() + Duration::from_secs(5);
            while !CALLED.load(Ordering::SeqCst) && Instant::now() < deadline {
                let mut msg = MSG::default();
                if GetMessageW(&mut msg, Some(hwnd), 0, 0).as_bool() {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }
            let _ = DestroyWindow(hwnd);
        }

        assert!(
            CALLED.load(Ordering::SeqCst),
            "the WM_ENDSESSION subclass handler never ran"
        );
    }
}
