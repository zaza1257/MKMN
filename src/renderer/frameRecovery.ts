// What the preview does when its frame loads again after the page was written.
//
// Writing the page fires one load of the frame, and the frame then answers a ping
// with the page's key. A generated page that tried to go to another address leaves
// the browser's error page in the frame (the host cancels the navigation), and a page
// that reloaded itself leaves an empty frame page: neither answers with the key. The
// page is then shown once more; a page that keeps leaving stops with a notice instead
// of looping (installed-build check, 2026-11-17).

export type FrameVerdict = "kept" | "show-again" | "stop";

/** `answeredKey` is the key the frame answered the ping with (null: no answer, or an empty frame page). */
export function frameVerdict(key: number, answeredKey: number | null, shownAgainBefore: boolean): FrameVerdict {
  if (answeredKey === key) return "kept";
  return shownAgainBefore ? "stop" : "show-again";
}

/** How long a frame has to answer the ping. A busy page answers between two of its frames. */
export const PING_WAIT_MS = 1500;

export const SHOWN_AGAIN_NOTICE = "This page tried to leave the preview for another address. Generated pages cannot reach other addresses, so it is shown again here.";
export const STOPPED_NOTICE = "This page keeps trying to leave the preview for another address, so its preview stopped. Generated pages cannot reach other addresses.";
