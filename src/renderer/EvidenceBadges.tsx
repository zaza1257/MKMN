import {
  EVIDENCE_KINDS, EVIDENCE_LABELS, EVIDENCE_HINTS, evidenceStates, manifestRefFor,
  type ArtifactManifestEntry, type EvidenceContext, type EvidenceRecord, type EvidenceState,
} from "../core/manifest";

/**
 * The five evidence badges, in place of the old vague "tested"/"verified" words.
 * A badge appears ONLY when a matching evidence record exists; a record from
 * another machine, another runtime or an older artifact revision renders dimmed
 * with the reason. Kinds with no record are summarized in one line, so absence
 * is stated instead of implied.
 */

const CLASS: Record<string, string> = {
  "download-verified": "ev-download",
  "compatible-metadata": "ev-metadata",
  "loaded-on-device": "ev-loaded",
  "quality-evaluated": "ev-quality",
  "performance-measured": "ev-perf",
};

export function EvidenceBadges({ ref, manifest, records, ctx }: {
  ref: string;
  manifest: ArtifactManifestEntry[];
  records: EvidenceRecord[];
  ctx: EvidenceContext;
}) {
  const manifestRef = manifestRefFor(ref, manifest);
  const entry = manifest.find((m) => m.ref === manifestRef);
  const states = evidenceStates(records, manifestRef ?? ref, ctx, entry);
  const present = states.filter((s) => s.state.state === "present");
  const stale = states.filter((s) => s.state.state === "stale");
  const absent = states.filter((s) => s.state.state === "absent").map((s) => s.kind);
  return (
    <span className="ev-badges" role="list" aria-label="Evidence">
      {present.map(({ kind, state }) =>
        state.state === "present" && (
          <span key={kind} role="listitem" className={`badge ev ${CLASS[kind]}`} title={`${EVIDENCE_HINTS[kind]} (recorded ${state.record.asOf})`}>
            {EVIDENCE_LABELS[kind]}
          </span>
        ))}
      {stale.map(({ kind, state }) =>
        state.state === "stale" && (
          <span key={kind} role="listitem" className="badge ev stale" title={`${EVIDENCE_LABELS[kind]}: ${state.reason}. It must be re-established here before it counts.`}>
            {EVIDENCE_LABELS[kind]} — {state.reason}
          </span>
        ))}
      {present.length === 0 && stale.length === 0 && (
        <span className="badge ev none" title="No evidence record exists for this artifact yet. What is known is stated on its card; nothing is inferred.">
          {absent.length === EVIDENCE_KINDS.length ? "No evidence yet" : "Not established here"}
        </span>
      )}
    </span>
  );
}

/** One line of plain words: what the evidence says about this artifact overall. */
export function evidenceNote(states: Array<{ kind: string; state: EvidenceState }>): string | null {
  const loaded = states.find((s) => s.kind === "loaded-on-device")?.state;
  if (loaded?.state === "present") return "Loaded on this device.";
  if (loaded?.state === "stale") return `Loaded elsewhere only (${loaded.reason}).`;
  return null;
}
