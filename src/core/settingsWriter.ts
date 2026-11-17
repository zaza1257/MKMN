// The sidecar's ONLY way to save settings: through the Rust host, which is the one
// writer of settings.json (its read-merge-write runs under SETTINGS_WRITE_LOCK).
//
// Before the 2026-11-17 review the sidecar, when the host failed twice, merged the
// patch into the file and wrote it itself: a second writer outside the host's lock,
// silent, able to overwrite a host save made in between. Now a patch the host could
// not take stays PENDING in memory (readers already see it through the sidecar's
// cache), is retried with a growing delay, and is reported in the log; nothing but
// the host ever writes the file. Patches are sent one at a time, in order, merged
// top-level the way the host merges them.

export type SaveState = "idle" | "saving" | "pending";

export type SettingsWriterDeps = {
  /** Hands one patch to the host; resolves with the host's merged settings. */
  save: (patch: Record<string, unknown>) => Promise<unknown>;
  /** The host's answer after a save, to refresh the reader's cache. */
  onSaved?: (merged: unknown) => void;
  log?: (line: string) => void;
  /** Delays (ms) between retries; after the last one the patch waits for the next submit. */
  delays?: number[];
  schedule?: (fn: () => void, ms: number) => { cancel: () => void };
};

const DEFAULT_DELAYS = [2_000, 5_000, 15_000, 30_000, 60_000];

export class HostSettingsWriter {
  private pending: Record<string, unknown> | null = null;
  private inFlight = false;
  private failures = 0;
  private timer: { cancel: () => void } | null = null;
  private idleWaiters: Array<() => void> = [];

  constructor(private deps: SettingsWriterDeps) {}

  /** Queues a patch for the host. Never writes the file itself. */
  submit(patch: Record<string, unknown>): void {
    this.pending = { ...(this.pending ?? {}), ...patch };
    if (this.timer) { this.timer.cancel(); this.timer = null; } // a new save is a reason to try at once
    void this.flush();
  }

  /** What was submitted and not yet saved: a reader's view is the host's answer with this on top. */
  unsaved(): Record<string, unknown> {
    return { ...(this.pending ?? {}) };
  }

  state(): SaveState {
    return this.inFlight ? "saving" : this.pending ? "pending" : "idle";
  }

  /** Resolves once nothing is in flight and no retry is scheduled: saved, or given up (tests). */
  whenSettled(): Promise<void> {
    return !this.inFlight && !this.timer ? Promise.resolve() : new Promise((r) => this.idleWaiters.push(r));
  }

  private async flush(): Promise<void> {
    if (this.inFlight || !this.pending) return;
    const patch = this.pending;
    this.pending = null;
    this.inFlight = true;
    try {
      const merged = await this.deps.save(patch);
      if (this.failures) this.deps.log?.(`[settings] saved by the host after ${this.failures} failed attempt${this.failures === 1 ? "" : "s"}`);
      this.failures = 0;
      this.deps.onSaved?.(merged);
    } catch (e) {
      // The failed patch goes back UNDER anything submitted meanwhile (newer keys win).
      this.pending = { ...patch, ...(this.pending ?? {}) };
      this.failures++;
      const delays = this.deps.delays ?? DEFAULT_DELAYS;
      const keys = Object.keys(this.pending).join(", ");
      const why = String((e as Error)?.message ?? e).slice(0, 200);
      if (this.failures <= delays.length) {
        const wait = delays[this.failures - 1];
        this.deps.log?.(`[settings] not saved yet (${keys}): the host refused or did not answer (${why}); retry in ${Math.round(wait / 1000)} s`);
        const schedule = this.deps.schedule ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
        this.timer = schedule(() => { this.timer = null; void this.flush(); }, wait);
      } else {
        this.deps.log?.(`[settings] NOT SAVED (${keys}): the host refused ${this.failures} times (${why}); kept in memory until the next change is saved`);
      }
    } finally {
      this.inFlight = false;
    }
    // A patch submitted while this one was in flight goes next.
    if (this.pending && !this.timer && this.failures === 0) return this.flush();
    if (!this.timer) {
      const w = this.idleWaiters; this.idleWaiters = [];
      for (const r of w) r();
    }
  }
}
