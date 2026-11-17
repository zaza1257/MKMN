import type { CatalogEntry } from "../shared/types";

/**
 * A model the app does not know, ALREADY installed when the app starts: the sidecar
 * only ever checked models it installed itself (the "install" hook), so a custom
 * model imported outside the app never earned its placement badge — five sat
 * unmeasured here. At startup (deferred: the app may be needed at once), the same
 * one-model load test the install path runs is offered to every installed unknown
 * model, one at a time.
 *
 * The placement guard inside the check makes it run ONCE per model, ever: a model
 * that was measured wears a placement (persisted settings — something the earlier
 * saveSettings host fix is what lets exist at all), so no later startup re-tests it.
 * A busy NPU (a chat, the benchmark, another test, a task) is never taken over: the
 * queue stops for this launch and the next launch tries again.
 */

export interface UnknownModelCheckDeps {
  /** The catalog entries whose model sits in the GenieX cache right now. */
  installedEntries: () => Promise<CatalogEntry[]>;
  /** The sidecar's unknown-model rule: not a catalog model, no placement, not a Dynamic part. */
  isUnknown: (e: CatalogEntry) => boolean;
  /** The one-model load test that gives the model its badge (checkNewModel). */
  check: (e: CatalogEntry) => Promise<void>;
  /** True while the NPU is held by a chat, the benchmark, another test or a task. */
  busy: () => boolean;
  /** Timer; injected so tests run without waiting. */
  delay: (ms: number) => Promise<void>;
  /** How long after startup the first check may begin. */
  initialDelayMs: number;
  log?: (line: string) => void;
}

export interface UnknownModelCheckState {
  running: boolean;
  /** The refs still queued for this launch (the unknown installed models). */
  pending: string[];
  /** The ref being load-tested right now, if any. */
  current: string | null;
  /** What this launch did so far, oldest first. */
  log: string[];
}

export interface UnknownModelCheckHandle {
  /** Runs the whole startup sequence; call once, at sidecar startup. */
  run: () => Promise<void>;
  state: () => UnknownModelCheckState;
}

/** A busy NPU is waited for (polled this often, this many times: 30 minutes), never taken over. */
const BUSY_POLL_MS = 30_000;
const BUSY_MAX_POLLS = 60;
/** An unreadable model list (GenieX being replaced, a slow start) is read again before the launch gives up. */
const READ_TRIES = 3;
const READ_RETRY_MS = 60_000;

export function startUnknownModelCheck(deps: UnknownModelCheckDeps): UnknownModelCheckHandle {
  const state: UnknownModelCheckState = { running: false, pending: [], current: null, log: [] };
  const say = (line: string) => { state.log.push(line); deps.log?.(line); };
  return {
    state: () => ({ ...state, pending: [...state.pending], log: [...state.log] }),
    async run() {
      if (state.running) return;
      state.running = true;
      try {
        await deps.delay(deps.initialDelayMs);
        // the installed inventory may fail to read (no GenieX, a broken CLI): an
        // unreadable inventory checks nothing, it never invents one
        let entries: CatalogEntry[] = [];
        for (let attempt = 1; ; attempt++) {
          try { entries = await deps.installedEntries(); break; } catch (e) {
            const why = (e as Error)?.message ?? "unknown error";
            if (attempt >= READ_TRIES) { say(`the installed models could not be read after ${attempt} tries (${why}); nothing will be checked this launch`); break; }
            say(`the installed models could not be read (${why}); trying again in a minute`);
            await deps.delay(READ_RETRY_MS);
          }
        }
        const unknown = entries.filter((e) => deps.isUnknown(e));
        if (unknown.length === 0) { say("no unknown installed models: nothing to check"); return; }
        for (const e of unknown) {
          // re-checked before EVERY model: a chat may have started mid-queue, and the
          // NPU holds one model — the queue loses to any real use
          let polls = 0;
          while (deps.busy() && polls < BUSY_MAX_POLLS) {
            if (polls === 0) say(`the NPU is busy with something the user asked for: ${e.name} waits until it is free`);
            polls++;
            await deps.delay(BUSY_POLL_MS);
          }
          if (polls >= BUSY_MAX_POLLS) { say(`the NPU stayed busy for 30 minutes: ${e.name} and the rest are left for the next launch`); return; }
          state.pending = unknown.slice(unknown.indexOf(e) + 1).map((x) => x.id);
          state.current = e.id;
          say(`checking ${e.name}…`);
          try {
            await deps.check(e);
            say(`${e.name}: checked`);
          } catch (err) {
            say(`${e.name}: the check failed (${(err as Error)?.message ?? "unknown error"}); the next launch can try again`);
          } finally {
            state.current = null;
          }
        }
      } finally {
        state.running = false;
        state.pending = [];
      }
    },
  };
}
