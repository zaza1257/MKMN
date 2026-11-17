/**
 * Evidence, staleness and tier choice — the pure half of the model manifest.
 * The artifact scan and the evidence file live in Rust (`model_manifest.rs`,
 * surfaced through `modelEvidence()`); everything the renderer DECIDES about
 * them lives here, so the rules are testable without a cache or a store.
 *
 * The five evidence kinds replace the vague "tested"/"verified" words: a badge
 * exists ONLY where a record of the matching kind exists, and a record from
 * another machine, another runtime or an older artifact revision reads as
 * STALE — shown with its history, never as current verification. Nothing is
 * inferred from a model's name: the manifest entry carries what the artifact's
 * own metadata declares.
 */

/** The five evidence kinds, pinned by the Rust store (`EVIDENCE_KINDS`). */
export type EvidenceKind =
  | "download-verified"
  | "compatible-metadata"
  | "loaded-on-device"
  | "quality-evaluated"
  | "performance-measured";

export const EVIDENCE_KINDS: EvidenceKind[] = [
  "download-verified",
  "compatible-metadata",
  "loaded-on-device",
  "quality-evaluated",
  "performance-measured",
];

/** The specific, checkable claim each kind stands for. */
export const EVIDENCE_LABELS: Record<EvidenceKind, string> = {
  "download-verified": "Files present",
  "compatible-metadata": "Compatible metadata",
  "loaded-on-device": "Loaded on this device",
  "quality-evaluated": "Quality evaluated",
  "performance-measured": "Performance measured",
};

/** What a record of this kind actually asserts (badge tooltips). */
export const EVIDENCE_HINTS: Record<EvidenceKind, string> = {
  "download-verified": "The artifact is present in the cache — the download reported complete (or the inventory lists it). Files are not hash-checked, so a truncated download would not be caught here.",
  "compatible-metadata": "The artifact's own metadata declares support for this chipset, runtime and precision.",
  "loaded-on-device": "The artifact was loaded and served on THIS PC — a server came ready and answered.",
  "quality-evaluated": "The artifact's answers were scored on a fixed task suite on THIS PC.",
  "performance-measured": "Speed, latency and memory were measured on THIS PC.",
};

/** One evidence record (the Rust `EvidenceRecord`, camelCase on the wire). */
export interface EvidenceRecord {
  /** Upsert key: `{kind}:{ref}` (with an optional suite segment). */
  id: string;
  kind: EvidenceKind | string;
  /** The canonical artifact ref the evidence is about. */
  ref: string;
  /** RFC3339 timestamp of when the evidence was produced. */
  asOf: string;
  /** Machine summary the evidence was produced on. */
  machine: string;
  /** Runtime version the evidence was produced with. */
  runtimeVersion: string;
  config?: unknown;
  result?: unknown;
}

/** One artifact in the cache, as its OWN metadata declares it (the Rust scan). */
export interface ArtifactManifestEntry {
  ref: string;
  plugin: string;
  modelType?: string | null;
  precisions: string[];
  mmprojFile?: string | null;
  totalBytes: number;
  /** Newest file mtime (epoch ms) — the revision surrogate (no checksums exist). */
  revision?: number | null;
  compiledContext?: number | null;
  contextLengths: number[];
  supportsThinking?: boolean | null;
  chipset?: unknown;
  compileToolVersions?: unknown;
  useCase?: string | null;
}

/** What "this device" and "this runtime" mean right now, for staleness. */
export interface EvidenceContext {
  /** The machine summary of the CURRENT PC (e.g. from the hardware profile). */
  machine: string;
  /** The runtime version currently installed. */
  runtimeVersion: string;
}

/** The state of one evidence kind for one artifact on this device. */
export type EvidenceState =
  | { state: "present"; record: EvidenceRecord }
  | { state: "stale"; record: EvidenceRecord; reason: string }
  | { state: "absent" };

/**
 * Is a record still current on THIS device? Stale when:
 * - it was produced on a different machine (all kinds — a result from a
 *   Snapdragon X Plus must never read as X2 Elite verification), or
 * - the runtime version changed (all kinds — a new runtime can change
 *   compatibility, speed and answers alike), or
 * - it was produced for a different artifact revision/size (the artifact
 *   changed under the same ref).
 */
