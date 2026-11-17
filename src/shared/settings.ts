/**
 * The ONE close-behavior setting ("closeAction"), shared by the renderer, the Tauri
 * host. Closing MKMN quits the application by default;
 * hiding to the notification area happens only on an explicit user choice.
 *
 * The legacy `minimizeToTray` boolean (default true — the app kept running after
 * close) is migrated away: an explicit tray choice is preserved as "tray", everything
 * else becomes "quit". The legacy key is dropped so every reader sees one setting.
 */

export type CloseAction = "tray" | "quit";

/**
 * Normalizes a loaded settings object into a complete close-behavior pair. Pure: it
 * never mutates the input and mirrors the Rust migration in
 * src-tauri/src/settings.rs (migrate_close_settings) — keep both in step.
 */
export function normalizeCloseAction(saved: Record<string, unknown>): { closeAction: CloseAction; minimizeToTrayRemoved: boolean } {
  const savedChoice = saved.closeAction;
  if (savedChoice === "tray" || savedChoice === "quit") {
    return { closeAction: savedChoice, minimizeToTrayRemoved: "minimizeToTray" in saved };
  }
  // Legacy map: only an explicit true keeps the tray; the new default quits.
  const closeAction: CloseAction = saved.minimizeToTray === true ? "tray" : "quit";
  return { closeAction, minimizeToTrayRemoved: true };
}

// ------------------------------------------------------------------ context / cache

export interface ContextReconcileResult {
  next: Record<string, unknown>;
  changed: boolean;
  /** The `runtime.*` keys that were folded up or dropped as duplicates. */
  folded: string[];
}

/**
 * The ONE context/cache configuration. The top-level `nctxMode`, `kvType` and
 * `kvInRam` keys are authoritative — the supported runtimes (GenieX in the Tauri
 * host, and the llama.cpp path via main.ts) read them — while the legacy
 * `runtime.ctx` / `runtime.kvType` / `runtime.kvInRam` duplicates were consumed only
 * by the old llama argument builder, so the two editors could disagree with each
 * other and with what actually ran. This folds the legacy keys into the top level:
 *  - `runtime.kvType` / `runtime.kvInRam` copy up when the top level has none, and are
 *    dropped either way (the llama path now reads the top-level values);
 *  - `runtime.ctx` copies up as `nctxMode` only when it is one of the window sizes the
 *    setting offers (2048 / 4096 / 8192); any other number stays in `runtime` as a
 *    llama.cpp-only override, and a useless 0 is dropped.
 *
 * Pure; mirrors the Rust migration in src-tauri/src/settings.rs
 * (migrate_context_settings) — keep both in step.
 */
export function reconcileContextSettings(saved: Record<string, unknown>): ContextReconcileResult {
  const next: Record<string, unknown> = { ...saved };
  const folded: string[] = [];
  const rtRaw = next.runtime;
  if (!rtRaw || typeof rtRaw !== "object" || Array.isArray(rtRaw)) return { next, changed: false, folded };
  const rt: Record<string, unknown> = { ...(rtRaw as Record<string, unknown>) };

  if ("kvType" in rt) {
    if (next.kvType === undefined && typeof rt.kvType === "string") next.kvType = rt.kvType;
    delete rt.kvType;
    folded.push("kvType");
  }
  if ("kvInRam" in rt) {
    if (next.kvInRam === undefined && typeof rt.kvInRam === "boolean") next.kvInRam = rt.kvInRam;
    delete rt.kvInRam;
    folded.push("kvInRam");
  }
  if ("ctx" in rt) {
    const c = rt.ctx;
    if (typeof c === "number") {
      const standard = c === 2048 || c === 4096 || c === 8192;
      if (standard && next.nctxMode === undefined) next.nctxMode = String(c);
      if (standard || c <= 0) { delete rt.ctx; }
      folded.push("ctx");
    }
  }

  if (Object.keys(rt).length > 0) next.runtime = rt;
  else delete next.runtime;
  const changed = JSON.stringify(next) !== JSON.stringify(saved);
  return { next, changed, folded };
}
