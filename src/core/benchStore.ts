import { normalizeName } from "./foundry";

/**
 * Local benchmark measurements, and what a model card may say about them.
 *
 * The single-model benchmark (Settings → Diagnostics) persists one run per model and
 * compute/power configuration in `Config/hardware.json` under `calibratedProfiles`,
 * written by the Rust host after every SUCCESSFUL run — a failed or cancelled run
 * returns before any write, so existing measurements survive it by construction.
 *
 * This module is the pure logic between that file and the model list: parsing,
 * matching a catalog item to its stored profile (by stable model references, never by
 * display name), WHICH run displays, how stale a measurement may be, and the exact
 * wording of the claims. The wording stays below the evidence: a chip says where and
 * when a number was measured, "verified NPU" is only ever said of a run that recorded
 * supporting evidence, and quality scores are a different system entirely (a speed
 * benchmark never creates or alters one).
 */

/** One stored run of the single-model benchmark (the shape bench.rs writes). */
export interface BenchRunRecord {
  /** The compute target the run actually used ("npu", "hybrid", "gpu", "cpu"). */
  compute: string;
  powerMode: string;
  decodeTokPerSec: number;
  /** Milliseconds to the first token, when the run's telemetry gave a real one.
   *  A missing or impossible (≤ 0) figure is null — never 0, which would display
   *  a missing measurement as "first token in 0 ms". */
  ttftMs: number | null;
  tokensGenerated: number;
  maxTokens: number;
  ngl: number;
  nctx: number;
  /** True only when the run recorded supporting evidence (counters or affirmative device lines). */
  verifiedNpu: boolean;
  /** ISO timestamp written by the host at measurement time. */
  measuredAt: string;
}

export interface BenchProfile {
  /** Keyed "<compute>|<powerMode>" — configurations stay distinguishable. */
  runs: Record<string, BenchRunRecord>;
}

export const COMPUTE_LABELS: Record<string, string> = {
  npu: "NPU",
  hybrid: "CPU + NPU",
  gpu: "GPU",
  cpu: "CPU",
};

export const POWER_LABELS: Record<string, string> = {
  burst: "Burst",
  sustained_high_performance: "Sustained",
  power_saver: "Power Saver",
  default: "Default",
};

const computeLabel = (c: string): string => COMPUTE_LABELS[c] ?? c;
export const powerLabel = (p: string): string => POWER_LABELS[p] ?? p;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Validates one stored run: an unusable record (no compute, no positive finite speed,
 *  no parseable date) is never displayed. */
export function parseBenchRun(raw: unknown): BenchRunRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const compute = typeof r.compute === "string" && r.compute ? r.compute : null;
  const speed = num(r.decodeTokPerSec);
  const ttft = num(r.ttftMs);
  const measuredAt = typeof r.measuredAt === "string" ? r.measuredAt : null;
  if (!compute || speed === null || speed <= 0 || !measuredAt) return null;
  if (Number.isNaN(Date.parse(measuredAt))) return null;
  return {
    compute,
    powerMode: typeof r.powerMode === "string" ? r.powerMode : "",
    decodeTokPerSec: speed,
    ttftMs: ttft !== null && ttft > 0 ? ttft : null,
    tokensGenerated: num(r.tokensGenerated) ?? 0,
    maxTokens: num(r.maxTokens) ?? 0,
    ngl: num(r.ngl) ?? -1,
    nctx: num(r.nctx) ?? 0,
    verifiedNpu: r.verifiedNpu === true,
    measuredAt,
  };
}

/** Parses the whole `hardware.json` view: only models with at least one usable run appear. */
export function parseBenchProfiles(config: unknown): Record<string, BenchProfile> {
  if (!config || typeof config !== "object") return {};
  const profiles = (config as Record<string, unknown>).calibratedProfiles;
  if (!profiles || typeof profiles !== "object") return {};
  const out: Record<string, BenchProfile> = {};
  for (const [ref, profile] of Object.entries(profiles as Record<string, unknown>)) {
    const runsRaw = (profile as Record<string, unknown> | null)?.runs;
    if (!runsRaw || typeof runsRaw !== "object") continue;
    const runs: Record<string, BenchRunRecord> = {};
    for (const [k, v] of Object.entries(runsRaw as Record<string, unknown>)) {
      const parsed = parseBenchRun(v);
      if (parsed) runs[k] = parsed;
    }
    if (Object.keys(runs).length > 0) out[ref] = { runs };
  }
  return out;
}