export function evidenceState(
  record: EvidenceRecord | undefined,
  ctx: EvidenceContext,
  artifact?: Pick<ArtifactManifestEntry, "totalBytes" | "revision">,
): EvidenceState {
  if (!record) return { state: "absent" };
  if (normalizeMachine(record.machine) !== normalizeMachine(ctx.machine)) {
    return { state: "stale", record, reason: `Measured on ${record.machine}` };
  }
  if (record.runtimeVersion && ctx.runtimeVersion && record.runtimeVersion !== ctx.runtimeVersion) {
    return { state: "stale", record, reason: `Measured with runtime ${record.runtimeVersion}` };
  }
  const result = (record.result ?? {}) as { totalBytes?: number; revision?: number };
  if (artifact && result.totalBytes != null && result.totalBytes !== artifact.totalBytes) {
    return { state: "stale", record, reason: "The artifact changed since it was measured (size differs)" };
  }
  if (artifact && result.revision != null && artifact.revision != null && result.revision !== artifact.revision) {
    return { state: "stale", record, reason: "The artifact changed since it was measured (revision differs)" };
  }
  return { state: "present", record };
}

/** Machine strings differ in spacing/punctuation; compare the words. */
const normalizeMachine = (s: string) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/**
 * The canonical artifact-ref comparison key: lower-case, the legacy
 * `ai-hub-models/` publisher mapped to the cache's `qualcomm/`. The precision
 * suffix (`:Q4_0`, `:W4A16`) is deliberately KEPT: Q4_0 and Q8_0 of the same
 * repo are different artifacts (different files, different speed and memory,
 * measured answers of one say nothing about the other), so collapsing them
 * let one quant's evidence vouch for another.
 */
