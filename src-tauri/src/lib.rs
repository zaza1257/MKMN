pub mod accelerators;
pub mod agent_driver;
pub mod agent_wire;
pub mod artifact_frame;
pub mod battery;
pub mod bench;
pub mod capabilities;
pub mod commands;
pub mod job_object;
pub mod memory_estimator;
pub mod model_manifest;
pub mod monitor;
pub mod npudiag;
pub mod npu_recovery;
pub mod ocr;
pub mod paths;
pub mod power;
pub mod qairt_runtime;
pub mod qos;
pub mod session_end;
pub mod settings;
pub mod settings_defaults;
pub mod shutdown;
pub mod sidecar;
pub mod single_instance;
pub mod state_machine;
pub mod supervisor;
pub mod system;
pub mod tray;
pub mod window_fit;

use std::sync::Arc;
use std::time::Instant;
use supervisor::GenieXSupervisor;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tokio::sync::RwLock;

/// The artifact preview frame, served on its own origin (the "artifact" scheme below). It carries
/// its own strict CSP, which runs the generated pages' inline scripts and blocks every network
/// request; the app's CSP is deliberately not applied to it (its inline-script hashes never cover
/// the scripts written into the frame at run time, and a data: URL would inherit the app policy).
const ARTIFACT_FRAME_HTML: &str = include_str!("../../src/renderer/public/artifact-frame.html");

/// Creates the main window in code instead of tauri.conf.json. The reason is the
/// WebView2 data directory: an installed build must keep the EXACT default location
/// (its profile holds the installed app's browser storage), while a development
/// build must use its own. That is a per-build decision a static config cannot
/// express — see `paths::webview_data_dir`.
fn create_main_window(
    app: &tauri::AppHandle,
) -> Result<tauri::WebviewWindow, tauri::Error> {
    // The preferred 1280 x 860 and the 800 x 600 minimum are LOGICAL pixels. Against the
    // monitor's WORK AREA (taskbar excluded) at 200 % they used to ask for 2560 x 1720
    // physical pixels on a 1440 x 852 area, so the title bar went under the taskbar.
    let preferred = (1280.0_f64, 860.0_f64);
    let minimum = (800.0_f64, 600.0_f64);

    // Build hidden: the monitor query before a window exists returned nothing on the
    // installed build, so the old logical size was requested again. The window must
    // exist first; `fit_window_to_monitor` then clamps and centres it in physical
    // pixels, and only then is it shown.
    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("MKMN AI")
        .decorations(false)
        .inner_size(preferred.0, preferred.1)
        .min_inner_size(minimum.0, minimum.1)
        .resizable(true)
        .fullscreen(false)
        .visible(false)
        // Explicit in BOTH flavors — pinned, never inherited from a Tauri default
        // that could silently change between versions.
        .data_directory(paths::webview_data_dir())
        .build()?;
    // A generated page's frame may not navigate away from its own page (artifact_frame.rs).
    artifact_frame::install_navigation_guard(&window);
    fit_window_to_monitor(&window, preferred, minimum);
    window.show()?;
    Ok(window)
}

