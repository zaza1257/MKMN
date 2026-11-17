/**
 * The data model of the titlebar resource HUD, taken out of TitlebarMetrics.tsx so the
 * renderer-side transformations (live/unavailable detection, status badge classification,
 * percentage formatting) can be tested against payloads shaped exactly like the ones the
 * Rust monitor emits (src-tauri/src/monitor.rs, serde field names).
 */

export interface ProcessMetric {
  pid: number;
  parentPid: number;
  name: string;
  role: string;
  depth: number;
  cpuPercent: number;
  ramBytes: number;
  ramMB: number;
  ramPercent: number;
  npuPercent: number;
  gpuPercent: number;
  status: string;
}

export interface FootprintMetric {
  cpuPercent: number;
  ramBytes: number;
  ramMB: number;
  ramPercent: number;
  npuPercent: number;
  gpuPercent: number;
  status: string;
}

export interface SystemCapacityMetric {
  cpuPercent: number;
  ramTotalBytes: number;
  ramUsedBytes: number;
  ramTotalGB: number;
  ramUsedGB: number;
  ramPercent: number;
  npuPercent: number;
  gpuPercent: number;
  /** The system actually had valid NPU counters this sample (idle 0.0 counts); false = the NPU is unavailable, and "0" is not a measurement. */
  npuAvailable?: boolean;
  /** Same, for the GPU. */
  gpuAvailable?: boolean;
  powerStatus: string;
  powerRating: string;
}

/** One physical engine's reading (M01): the adapter identity is part of the reading. */
export interface EngineReading {
  adapterClass: string;
  adapter: string;
  luid: string;
  phys: number;
  eng: number;
  engineType: string;
  percent: number;
}

export interface TitlebarPills {
  power: string;
  powerTooltip: string;
  cpu: string;
  cpuVal: number;
  gpu: string;
  gpuVal: number;
  npu: string;
  npuVal: number;
  npuActive: boolean;
  ram: string;
  ramVal: number;
  ramMB: number;
}

export interface SystemMetricsPayload {
  timestamp: number;
  processes: ProcessMetric[];
  mkmnTotal: FootprintMetric;
  systemTotal: SystemCapacityMetric;
  pills: TitlebarPills;
  /** What the RAM numbers are: private commit charge, shared pages counted once (M06). */
  memoryNote?: string;
  /** Tree processes no handle could be opened for this sample: missing, not at zero. */
  unopenedProcesses?: number;
  /** Every physical engine, on its own line (M01). */
  engines?: EngineReading[];
}

/**
 * How long a payload stays current. The monitor samples at 1.8 s (focused),
 * 5 s (unfocused) or 10 s (hidden) — a payload older than 30 s means the
 * backend stopped answering, and showing its numbers as live would be the
 * flyout's old lag: last week's load presented as this second's (M08).
 */
export const MAX_METRICS_AGE_MS = 30_000;

/** What the pills show before the first real measurement arrives: nothing is invented, everything reads "unavailable". */
export const DEFAULT_METRICS: SystemMetricsPayload = {
  timestamp: 0,
  processes: [],
  mkmnTotal: { cpuPercent: 0, ramBytes: 0, ramMB: 0, ramPercent: 0, npuPercent: 0, gpuPercent: 0, status: "—" },
  systemTotal: { cpuPercent: 0, ramTotalBytes: 0, ramUsedBytes: 0, ramTotalGB: 0, ramUsedGB: 0, ramPercent: 0, npuPercent: 0, gpuPercent: 0, npuAvailable: false, gpuAvailable: false, powerStatus: "Unknown", powerRating: "Unknown" },
  pills: {
    power: "—",
    powerTooltip: "Power status unavailable",
    cpu: "CPU —",
    cpuVal: -1,
    gpu: "GPU —",
    gpuVal: -1,
    npu: "NPU —",
    npuVal: -1,
    npuActive: false,
    ram: "RAM —",
    ramVal: -1,
    ramMB: 0,
  },
  memoryNote: "Private memory (commit charge); shared pages counted once",
  unopenedProcesses: 0,
  engines: [],
};

/**
 * True while a CURRENT measurement is on screen: a real sample must have
 * arrived, and recently — a payload whose timestamp has gone stale reads as
 * not live ("—") instead of quietly showing minutes-old numbers (M08).
 */
export const metricsAreLive = (m: SystemMetricsPayload, now: number = Date.now()): boolean => {
  if (!m || m.timestamp <= 0) return false;
  if (now - m.timestamp > MAX_METRICS_AGE_MS) return false;
  return m.processes.length > 0 || m.mkmnTotal.ramMB > 0;
};

/**
 * One poll-fed reading, with its observation metadata kept APART from the measured
 * values: `value` is the last successful reading, the timestamps say WHEN it was
 * observed, and the failure counters say what happened since. A reading that fails
 * to refresh must visibly expire instead of sitting on screen looking live.
 */