export function canonArtifactRef(s: string): string {
  return String(s ?? "").trim().toLowerCase().replace(/^ai-hub-models\//, "qualcomm/");
}

/** The repository-level base of a ref (its precision suffix dropped, and the
 * catalog's `-GGUF` repo-name suffix, which the cache dirs may or may not
 * repeat, normalized). Only for "which build of this repo is this" checks —
 * never as the identity evidence is pinned to. */
function canonArtifactBase(s: string): string {
  return canonArtifactRef(s).replace(/:[^:]*$/, "").replace(/-gguf$/, "");
}

/** The manifest ref a ref resolves to: the exact identity first; a ref WITHOUT
 * a precision (a catalog entry) matches the cache's ONLY build of that base,
 * never one of two ambiguous ones; a ref WITH a precision also resolves through
 * a REPO-LEVEL manifest entry (whose ref carries no precision) when that entry's
 * `precisions` positively declare the asked-for precision and the base is
 * unambiguous — a precision the entry does not declare is a different artifact
 * than anything the manifest vouches for, and stays unresolved (C03). */
export function manifestRefFor(
  ref: string,
  manifest: Array<Pick<ArtifactManifestEntry, "ref" | "precisions">>,
): string | undefined {
  const want = canonArtifactRef(ref);
  const refs = manifest.map((m) => m.ref);
  const exact = refs.find((r) => canonArtifactRef(r) === want);
  if (exact) return exact;
  const bases = refs.filter((r) => canonArtifactBase(r) === canonArtifactBase(want));
  if (!want.includes(":")) {
    return bases.length === 1 ? bases[0] : undefined;
  }
  const precision = want.slice(want.indexOf(":") + 1).toLowerCase();
  const declares = (r: string) => {
    const entry = manifest.find((m) => m.ref === r);
    return !!entry && entry.precisions.map((p) => String(p).toLowerCase()).includes(precision);
  };
  // A per-quant entry (its own ref carries the precision) IS the artifact; the
  // repo name's optional -GGUF suffix is why the exact match above missed it.
  const quantEntries = bases.filter((r) => canonArtifactRef(r).endsWith(`:${precision}`));
  if (quantEntries.length >= 1) return quantEntries[0];
  // Otherwise only a repo-level entry that DECLARES this precision vouches for
  // it, and only when it is the unambiguous base.
  const repoEntries = bases.filter((r) => !canonArtifactRef(r).includes(":") && declares(r));
  return repoEntries.length === 1 ? repoEntries[0] : undefined;
}

/** The latest record of a kind for a ref. An exact identity match wins; a
 * precision-less ask falls back to the records' only build of that base, so
 * distinct quantizations never share evidence. */
export function recordFor(records: EvidenceRecord[], ref: string, kind: EvidenceKind): EvidenceRecord | undefined {
  const want = canonArtifactRef(ref);
  const latest = (rs: EvidenceRecord[]): EvidenceRecord | undefined =>
    rs.reduce<EvidenceRecord | undefined>((best, r) => (!best || r.asOf > best.asOf ? r : best), undefined);
  const exact = latest(records.filter((r) => r.kind === kind && canonArtifactRef(r.ref) === want));
  if (exact) return exact;
  if (!want.includes(":")) {
    const sameBase = records.filter((r) => r.kind === kind && canonArtifactBase(r.ref) === canonArtifactBase(want));
    const spellings = new Set(sameBase.map((r) => canonArtifactRef(r.ref)));
    if (spellings.size === 1) return latest(sameBase);
  }
  return undefined;
}

/** All five kinds for one artifact, in display order. */
export function evidenceStates(records: EvidenceRecord[], ref: string, ctx: EvidenceContext, artifact?: Pick<ArtifactManifestEntry, "totalBytes" | "revision">): Array<{ kind: EvidenceKind; state: EvidenceState }> {
  return EVIDENCE_KINDS.map((kind) => ({ kind, state: evidenceState(recordFor(records, ref, kind), ctx, artifact) }));
}

// ---------------------------------------------------------------------------
// Tiers: Efficiency / Balanced / Quality — an explicit choice, never "biggest
// that fits"
// ---------------------------------------------------------------------------

export type TierId = "efficiency" | "balanced" | "quality";

export interface Tier {
  id: TierId;
  label: string;
  /** What the tier is FOR, so the choice is about the task, not the size. */
  purpose: string;
  /** paramsB bounds (inclusive lower, exclusive upper; quality has no upper). */
  minB: number;
  maxB?: number;
}

export const TIERS: Tier[] = [
  { id: "efficiency", label: "Efficiency", purpose: "Instant replies, drafts, the smallest model that answers well", minB: 0, maxB: 2.5 },
  { id: "balanced", label: "Balanced", purpose: "Everyday work: good answers at a responsive speed", minB: 2.5, maxB: 5.5 },
  { id: "quality", label: "Quality", purpose: "Harder tasks where answer quality matters more than speed", minB: 5.5 },
];

export function tierOfParams(paramsB: number | undefined | null): TierId | null {
  const b = Number(paramsB);
  if (!Number.isFinite(b) || b <= 0) return null;
  const tier = TIERS.find((t) => b >= t.minB && (t.maxB === undefined || b <= t.maxB));
  return tier?.id ?? null;
}

export interface TierChoice {
  tier: TierId;
  /** Smallest-first within the tier: the default candidate is FIRST. */
  candidates: Array<{
    ref: string;
    name: string;
    plugin: string;
    precisions: string[];
    paramsB?: number | null;
    totalBytes: number;
    /** The weakest current evidence, so "provisional" is visible, not hidden. */
    provisional: boolean;
    provisionalReason?: string;
    states: Array<{ kind: EvidenceKind; state: EvidenceState }>;
  }>;
  /** True when NO candidate in this tier has quality evidence here. */
  provisional: boolean;
}

const qualityStateOf = (states: Array<{ kind: EvidenceKind; state: EvidenceState }>) =>
  states.find((s) => s.kind === "quality-evaluated")?.state;

/**
 * Groups manifest entries that hold a params estimate into the three tiers,
 * smallest-first. A choice is provisional when its tier has no
 * quality-evaluated-here record — the label says so instead of implying a
 * recommendation was earned by measurement.
 */
export function tierChoices(
  entries: Array<Pick<ArtifactManifestEntry, "ref" | "plugin" | "precisions" | "totalBytes"> & { name?: string; paramsB?: number | null; revision?: number | null }>,
  records: EvidenceRecord[],
  ctx: EvidenceContext,
): Record<TierId, TierChoice> {
  const out = {} as Record<TierId, TierChoice>;
  for (const t of TIERS) {
    out[t.id] = { tier: t.id, candidates: [], provisional: true };
  }
  for (const entry of entries) {
    const tierId = tierOfParams(entry.paramsB);
    if (!tierId) continue;
    // A sizeless entry (no manifest match yet) cannot be contradicted by a
    // record's size: staleness by artifact change only applies with real bytes.
    const artifact = entry.totalBytes > 0 ? entry : undefined;
    const states = evidenceStates(records, entry.ref, ctx, artifact);
    const quality = qualityStateOf(states);
    // Speed measured here does not vouch for quality: only a CURRENT
    // quality-evaluated record lifts the provisional flag.
    const provisional = quality?.state !== "present";
    const provisionalReason = quality?.state === "stale" ? quality.reason : undefined;
    out[tierId].candidates.push({
      ref: entry.ref,
      name: entry.name ?? entry.ref,
      plugin: entry.plugin,
      precisions: entry.precisions,
      paramsB: entry.paramsB ?? null,
      totalBytes: entry.totalBytes,
      provisional,
      provisionalReason,
      states,
    });
    if (!provisional) out[tierId].provisional = false;
  }
  for (const t of TIERS) {
    out[t.id].candidates.sort((a, b) => (a.paramsB ?? Infinity) - (b.paramsB ?? Infinity) || a.ref.localeCompare(b.ref));
  }
  return out;
}

/**
 * The recommended default: the SMALLEST candidate that meets the quality
 * threshold — a quality-evaluated record produced on this device whose pass
 * ratio reaches `qualityPassRatio` (default 0.8 of the suite's checks). Returns
 * the ref, or null with the reason: never a "biggest that fits" pick, never a
 * silent guess. A record that exists but scores below the bar does NOT qualify
 * — "evaluated" and "good enough" are different claims.
 */
export function recommendedDefault(
  entries: Array<Pick<ArtifactManifestEntry, "ref" | "plugin" | "precisions" | "totalBytes"> & { name?: string; paramsB?: number | null; revision?: number | null }>,
  records: EvidenceRecord[],
  ctx: EvidenceContext,
  o?: { qualityPassRatio?: number },
): { ref: string; name: string; tier: TierId } | { ref: null; reason: string } {
  const threshold = o?.qualityPassRatio ?? 0.8;
  let evaluatedButBelow: { name: string; passed: number; total: number } | null = null;
  for (const tier of TIERS) {
    const choice = tierChoices(entries, records, ctx)[tier.id];
    for (const c of choice.candidates) {
      const st = c.states.find((s) => s.kind === "quality-evaluated");
      if (!st || st.state.state !== "present") continue;
      const r = (st.state.record.result ?? {}) as { passed?: number; total?: number };
      // Fail closed: scores that are missing or malformed (empty result objects,
      // a passed count outside its total, no questions at all) never qualify —
      // "we could not read the score" is not "the score passed".
      const valid = Number.isFinite(r.passed) && Number.isFinite(r.total)
        && (r.total as number) > 0 && (r.passed as number) >= 0 && (r.passed as number) <= (r.total as number);
      if (!valid) continue;
      const ratio = (r.passed as number) / (r.total as number);
      if (ratio >= threshold) return { ref: c.ref, name: c.name, tier: tier.id };
      // evaluated here, but under the bar: keep the SMALLEST such model for the reason
      if (!evaluatedButBelow) evaluatedButBelow = { name: c.name, passed: r.passed as number, total: r.total as number };
    }
  }
  return {
    ref: null,
    reason: evaluatedButBelow
      ? `The smallest evaluated model (${evaluatedButBelow.name}) scored ${evaluatedButBelow.passed}/${evaluatedButBelow.total} here — under the ${Math.round(threshold * 100)}% quality bar — and no larger model below it qualifies either. The default stays provisional: pick one in Models, or re-run the evaluation.`
      : "No model has been quality-evaluated on this device yet. The default stays provisional: pick one in Models, or run the evaluation first.",
  };
}
