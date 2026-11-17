import { useEffect, useState } from "react";

/**
 * True while the WebView window can actually be seen. Pollers that exist for a screen
 * the user is looking at pause on this: a hidden window gets nothing out of a 1.5-4 s
 * poll, and the Rust monitor already stops emitting metrics while hidden, so the
 * renderer should not keep asking either.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const onChange = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  return visible;
}
