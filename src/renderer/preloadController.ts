import type { ServerStatus } from "../shared/types";
import { canTransition } from "../shared/stateMachines";

/**
 * The lifecycle of the predictive model preload, taken out of Chat.tsx so it can be
 * tested on its own with an injected API: idempotency against an already-ready server,
 * one IPC call per in-flight model, the 60-second idle unload after an emptied composer,
 * model switches, and the cleanup when the chat goes away (so a stale timer can never
 * stop a server used by another chat).
 */

export type PreloadPhase = "warming" | "ready" | null;

/** Why the last preload failed, as far as it is known. */
export interface PreloadFailure {
  /** Category id when the host classified the failure, else a generic one. */
  id: string;
  title: string;
  /** The next step to try, when the host provided one. */
  fix?: string;
  raw: string;
}

/** The part of the application API the controller needs (injected in tests). */
export interface PreloadApi {
  preloadModel(req: { model: string }): Promise<ServerStatus>;
  stopServer(): Promise<unknown>;
}

export interface PreloadControllerOptions {
  api: PreloadApi;
  /** The latest server status, so an already-ready model is a no-op without an IPC call. */
  getServer: () => ServerStatus | null | undefined;
  /** The loading strategy, read when the idle-unload timer fires. */
  getLoadingStrategy: () => string | undefined;
  /** The model to preload when the composer did not name one. */
  getModel: () => string;
  /** How long an emptied composer waits before the model is unloaded. Default 60 seconds. */
  idleUnloadMs?: number;
  /**
   * The idle model release setting, read when the idle-unload timer is armed, in
   * milliseconds (0 = never release). When given, it replaces the fixed
   * `idleUnloadMs`; 0 disarms the idle unload entirely.
   */
  getIdleUnloadMs?: () => number | undefined;
  /**
   * "Warm up model while typing" (Settings → Speed & memory, off by default): whether typing a draft may start
   * loading the model. Read at each keystroke so the setting applies live. Missing = on (the tests' default).
   */
  isEnabled?: () => boolean;
}

export interface PreloadController {
  phase(): PreloadPhase;
  lastPreloadedModel(): string | null;
  /** The reason the last preload failed, or null when the last attempt succeeded (or none ran). */
  lastError(): PreloadFailure | null;
  /** True when a preload for this exact model is in flight. */
  isPreloading(model: string): boolean;
  /** Subscribe to phase changes; returns the unsubscribe function. */
  onPhase(listener: (phase: PreloadPhase) => void): () => void;
  /** Ask for a model to be warm. Repeated calls for the same model do nothing. */
  trigger(model?: string): void;
  /** The composer's draft changed: typing cancels the idle unload; emptying it arms the timer. */
  draftChanged(value: string): void;
  /** The composer sent its message: the idle unload is no longer wanted. */
  cancelIdleUnload(): void;
  /** The draft was sent: the next draft may start a warm-up again (once). */
  endDraft(): void;
  /** Resolves when a warm-up of `model` in flight has ended (ready or failed); at once when none is. Never rejects. */
  settled(model: string): Promise<void>;
  /** The person's Retry after a failed warm-up: typing never restarts a failed load, this does. */
  retry(): void;
  /** The chosen model changed: forget the old in-flight guard and warm the new model. */
  modelSwitched(model: string): void;
  /** The chat is going away: clear the timer so it can never stop another chat's server. */
  dispose(): void;
}

/** True for keystrokes that carry no intent to type: modifiers, navigation, and function keys. */
export const isModifierOrNavKey = (key: string, ctrl = false, alt = false, meta = false): boolean => {
  if (ctrl || alt || meta) return true;
  const ignored = new Set([
    "Shift", "Control", "Alt", "Meta", "CapsLock",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
    "Escape", "Tab", "Home", "End", "PageUp", "PageDown",
    "Insert", "ContextMenu", "Pause", "PrintScreen", "ScrollLock"
  ]);
  return ignored.has(key) || /^F\d+$/.test(key);
};

