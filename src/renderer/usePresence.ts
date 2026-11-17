import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export const EXIT_MS = 120;

export function reducedMotion(): boolean {
  try { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; }
}

/**
 * Keeps something mounted while its exit animation plays. Pass the live value (null = closed);
 * `value` is what to render (the last one while closing) and `closing` drives the exit CSS.
 */
export function usePresence<T>(value: T | null, ms = EXIT_MS): { value: T | null; closing: boolean } {
  const [held, setHeld] = useState<T | null>(value);
  useEffect(() => {
    if (value !== null) { setHeld(value); return; }
    const t = setTimeout(() => setHeld(null), reducedMotion() ? 0 : ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return { value: value ?? held, closing: value === null && held !== null };
}

/**
 * For a component its parent unmounts on close: `close()` plays the exit first, then calls onClose.
 * `leaving` goes on the root element as data-state="closed".
 */
export function useExit(onClose: () => void, ms = EXIT_MS): { leaving: boolean; close: () => void } {
  const [leaving, setLeaving] = useState(false);
  const cb = useRef(onClose);
  cb.current = onClose;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = useCallback(() => {
    if (timer.current) return;
    setLeaving(true);
    timer.current = setTimeout(() => cb.current(), reducedMotion() ? 0 : ms);
  }, [ms]);
  return { leaving, close };
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/**
 * Overlay stack: when several surfaces are open at once (Search over Settings,
 * for instance), only the TOPMOST one owns Escape and Tab. Each active focus
 * trap pushes a token on activation and pops it on cleanup; a trap whose token
 * is not on top does nothing, so two traps can never fight over the keyboard.
 */
const trapStack: symbol[] = [];

/** Modal sanity: Escape closes, Tab stays inside, focus moves in on open and goes back to where it was on close. */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape: () => void) {
  const esc = useRef(onEscape);
  esc.current = onEscape;
  /** Timers / disarm callbacks of a just-deactivated trap; cancelled on re-activation. */
  const pending = useRef<ReturnType<typeof setTimeout>[]>([]);
  const disarm = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!active) return;
    // Re-activation (e.g. Models pops back to a kept-mounted Settings): cancel the
    // previous deactivation's watch window so it cannot fight the fresh trap.
    pending.current.forEach(clearTimeout);
    pending.current = [];
    disarm.current?.();
    disarm.current = null;
    const root = ref.current;
    const token = Symbol("overlay");
    trapStack.push(token);
    const before = document.activeElement as HTMLElement | null;
    if (root && !root.contains(document.activeElement)) root.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      // another surface opened above this one: it owns the keyboard until it closes
      if (trapStack[trapStack.length - 1] !== token) return;
      if (e.key === "Escape") {
        // a filled search field takes Escape first (it clears itself); the next one closes
        const t = e.target as HTMLElement | null;
        if (t instanceof HTMLInputElement && t.type === "search" && t.value) return;
        e.stopPropagation(); esc.current(); return;
      }
      if (e.key !== "Tab" || !root) return;
      const items = [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); root.focus(); return; }
      const first = items[0], last = items[items.length - 1], cur = document.activeElement;
      if (e.shiftKey && (cur === first || cur === root)) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
      else if (!root.contains(cur)) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key, true);
    // While a deactivating surface plays its exit, React 19 re-focuses controlled
    // inputs on commits (selection restore) — its phantom override can land after
    // the synchronous restore below. For a short window after deactivation, a
    // focus move INTO this (still-mounted) root that follows no real user input
    // is treated as phantom and reverted; moves after a real pointerdown/keydown
    // are always the user's own and respected.
    let gestureAt = -1;
    let selfFocus = false;
    let cleanedAt = Number.POSITIVE_INFINITY;
    const gesture = () => { gestureAt = performance.now(); };
    const restore = () => {
      // Restoring to <body> is meaningless (it is the default state) and would only
      // stomp programmatic focus fallbacks that run after this trap closes.
      if (!before || before === document.body || !document.contains(before)) return;
      const cur = document.activeElement;
      if (cur !== before && cur !== document.body && !(root && root.contains(cur))) return;
      before.focus({ preventScroll: true });
    };
    const revert = (e: FocusEvent) => {
      if (selfFocus) { selfFocus = false; return; }
      if (!before || before === document.body || !document.contains(before)) return;
      if (e.target === before || gestureAt > cleanedAt) return;
      // Only React's phantom re-focus of the exiting surface's own controls is
      // reverted — a focus move OUTSIDE this root belongs to the app (an opener
      // restore, a fallback) or the user and must never be second-guessed.
      if (!(root && root.contains(e.target as Node))) return;
      selfFocus = true;
      before.focus({ preventScroll: true });
    };
    return () => {
      document.removeEventListener("keydown", key, true);
      cleanedAt = performance.now();
      // Stack ownership: when several surfaces close in the same commit, only the
      // TOPMOST trap may restore focus — a trap deactivating beneath another one
      // (Settings under a Models layer) would otherwise re-assert its own stale
      // return target over the topmost trap's correct one.
      const owner = trapStack[trapStack.length - 1] === token;
      const i = trapStack.lastIndexOf(token);
      if (i >= 0) trapStack.splice(i, 1);
      if (!owner) return;
      restore();
      pending.current = [
        setTimeout(restore, 0),
        // watch window: ends after the exit has fully played
        setTimeout(() => {
          disarm.current = null;
          document.removeEventListener("focusin", revert, true);
          document.removeEventListener("pointerdown", gesture, true);
          document.removeEventListener("keydown", gesture, true);
          restore();
        }, 200),
      ];
      disarm.current = () => {
        document.removeEventListener("focusin", revert, true);
        document.removeEventListener("pointerdown", gesture, true);
        document.removeEventListener("keydown", gesture, true);
      };
      document.addEventListener("focusin", revert, true);
      document.addEventListener("pointerdown", gesture, true);
      document.addEventListener("keydown", gesture, true);
    };
  }, [active, ref]);
}