/**
 * The stable identity of a catalog item for matching a stored measurement: the item's
 * own reference and the catalog entry's id (and repo, when present) — exactly the refs
 * the benchmark was run and stored under. Never the display name: two models can share
 * a name, and a renamed model keeps its measurements.
 */
export function benchRefsFor(item: { ref: string; entry: { id: string; repo?: string; foundryBuild?: string } }): string[] {
  // a Foundry Local row stands for one build at a time: only that build's measurements are its own
  if (item.entry.foundryBuild) return [item.entry.foundryBuild];
  const refs = new Set<string>([item.ref, item.entry.id]);
  if (item.entry.repo) refs.add(item.entry.repo);
  return [...refs];
}

/** The stored profile for a catalog item, if any. */
export function benchProfileFor(profiles: Record<string, BenchProfile> | null | undefined, refs: string[]): BenchProfile | null {
  if (!profiles) return null;
  for (const ref of refs) {
    const p = profiles[ref];
    if (p) return p;
  }
  return null;
}

export interface BenchSelection {
  run: BenchRunRecord;
  /** The "<compute>|<power>" key the run is stored under. */
  runKey: string;
  /** Why this run shows: it matches the current compute target, or it is simply the newest. */
  basis: "current-compute" | "latest";
}

/**
 * WHICH run displays: the newest measurement for the CURRENT compute target when one
 * exists, otherwise the newest run of any target. Never the fastest historical run —
 * a speed number is a per-configuration fact, and picking the fastest would present a
 * chosen optimum as current performance. Ties are broken by storage order (last write
 * wins), which matches how the host overwrites a re-measured configuration.
 */
export function selectBenchRun(profile: BenchProfile | null | undefined, preferredCompute?: string): BenchSelection | null {
  if (!profile) return null;
  const entries = Object.entries(profile.runs);
  if (entries.length === 0) return null;
  const latest = (list: [string, BenchRunRecord][]): [string, BenchRunRecord] =>
    list.reduce((a, b) => (Date.parse(b[1].measuredAt) >= Date.parse(a[1].measuredAt) ? b : a));
  if (preferredCompute) {
    const matching = entries.filter(([, r]) => r.compute === preferredCompute);
    if (matching.length > 0) {
      const [runKey, run] = latest(matching);
      return { run, runKey, basis: "current-compute" };
    }
  }
  const [runKey, run] = latest(entries);
  return { run, runKey, basis: "latest" };
}

/** A measurement older than this is flagged as potentially outdated, not hidden. */
export const BENCH_MAX_AGE_DAYS = 90;

/** Why the shown run may no longer describe the current setup (shown, never hidden). */
export function benchOutdatedReasons(run: BenchRunRecord, ctx: { preferredCompute?: string; now?: Date } = {}): string[] {
  const out: string[] = [];
  const ageDays = ((ctx.now ?? new Date()).getTime() - Date.parse(run.measuredAt)) / 86_400_000;
  if (ageDays > BENCH_MAX_AGE_DAYS) out.push(`measured ${Math.round(ageDays)} days ago`);
  if (ctx.preferredCompute && run.compute !== ctx.preferredCompute) {
    out.push(`measured on ${computeLabel(run.compute)}, not the current ${computeLabel(ctx.preferredCompute)} target`);
  }
  return out;
}

/** The compact line beside the model name. */
export function benchHeadline(run: BenchRunRecord): string {
  return `Measured here · ${run.decodeTokPerSec.toFixed(1)} tok/s · ${computeLabel(run.compute)}`;
}