export function createPreloadController(options: PreloadControllerOptions): PreloadController {
  const idleUnloadMs = options.idleUnloadMs ?? 60_000;
  let inflightModel: string | null = null;
  let lastPreloaded: string | null = null;
  let phase: PreloadPhase = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let requestCounter = 0;
  // Bounded backoff for a model that keeps failing to preload: one immediate retry is
  // allowed (a transient failure should not wait), then the retries are pushed apart —
  // so typing into the composer cannot relaunch a failing load on every keystroke.
  // Cleared by an explicit model switch or a success.
  const BACKOFF_MS = [30_000, 60_000, 120_000];
  let failureCount = 0;
  let suppressedModel: string | null = null;
  let suppressUntil = 0;
  let failure: PreloadFailure | null = null;
  // the model whose last warm-up failed: typing does not restart it (Retry or a model change does)
  let failedModel: string | null = null;
  // one warm-up per draft: set by the first non-whitespace character, cleared when the draft is sent or emptied
  let draftTriggered = false;
  // the warm-up in flight, so Send can wait for that same load instead of starting another
  let inflight: { model: string; done: Promise<void> } | null = null;
  const enabled = () => options.isEnabled?.() ?? true;
  const listeners = new Set<(p: PreloadPhase) => void>();

  const setPhase = (next: PreloadPhase) => {
    if (phase === next) return;
    // The phase is the `preload` registry machine; a null phase is its idle state. An
    // impossible move is a programming fault, so it is reported rather than stored.
    const from = phase ?? "idle";
    const to = next ?? "idle";
    if (!canTransition("preload", from, to)) throw new Error(`preload cannot move from ${from} to ${to}`);
    phase = next;
    for (const l of listeners) l(phase);
  };

  const trigger = (model?: string) => {
    const modelToLoad = model || options.getModel();
    if (!modelToLoad) return;
    // Foundry Local serves its own models and loads one on its first request: the
    // GenieX preload cannot load it and would only report a failure the chat never has.
    if (modelToLoad.startsWith("foundry:")) { failure = null; setPhase(null); return; }

    // A model that just failed waits out its backoff window before another attempt.
    if (suppressedModel === modelToLoad && Date.now() < suppressUntil) return;

    // Strict idempotency: an already-ready server with this model is an instant no-op.
    // "busy" counts too: the model is resident and generating, and a preload request
    // would only check the same thing again.
    const server = options.getServer();
    if ((server?.state === "ready" || server?.state === "busy") && (server?.model === modelToLoad || (!server?.model && lastPreloaded === modelToLoad))) {
      setPhase("ready");
      return;
    }

    // Already in flight for this exact model: no duplicate IPC call.
    if (inflightModel === modelToLoad) return;

    inflightModel = modelToLoad;
    setPhase("warming");
    const requestId = ++requestCounter;

    const done = options.api.preloadModel({ model: modelToLoad })
      .then((status) => {
        // A stale answer (the model was switched while this preload was in flight)
        // must not override the phase of the newer request.
        if (requestId !== requestCounter) return;
        if (status.state === "ready" || status.state === "busy") {
          lastPreloaded = modelToLoad;
          failure = null;
          failedModel = null;
          setPhase("ready");
        } else if (status.state === "starting" || status.state === "loading") {
          setPhase("warming");
        } else {
          // The host answered, but not with a warm model: it classified the failure
          // itself (missing artifact, timeout, memory…). Surface THAT, not a generic
          // swallowed rejection.
          failure = status.lastError
            ? { id: status.lastError.id, title: status.lastError.title, fix: status.lastError.fix, raw: status.lastError.raw }
            : { id: "error", title: "The model could not be loaded", raw: `The server reported state "${status.state}".` };
          failedModel = modelToLoad;
          setPhase(null);
        }
      })
      .catch((reason: unknown) => {
        if (requestId !== requestCounter) return;
        // The rejection itself IS the failure report (the host refuses unresolvable
        // ids, RAM overruns…). It used to be discarded here, so every preload
        // failure looked like a silent timeout to the user.
        const raw = typeof reason === "string"
          ? reason
          : reason instanceof Error
            ? reason.message
            : (() => { try { return JSON.stringify(reason); } catch { return String(reason); } })();
        failure = { id: "error", title: "The model could not be loaded", raw };
        failedModel = modelToLoad;
        const wait = failureCount === 0 ? 0 : BACKOFF_MS[Math.min(failureCount - 1, BACKOFF_MS.length - 1)];
        failureCount += 1;
        suppressedModel = modelToLoad;
        suppressUntil = Date.now() + wait;
        setPhase(null);
      })
      .finally(() => {
        if (inflightModel === modelToLoad) {
          inflightModel = null;
        }
        if (inflight?.done === done) inflight = null;
      });
    inflight = { model: modelToLoad, done };
  };

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  return {
    phase: () => phase,
    lastPreloadedModel: () => lastPreloaded,
    lastError: () => failure,
    isPreloading: (model: string) => inflightModel === model,
    onPhase(listener: (p: PreloadPhase) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    trigger,

    draftChanged(value: string) {
      if (value.trim().length > 0) {
        clearIdleTimer();
        // the first non-whitespace character of a draft, once, and only with the setting on; a model whose
        // warm-up failed is left alone (more typing must not restart a failed load: Retry does)
        if (!enabled() || draftTriggered) return;
        draftTriggered = true;
        const model = options.getModel();
        if (model && model === failedModel) return;
        trigger(model);
      } else {
        draftTriggered = false;
        // nothing was warmed for this draft with the setting off: an emptied composer unloads nothing
        if (!enabled()) { clearIdleTimer(); return; }
        // Cancelled input: if the person does not send within the idle window and the
        // app is in On Demand mode, the model is gracefully unloaded. The window is the
        // idle model-release setting ("Off" = never release → no timer at all).
        clearIdleTimer();
        const idleMs = options.getIdleUnloadMs?.() ?? idleUnloadMs;
        if (idleMs <= 0) return;
        idleTimer = setTimeout(() => {
          idleTimer = null;
          setPhase(null);
          if (options.getLoadingStrategy() === "demand") {
            void options.api.stopServer().catch(() => { /* already gone */ });
          }
        }, idleMs);
      }
    },

    cancelIdleUnload() {
      clearIdleTimer();
    },

    endDraft() {
      draftTriggered = false;
      clearIdleTimer();
    },

    settled(model: string) {
      return inflight && inflight.model === model ? inflight.done : Promise.resolve();
    },

    retry() {
      suppressedModel = null;
      suppressUntil = 0;
      failureCount = 0;
      failedModel = null;
      failure = null;
      inflightModel = null;
      draftTriggered = true;
      trigger();
    },

    modelSwitched(model: string) {
      // An explicit selection is the user's retry: forget the old model's failures.
      suppressedModel = null;
      suppressUntil = 0;
      failureCount = 0;
      inflightModel = null;
      failure = null;
      failedModel = null;
      // the old warm-up's answer must not touch the new model: it is stale from here on
      requestCounter++;
      if (inflight && inflight.model !== model) inflight = null;
      if (!enabled()) { setPhase(null); return; }
      trigger(model);
    },

    dispose() {
      clearIdleTimer();
    },
  };
}