/// Fit the created window to its monitor's work area, in physical pixels, then set the
/// minimum so it never fights the fitted size. The minimum is lowered BEFORE the size:
/// the builder's 800 x 600 logical minimum is 1600 x 1200 physical at 200 % and would
/// clamp the fitted 1392 x 804 window if applied first. The decision is logged; a
/// monitor that cannot be read keeps the old logical size and is centred.
fn fit_window_to_monitor(
    window: &tauri::WebviewWindow,
    preferred: (f64, f64),
    minimum: (f64, f64),
) {
    let monitor = window
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| window.current_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        paths::startup_log(
            "window-fit",
            "no monitor could be read after window creation; keeping 1280x860 logical and centring",
        );
        let _ = window.center();
        return;
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let work = window_fit::Rect::new(
        area.position.x,
        area.position.y,
        area.size.width,
        area.size.height,
    );
    let physical = window_fit::fit_window_to_work_area(
        work,
        (
            (preferred.0 * scale).round() as u32,
            (preferred.1 * scale).round() as u32,
        ),
        (
            (minimum.0 * scale).round() as u32,
            (minimum.1 * scale).round() as u32,
        ),
    );
    let (x, y) = window_fit::centre_in_work_area(work, physical);
    // `Window::set_size` sets the INNER size, while `physical` describes the whole
    // window. Measure the frame the OS added; without this subtraction its resize
    // border would push the outer right/bottom edge past the work area at 200 %.
    let frame = match (window.outer_size(), window.inner_size()) {
        (Ok(outer), Ok(inner)) => (
            outer.width.saturating_sub(inner.width),
            outer.height.saturating_sub(inner.height),
        ),
        _ => (0, 0),
    };
    let inner_size = (
        physical.0.saturating_sub(frame.0).max(1),
        physical.1.saturating_sub(frame.1).max(1),
    );
    // The minimum yields to the work area as well: on a screen smaller than the old
    // 800 x 600 logical minimum, the window must still fit and keep its title bar.
    let min_logical = (
        (inner_size.0 as f64 / scale).min(minimum.0),
        (inner_size.1 as f64 / scale).min(minimum.1),
    );
    if let Err(e) = window.set_min_size(Some(tauri::LogicalSize::new(min_logical.0, min_logical.1))) {
        paths::startup_log("window-fit", &format!("the fitted minimum could not be set ({e})"));
    }
    if let Err(e) = window.set_size(tauri::PhysicalSize::new(inner_size.0, inner_size.1)) {
        paths::startup_log("window-fit", &format!("the fitted size could not be applied ({e})"));
    }
    if let Err(e) = window.set_position(tauri::PhysicalPosition::new(x, y)) {
        paths::startup_log("window-fit", &format!("the fitted position could not be applied ({e})"));
    }
    paths::startup_log(
        "window-fit",
        &format!(
            "monitor {:?} scale {scale}; work {}x{} at ({},{}); window {}x{} outer ({}x{} inner) at ({x},{y}) physical",
            monitor.name(),
            work.width,
            work.height,
            work.x,
            work.y,
            physical.0,
            physical.1,
            inner_size.0,
            inner_size.1
        ),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Startup-stage logging begins here: every stage below records the process
    // identity (pid, version, dev/installed) and elapsed time, so multiple
    // processes' lines in one log file can be told apart and correlated with
    // Windows' own hang reports.
    let t0 = Instant::now();
    paths::startup_log("boot", "MKMN host process starting");

    // Enforce standard Windows Enterprise application directory architecture.
    // Legacy-data migration is OPT-IN (settings: migrateLegacyData) and never runs
    // merely because the app launched.
    paths::init_filesystem();

    // An elevated launch (an installer or an elevated shortcut) hands itself to
    // Explorer for an ordinary instance BEFORE it owns the instance lock, the job
    // object or any sidecar: an elevated owner is exactly what made ordinary
    // relaunches unable to reach the running window. The child carries a one-shot
    // guard, so this can never loop.
    if single_instance::ensure_unelevated_launch() {
        paths::startup_log(
            "exit",
            "elevated launch handed to an unelevated instance through Explorer",
        );
        return;
    }

    // SINGLE-INSTANCE OWNERSHIP — before ANYTHING that can touch browsers, model
    // runtimes, or other instances. A second launch (double-click, shortcut, tray
    // while hidden) signals the running instance to restore its window and exits
    // here without creating a sidecar, a WebView2 environment, or a job object.
    match single_instance::acquire() {
        single_instance::Ownership::Acquired => {
            paths::startup_log("instance-acquired", "this process owns the MKMN instance");
        }
        single_instance::Ownership::AlreadyRunning => {
            paths::startup_log(
                "exit",
                &format!(
                    "exiting after {} ms without starting a second instance (see the \
                     instance-conflict line above)",
                    t0.elapsed().as_millis()
                ),
            );
            return;
        }
    }

    // Enforce process lifecycle boundary: ensure host process and all child processes
    // (WebView2, sidecars) terminate together via Win32 Job Object
    job_object::init_process_lifecycle_guard();

    // An elevated MKMN is never required and was once the reason an ordinary
    // relaunch could not restore the running window; the fact is logged so it can
    // never happen silently again.
    single_instance::log_if_elevated();

    // Clean up any WebView2 processes orphaned by previous crashed sessions. Runs on
    // a background thread; it can only ever terminate webviews whose owning MKMN
    // process is VERIFIED dead — never those of a live instance, never another
    // application's, and never this launch's own.
    std::thread::spawn(system::cleanup_stray_webview_processes);

    // Enforce Tier 1 Interactive state for MKMN host process (MKMN.exe)
    // Priority: NORMAL_PRIORITY_CLASS, EcoQoS Disabled (Unthrottled) for 120Hz UI fluidity
    qos::apply_interactive_tier_to_host();

    let supervisor = GenieXSupervisor::new();
    let supervisor_inner = supervisor.inner();
    let metrics_cache: monitor::SharedMetrics = Arc::new(RwLock::new(
        monitor::SystemMetricsPayload::default(),
    ));
    let metrics_cache_clone = metrics_cache.clone();

    tauri::Builder::default()
        .register_uri_scheme_protocol("artifact", |_ctx, request| {
            // One page only, at one path, and nothing else. Its policy is sent as the response
            // header too (the same text as the page's meta, `artifact_frame::frame_csp`), so it
            // holds whatever the frame does to its own document.
            let served = || {
                let mut res = tauri::http::Response::builder()
                    .header(tauri::http::header::CONTENT_TYPE, "text/html; charset=utf-8")
                    .header("X-Content-Type-Options", "nosniff");
                if let Some(csp) = artifact_frame::frame_csp(ARTIFACT_FRAME_HTML) {
                    res = res.header("Content-Security-Policy", csp);
                }
                res.body(ARTIFACT_FRAME_HTML.as_bytes().to_vec())
            };
            if request.uri().path() != "/frame.html" {
                tauri::http::Response::builder()
                    .status(tauri::http::StatusCode::NOT_FOUND)
                    .body(Vec::new())
                    .unwrap()
            } else {
                served().unwrap()
            }
        })
        .plugin(log_plugin())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .manage(supervisor)
        .manage(metrics_cache)
        .invoke_handler(tauri::generate_handler![
            commands::preload_model,
            commands::start_server,
            commands::stop_server,
            commands::get_server_status,
            commands::get_server_logs,
            commands::set_server_busy_cmd,
            commands::geniex_capabilities_cmd,
            commands::model_manifest_cmd,
            commands::get_model_evidence_cmd,
            commands::record_model_evidence_cmd,
            commands::get_settings,
            commands::save_settings_cmd,
            commands::get_settings_repair_notice,
            commands::get_app_info_cmd,
            commands::get_hardware_cmd,
            commands::get_installed_models_cmd,
            commands::get_meters_cmd,
            commands::estimate_memory_cmd,
            commands::get_power_status_cmd,
            commands::run_benchmark_cmd,
            commands::cancel_benchmark_cmd,
            commands::get_hardware_config_cmd,
            commands::save_hardware_config_cmd,
            commands::inhibit_sleep,
            commands::get_system_metrics,
            commands::set_inferring_state,
            commands::open_task_manager,
            commands::window_minimize,
            commands::window_maximize,
            commands::window_close,
            commands::get_qos_status_cmd,
            commands::set_qos_tier_cmd,
            commands::verify_sha256_cmd,
            commands::chunk_document_text_cmd,
            commands::ocr_page_cmd,
            commands::npu_diagnostics_cmd,
            commands::sidecar_call,
            commands::agent_list_windows_cmd,
            commands::agent_begin_run_cmd,
            commands::agent_stop_cmd,
        ])
        .setup(move |app| {
            paths::startup_log("setup", "Tauri setup entered");

            // The main window FIRST (moved out of tauri.conf.json so the WebView2
            // data directory can be pinned per build flavor): everything below
            // looks it up.
            match create_main_window(app.handle()) {
                Ok(_) => paths::startup_log(
                    "main-window-created",
                    &format!(
                        "main window + webview created (profile: {})",
                        paths::webview_data_dir().display()
                    ),
                ),
                Err(e) => {
                    paths::startup_log(
                        "main-window-created",
                        &format!(
                            "FAILED: {e:?} — check the WebView2 runtime and whether the \
                             profile folder is locked (C:\\Program Files (x86)\\Microsoft\\EdgeWebView)"
                        ),
                    );
                    return Err(e.into());
                }
            }

            // Respond to second-instance launches: restore the window on WM_APP+1.
            single_instance::start_restore_listener(app.handle().clone());

            // The Node sidecar (the TypeScript main-process logic), supervised and managed here.
            app.manage(sidecar::SidecarHost::new(app.handle().clone()));
            // The pinned Computer Use driver (agent-desktop.exe), managed here: the
            // host owns its supervision, the window grant and every call's check.
            app.manage(agent_driver::AgentDriverHost::new(app.handle().clone()));
            if let Err(e) = tray::setup_tray(app.handle()) {
                paths::append_log("mkmn", &format!("[tray_err] {:?}", e));
            }
            monitor::start_monitor_loop(app.handle().clone(), supervisor_inner, metrics_cache_clone);
            // Session end (logoff, shutdown, Restart Manager): tao never delivers
            // WM_ENDSESSION to the main window, so the main window is subclassed
            // to run the coordinated shutdown when the session ends.
            match app.get_webview_window("main").map(|w| w.hwnd()) {
                Some(Ok(hwnd)) => {
                    if let Err(e) = session_end::install(app.handle(), hwnd) {
                        paths::append_log("mkmn", &format!("[session_end_err] {}", e));
                    }
                }
                Some(Err(e)) => {
                    paths::append_log("mkmn", &format!("[session_end_err] no hwnd: {:?}", e));
                }
                None => {
                    paths::append_log(
                        "mkmn",
                        "[session_end_err] main window not found; session-end handling not installed",
                    );
                }
            }
            paths::startup_log(
                "setup-complete",
                &format!("setup finished in {} ms total", t0.elapsed().as_millis()),
            );
            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                WindowEvent::CloseRequested { api, .. } => {
                    // The ONE unified close setting ("closeAction"): the default is a
                    // full application exit; hiding to the notification area happens
                    // only on an explicit user choice (Settings → close behavior).
                    if settings::close_hides_to_tray() {
                        // Explicit tray choice: keep running, just hide.
                        api.prevent_close();
                        monitor::set_window_minimized_or_hidden(true);
                        let _ = window.hide();
                    } else {
                        // Full exit: hide the window NOW and start the coordinated
                        // shutdown immediately. The reported hung close never reached
                        // the Tauri exit event (it wrote no [shutdown] line), so the
                        // teardown must not depend on that event arriving. kick is
                        // idempotent, so the Exit events below still join it safely.
                        let _ = window.hide();
                        shutdown::kick(window.app_handle());
                    }
                }
                WindowEvent::Focused(focused) => {
                    monitor::set_window_focused(*focused);
                    if *focused {
                        monitor::set_window_minimized_or_hidden(false);
                    }
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .map_err(|e| {
            paths::append_log("mkmn", &format!("[tauri_run_err] {:?}", e));
            e
        })
        .expect("error while running tauri application")
        .run(|app, event| match event {
            tauri::RunEvent::Ready => {
                paths::startup_log(
                    "run-loop-ready",
                    "the event loop is running and the app is fully started",
                );
            }
            // Any exit request (last window closed, session end, an explicit exit):
            // START the coordinated shutdown NOW, so the sidecar/server teardown
            // overlaps with the window teardown instead of starting after it.
            tauri::RunEvent::ExitRequested { .. } => shutdown::kick(app),
            // The final event before the process exits: make sure the sequence ran
            // (or run it now, if this exit path skipped ExitRequested), bounded by
            // its timeout; the job object terminates anything left afterwards.
            tauri::RunEvent::Exit => {
                tauri::async_runtime::block_on(shutdown::finish(app));
            }
            _ => {}
        });
}
/// The app's own log levels: Info for MKMN, Warn for the HTTP and windowing libraries. The plugin's
/// default logged every level, and the HTTP client's trace lines (several a second) pushed the sidecar's
/// own messages out of a 40 KB file kept alone.
fn log_levels() -> (log::LevelFilter, &'static [(&'static str, log::LevelFilter)]) {
    use log::LevelFilter::Warn;
    (
        log::LevelFilter::Info,
        &[("reqwest", Warn), ("hyper", Warn), ("hyper_util", Warn), ("h2", Warn), ("tao", Warn), ("wry", Warn), ("tracing", Warn)],
    )
}

/// The log plugin: the levels above, 2 MB per file, the three latest files kept.
fn log_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let (level, quieter) = log_levels();
    let mut b = tauri_plugin_log::Builder::new()
        .level(level)
        .max_file_size(2_000_000)
        .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(3));
    for (module, l) in quieter {
        b = b.level_for(*module, *l);
    }
    b.build()
}

#[cfg(test)]
mod log_level_tests {
    #[test]
    fn the_log_keeps_the_app_and_quiets_the_libraries() {
        let (level, quieter) = super::log_levels();
        assert_eq!(level, log::LevelFilter::Info);
        for lib in ["reqwest", "hyper", "hyper_util"] {
            let l = quieter.iter().find(|(m, _)| *m == lib).map(|(_, l)| *l);
            assert!(l.is_some_and(|l| l <= log::LevelFilter::Warn), "{lib} must log warnings only");
        }
    }
}