/** The accessible detail lines: what was measured, on what, when, and how well attested. */
export function benchDetailLines(run: BenchRunRecord): string[] {
  return [
    `${run.decodeTokPerSec.toFixed(1)} tok/s decode speed, measured on this PC`,
    // the same wording the adaptive-compute view uses: a missing measurement is said,
    // never shown as 0 ms (a first token cannot arrive in 0 s)
    run.ttftMs === null ? "first token: not measured" : `first token in ${Math.round(run.ttftMs)} ms`,
    `compute target: ${computeLabel(run.compute)}`,
    `power mode: ${powerLabel(run.powerMode)}`,
    `measured ${run.measuredAt.slice(0, 10)}`,
    run.verifiedNpu
      ? "NPU execution was verified for this run (performance counters or the runtime's own device lines)"
      : "NPU execution was NOT verified by counters or log for this run",
  ];
}

// ---------------------------------------------------------------- the benchmark suite's runs

/** What a finished benchmark-suite result needs to become a run record (a ModelResult, structurally). */
export interface SuiteResultLike {
  key?: string;
  ref: string;
  /** The build the engine actually served (Foundry Local names it when it loads). */
  servedModel?: string;
  error?: string | null;
  backend?: string;
  servedContext?: number | null;
  placement?: { runsOn: string } | null;
  speedTrack?: { medianTokPerSec: number | null } | null;
  summary?: { tokPerSec: number | null; ttftSec: number | null } | null;
}

const SUITE_COMPUTE: Record<string, string> = { npu: "npu", mixed: "hybrid", cpu: "cpu" };

/**
 * A benchmark-suite result as the run the single-model benchmark writes, keyed by the exact build it
 * tested (for Foundry Local, the build it served, never the alias), or null when the suite did not measure
 * both a device and a speed. The speed is the one the report shows; the controlled track's stands in when
 * the report has none. The suite does not pick a
 * power mode, so the run says "default", and it never claims a verified NPU (that needs counters).
 */
export function suiteRunRecord(r: SuiteResultLike): { modelRef: string; run: Record<string, unknown> } | null {
  if (r.error || !r.ref) return null;
  const compute = SUITE_COMPUTE[r.placement?.runsOn ?? ""];
  const speed = num(r.summary?.tokPerSec) ?? num(r.speedTrack?.medianTokPerSec);
  if (!compute || speed === null || speed <= 0) return null;
  const ttft = num(r.summary?.ttftSec);
  return {
    modelRef: r.key?.startsWith("foundry:") && r.servedModel ? r.servedModel : r.ref,
    run: {
      compute, powerMode: "default", decodeTokPerSec: speed,
      ttftMs: ttft !== null && ttft > 0 ? Math.round(ttft * 1000) : null,
      tokensGenerated: 0, maxTokens: 0, ngl: -1, nctx: num(r.servedContext) ?? 0,
      verifiedNpu: false,
    },
  };
}

/** The family two builds of one model share: the pairing the Models list itself uses (`modelKey`). */
const familyOf = (name: string) => normalizeName(name.replace(/\s*\(Foundry Local\)/i, ""));
const isFoundryRow = (id: string) => id.startsWith("foundry:");

type Row = { ref: string; entry: { id: string; name?: string; repo?: string; foundryBuild?: string } };

/**
 * For a GenieX row with no measurement of its own: the measured run of the Foundry Local build of the
 * same model, labelled as that variant's so it is never read as the GenieX build's own speed.
 */
export function relatedVariantRun(row: Row, rows: Row[], profiles: Record<string, BenchProfile> | null | undefined): { run: BenchRunRecord; label: string } | null {
  if (isFoundryRow(row.entry.id) || !row.entry.name) return null;
  if (benchProfileFor(profiles, benchRefsFor(row))) return null;
  const family = familyOf(row.entry.name);
  for (const other of rows) {
    if (!isFoundryRow(other.entry.id) || !other.entry.name || familyOf(other.entry.name) !== family) continue;
    const sel = selectBenchRun(benchProfileFor(profiles, benchRefsFor(other)));
    if (sel) return { run: sel.run, label: `Foundry Local variant · ${sel.run.decodeTokPerSec.toFixed(1)} tok/s · ${computeLabel(sel.run.compute)}` };
  }
  return null;
}
