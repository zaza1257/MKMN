use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, SW_SHOW,
    SW_RESTORE,
};

/// Restore the main window from the tray, from a second-instance launch signal, or
/// from anywhere else that must bring MKMN back up. Every failure is LOGGED with an
/// actionable message — a failed restore must never silently accumulate a
/// background process (the incident) — and RETURNED, so a second launch
/// waiting for an acknowledgement is told the truth instead of being told the
/// window came up when it did not.
pub fn show_main_window(app: &AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        let reason = "the main window does not exist in this instance (it may still be \
             starting); MKMN kept running in the background. If no window ever \
             appears, quit MKMN from its tray icon and start it again."
            .to_string();
        crate::paths::append_log("mkmn", &format!("[restore] FAILED: {reason}"));
        return Err(reason);
    };
    let mut failures: Vec<String> = Vec::new();
    if let Err(e) = window.show() {
        failures.push(format!("show failed: {e}"));
    }
    if let Err(e) = window.unminimize() {
        failures.push(format!("unminimize failed: {e}"));
    }
    if let Err(e) = window.set_focus() {
        failures.push(format!("set_focus failed: {e}"));
    }
    // When the restore comes from another process, Windows may deny the focus
    // change (a background process cannot always take foreground). The window is
    // up either way: flash its taskbar entry so the restore is still discoverable.
    match window.is_focused() {
        Ok(false) => {
            if let Err(e) =
                window.request_user_attention(Some(tauri::UserAttentionType::Critical))
            {
                failures.push(format!("request_user_attention failed: {e}"));
            }
        }
        Ok(true) => {}
        Err(_) => {} // focus state unknown; the focus attempt above already ran
    }
    // Enforcement that does not trust Tauri's cached window state: a window that
    // was hidden or minimized by anything outside Tauri's bookkeeping (a manual
    // hide, a shell-level action, a crashed state) would stay invisible after a
    // `show()` that Tauri optimizes away. The raw calls below are the honest
    // last mile: restore if minimized, show if not visible, and take foreground
    // when Windows allows it — a restore coming from another process may be
    // denied the foreground, which the attention request above already covers.
    if let Ok(hwnd) = window.hwnd() {
        unsafe {
            // ShowWindow's return value reports the PREVIOUS state, not success,
            // so each step verifies the state after the call.
            if IsIconic(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_RESTORE);
                if IsIconic(hwnd).as_bool() {
                    failures.push("the window is still minimized after a restore call".to_string());
                }
            }
            if !IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_SHOW);
                if !IsWindowVisible(hwnd).as_bool() {
                    failures.push("the window is still hidden after a show call".to_string());
                }
            }
            if GetForegroundWindow() != hwnd {
                // Best effort: a background process cannot always take foreground.
                // Failure is fine — the window is visible and attention was
                // requested; no error is reported to the user for this.
                let _ = SetForegroundWindow(hwnd);
            }
        }
    }
    if failures.is_empty() {
        crate::monitor::set_window_minimized_or_hidden(false);
        crate::paths::append_log("mkmn", "[restore] main window shown and focused");
        Ok(())
    } else {
        let joined = failures.join("; ");
        crate::paths::append_log(
            "mkmn",
            &format!("[restore] FAILED: {joined} — the window may be stuck; quitting MKMN from its tray icon and starting it again recovers"),
        );
        Err(joined)
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let show_i = MenuItem::with_id(app, "show", "Show MKMN AI", true, None::<&str>)?;
    // Neutral pointer, not a status claim: this tray menu does not subscribe to
    // runtime state, and a permanent "Ready" would be false when the runtime is
    // stopped, starting or failed. The app window shows the live status.
    let status_i = MenuItem::with_id(app, "status", "Runtime status is shown in the app", false, None::<&str>)?;
    let restart_i = MenuItem::with_id(app, "restart", "Restart Runtime", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit MKMN", true, None::<&str>)?;

    let menu = Menu::with_items(app, &[&show_i, &status_i, &restart_i, &quit_i])?;

    // The dedicated tray artwork: thicker rings, tile-backed, drawn to stay legible
    // at 16-32 px on both light and dark taskbars (see scripts/generate-brand-assets.mjs).
    // NOT the default window icon, and never a fallback guess.
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png"))?;

    let _tray = TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("MKMN AI — Private AI, powered by your PC")
        .on_menu_event(|app, event| {
            match event.id().as_ref() {
                "show" => {
                    // The tray path logs its own failures inside; nothing waits on
                    // the result here.
                    let _ = show_main_window(app);
                }
                "restart" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Some(host) = app.try_state::<crate::sidecar::SidecarHost>() {
                            let supervisor = app.state::<crate::supervisor::GenieXSupervisor>();
                            let generation = supervisor.cancel_generation().await;
                            if let Err(e) = host.call("restartGeniexModel", serde_json::json!([generation])).await {
                                crate::paths::append_log("mkmn", &format!("[tray] Restart failed: {}", e));
                            }
                        }
                    });
                }
                "quit" => {
                    // The tray Quit runs the ONE coordinated shutdown (sidecar,
                    // server, benchmark, remaining descendants) and exits through
                    // the normal run loop — never std::process::exit, which would
                    // skip Tauri's own cleanup and the Exit-event sequencing.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        crate::shutdown::run(&app).await;
                        app.exit(0);
                    });
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                // Same as the menu Show: failures are logged inside.
                let _ = show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}