export interface Observation<T> {
  /** The last successful reading (null until one arrives). */
  value: T | null;
  /** Date.now() when the last successful reading landed (0 = none yet). */
  observedAt: number;
  /** Date.now() of the most recent failed attempt (0 = none). */
  failedAt: number;
  /** Consecutive failures since the last success. */
  failures: number;
  everOk: boolean;
}

export const initialObservation = <T,>(): Observation<T> => ({ value: null, observedAt: 0, failedAt: 0, failures: 0, everOk: false });

/** A successful observation. An unchanged reading is STILL a fresh observation: the heartbeat moves, only the values deduplicate. */
export const observeSuccess = <T,>(cur: Observation<T>, value: T, at: number, unchanged: boolean): Observation<T> => ({
  value: unchanged && cur.value !== null ? cur.value : value,
  observedAt: at,
  failedAt: 0,
  failures: 0,
  everOk: true,
});

/** A failed attempt: the last reading keeps its identity, and its age keeps growing. */
export const observeFailure = <T,>(cur: Observation<T>, at: number): Observation<T> => ({
  ...cur,
  failedAt: at,
  failures: cur.failures + 1,
});

/**
 * How the feed stands right now. `companionDown` (another poll on the same backend
 * failing too) separates "this one read failed" from "the whole backend is gone".
 * Availability of a reading's own scopes (e.g. no NPU counters) is NOT a feed phase:
 * it passes through the value untouched and the meters label it "n/a".
 */
export type ObservationPhase = "loading" | "fresh" | "stale" | "failed" | "disconnected";

export const observationPhase = (
  obs: Pick<Observation<unknown>, "value" | "observedAt" | "failures" | "everOk">,
  now: number = Date.now(),
  companionDown = false,
): ObservationPhase => {
  if (!obs.everOk || obs.value === null) {
    if (companionDown) return "disconnected";
    return obs.failures > 0 ? "failed" : "loading";
  }
  if (now - obs.observedAt > MAX_METRICS_AGE_MS) return "stale";
  return "fresh";
};

