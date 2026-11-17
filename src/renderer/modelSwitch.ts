/**
 * Switching the chat model from Settings → Models → Use. A click showed nothing for 46 s or more and
 * a second click was silently ignored. The switch now says what happens ("Starting <model>…", then "Warming up…"
 * once the host lists the model), can be cancelled, and refuses a second switch while one runs. The selection is
 * saved by the bridge only after the requested model warmed up and only when the switch was not cancelled.
 */

export type SwitchPhase =
  | { kind: "idle" }
  | { kind: "starting"; id: string; name: string }
  | { kind: "warming"; id: string; name: string }
  | { kind: "failed"; id: string; name: string; error: string }
  | { kind: "cancelled"; id: string; name: string };

export interface SwitchDeps {
  /** Start and select the model; must save nothing once `signal` is aborted (tauriBridge.selectModel). */
  select(id: string, signal: AbortSignal): Promise<void>;
  /** The host's lifecycle state ("starting", "loading" = listed and warming up, "ready"...), null when unknown. */
  serverState(): Promise<string | null>;
  /** Stops the pending start in the host (the model server only: the CPU router is the sidecar's own). */
  stopPending(): Promise<void>;
  onPhase(p: SwitchPhase): void;
  pollMs?: number;
}

export type SwitchResult = "done" | "failed" | "cancelled" | "busy";

export class ModelSwitcher {
  private current: { id: string; name: string; ac: AbortController } | null = null;

  constructor(private readonly d: SwitchDeps) {}

  get busy(): boolean { return this.current !== null; }

  /** The model being switched to, if any. */
  get pendingId(): string | null { return this.current?.id ?? null; }

  async start(id: string, name: string): Promise<SwitchResult> {
    if (this.current) return "busy";
    const ac = new AbortController();
    const run = { id, name, ac };
    this.current = run;
    let phase: "starting" | "warming" = "starting";
    this.d.onPhase({ kind: "starting", id, name });
    // the host's state says when the requested model is listed: from then on it is warming up
    const poll = setInterval(() => {
      void this.d.serverState().then((s) => {
        if (this.current !== run || ac.signal.aborted) return;
        if (s === "loading" && phase === "starting") {
          phase = "warming";
          this.d.onPhase({ kind: "warming", id, name });
        }
      }).catch(() => undefined);
    }, this.d.pollMs ?? 500);
    try {
      await this.d.select(id, ac.signal);
      if (ac.signal.aborted) return "cancelled"; // a late answer of a cancelled switch: cancel() already reported it
      this.d.onPhase({ kind: "idle" });
      return "done";
    } catch (e) {
      if (ac.signal.aborted) return "cancelled";
      this.d.onPhase({ kind: "failed", id, name, error: e instanceof Error ? e.message : String(e) });
      return "failed";
    } finally {
      clearInterval(poll);
      if (this.current === run) this.current = null;
    }
  }

  /** Cancels the pending switch: nothing it answers later is saved, and the host stops starting it. */
  async cancel(): Promise<void> {
    const run = this.current;
    if (!run) return;
    run.ac.abort();
    this.current = null;
    this.d.onPhase({ kind: "cancelled", id: run.id, name: run.name });
    await this.d.stopPending().catch(() => undefined);
  }
}

/**
 * Whether a switch's outcome note ("… stays selected; no model is loaded now") no longer says what runs: true when the
 * model server just became ready or busy again (the note still said "no model is loaded"
 * after the next message had loaded the model). A note written while a model runs stays until the server changes.
 */
export function switchNoteOutdated(prev: string | null | undefined, next: string | null | undefined): boolean {
  const loaded = (s: string | null | undefined) => s === "ready" || s === "busy";
  return loaded(next) && !loaded(prev);
}

/**
 * What removing a GenieX model may do given the model server's state. While a model is starting or loading its
 * files are being read: two model folders were deleted during a load (the old rule stopped only a
 * READY server), GenieX crashed reading them, and every later start found a cache without the model.
 */
export function uninstallGate(state: string | null | undefined): "refuse" | "stop" | "go" {
  if (state === "starting" || state === "loading" || state === "busy") return "refuse";
  if (state === "ready") return "stop";
  return "go";
}