/** "just now" / "35 seconds ago" / "3 minutes ago" — for the last-updated stamp. */
export const lastUpdatedText = (observedAt: number, now: number = Date.now()): string => {
  if (!observedAt) return "never";
  const s = Math.max(0, Math.round((now - observedAt) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s} seconds ago`;
  const m = Math.round(s / 60);
  return m === 1 ? "1 minute ago" : `${m} minutes ago`;
};

/** Which badge a process row's status string renders as: efficiency mode, Hexagon inference, or the plain text. */
export type MetricsStatusBadge = "eco" | "htp" | "plain";

export const statusBadgeKind = (status: string): MetricsStatusBadge => {
  if (status.includes("EcoQoS")) return "eco";
  if (status.includes("Hexagon") || status.includes("HTP")) return "htp";
  return "plain";
};

/** A percentage readout: the real number when a measurement is live, "—" when it was never read. */
export const formatPercent = (v: number, live: boolean): string => (live ? `${v.toFixed(1)}%` : "—");

/** A utilization readout with no decimals, the way the table shows NPU/GPU loads. */
export const formatUtilization = (v: number, live: boolean): string => (live ? `${v.toFixed(0)}%` : "—");

/**
 * An accelerator readout that keeps availability apart from the number (M05):
 * "N/A" is not a 0% — when the payload says the accelerator had no valid
 * counters this sample, no measured-looking zero is shown. `available ===
 * undefined` (an older backend without the flag) keeps the numbers.
 */
export const formatAccelerator = (
  v: number,
  live: boolean,
  available: boolean | undefined,
  decimals: 0 | 1 = 0,
): string => {
  if (!live || available === false) return "N/A";
  return decimals === 1 ? `${v.toFixed(1)}%` : `${v.toFixed(0)}%`;
};

/**
 * The pills as they may be shown: EVERY numeric reading and the active indicator are
 * gated on freshness (M08) — a payload past MAX_METRICS_AGE_MS reads "—" everywhere,
 * never minutes-old numbers, however the backend labeled them (its "N/A" honesty is
 * about counter availability; staleness is decided here, where the clock is).
 */
export const livePills = (p: TitlebarPills, live: boolean): TitlebarPills =>
  live
    ? p
    : {
        power: "—",
        powerTooltip: "Power status unavailable (the readings are stale)",
        cpu: "CPU —",
        cpuVal: -1,
        gpu: "GPU —",
        gpuVal: -1,
        npu: "NPU —",
        npuVal: -1,
        npuActive: false,
        ram: "RAM —",
        ramVal: -1,
        ramMB: 0,
      };

/** A per-process CPU reading: stale data is "—", never minutes-old numbers. */
export const formatProcessCpu = (v: number, live: boolean): string => (live ? `${v.toFixed(1)}%` : "—");

/** A per-process RAM reading: unreadable (0) and stale both read "—", never a guess. */
export const formatProcessRam = (proc: { ramMB: number; ramPercent: number }, live: boolean): string =>
  live && proc.ramMB > 0 ? `${proc.ramMB.toFixed(0)} MB (${proc.ramPercent.toFixed(1)}%)` : "—";

// ---------------------------------------------------------------------------
// Bounded request lifecycle and unified update ordering.
//
// The Tauri bridge cannot cancel an invoke once it is sent, so a timeout means
// "the caller stops waiting" — the late response is invalidated by the ordering
// rule below, never by cancelling the transport.
// ---------------------------------------------------------------------------

/** Thrown by {@link withTimeout} when the underlying promise did not settle in time. */
export class TimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Await `p`, but reject after `ms` if it has not settled. The underlying promise
 * keeps running (the bridge cannot cancel it) — callers pair this with an
 * {@link ObservationFeed} token so a late resolution becomes a no-op.
 */
export const withTimeout = async <T,>(p: Promise<T>, ms: number, what: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new TimeoutError(what, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/**
 * One feed of observations (meters, server status) with a SINGLE ordering rule
 * for every source — polls, pushed events, startup reads and retries:
 *
 * - The revision advances on every SEND and on every PUSHED event.
 * - A response may only apply while its send-revision is still the current one.
 *   An older poll resolving after a newer event is discarded; a newer send
 *   invalidates an older in-flight response; a retry supersedes the attempt
 *   that triggered it.
 * - A pushed event always wins (it advances the revision), because it is the
 *   backend's own word about its current state.
 *
 * `settleSuccess`/`settleFailure` return false when the token was already
 * invalidated (superseded or timed out), so a late response can never be
 * presented as a fresh observation.
 */
export class ObservationFeed<T> {
  private rev = 0;
  /** In-flight tokens → the revision each was sent at. */
  private live = new Map<number, number>();
  private nextToken = 1;

  constructor(
    /** Applies a settled, still-authoritative reading (caller updates the Observation). */
    private readonly onApply: (value: T, at: number, unchanged: boolean) => void,
  ) {}

  /**
   * Send one request. Returns a token to settle it with, or null when a request
   * is already in flight (skipping the tick keeps intervals from accumulating
   * unbounded concurrent requests). `force` is for one-shot reads (startup,
   * manual retry, visibility) that must go out even alongside a poll.
   */
  beginRequest(force = false): number | null {
    if (!force && this.live.size > 0) return null;
    const token = this.nextToken++;
    this.live.set(token, ++this.rev);
    return token;
  }

  /** A successful response: applies it if the token still stands. The token's
      lifecycle ends on EVERY settle — superseded or not — or it would leak and
      wedge the feed's 1-in-flight bound forever. */
  settleSuccess(token: number, value: T, at: number, unchanged: boolean): boolean {
    const sentRev = this.live.get(token);
    this.live.delete(token);
    if (sentRev !== this.rev) return false;
    this.onApply(value, at, unchanged);
    return true;
  }

  /** A failed (or timed-out) response: the token is released either way, so a late
      resolution after it is a no-op. */
  settleFailure(token: number, at: number): boolean {
    const sentRev = this.live.get(token);
    this.live.delete(token);
    void at;
    return sentRev === this.rev;
  }

  /** A pushed event: always authoritative, invalidates every in-flight request. */
  pushEvent(value: T, at: number, unchanged: boolean): void {
    ++this.rev;
    this.onApply(value, at, unchanged);
  }

  /** How many requests are in flight (test/telemetry hook). */
  get inFlight(): number {
    return this.live.size;
  }
}

/**
 * A published view of one feed's phase, computed from the CLOCK, not from
 * request completions: this is what the 1-second watchdog re-publishes so a
 * reading expires while requests hang. `stamp` is the visible last-updated
 * text; a tick that changes no visible text produces a view equal to the
 * previous one, so the publisher can skip the rerender entirely.
 */
export interface PhaseView {
  phase: ObservationPhase;
  /** The observation time the phase was computed from (drives the stamp). */
  at: number;
  /** The visible last-updated text; empty while fresh (nothing shows a stamp). */
  stamp: string;
}

export const phaseView = (
  obs: Pick<Observation<unknown>, "value" | "observedAt" | "failures" | "everOk">,
  now: number = Date.now(),
  companionDown = false,
): PhaseView => {
  const phase = observationPhase(obs, now, companionDown);
  if (phase === "fresh") return { phase, at: 0, stamp: "" };
  return { phase, at: obs.observedAt, stamp: lastUpdatedText(obs.observedAt, now) };
};

/** A published view is worth a rerender only when something visible changes. */
export const phaseViewSame = (a: PhaseView, b: PhaseView): boolean =>
  a.phase === b.phase && a.at === b.at && a.stamp === b.stamp;
