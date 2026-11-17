import type { CatalogEntry } from "../shared/types";
import type { EvidenceRecord } from "./manifest";

/**
 * Measured generation speeds, by catalog id, from the two records the app keeps
 * about models it ACTUALLY timed on this machine:
 *  - the chat EMA (`speeds.json`, keyed by catalog id): repeated, smoothed, the freshest;
 *  - the benchmark evidence (`performance-measured`, keyed by model ref): one run per model.
 * The chat EMA wins where both exist. A model this machine never timed is simply
 * absent — the caller must not show an invented figure.
 */
export function speedsById(
  chatEma: Record<string, number>,
  evidence: EvidenceRecord[],
  entries: CatalogEntry[],
  entryMatches: (e: CatalogEntry, want: string) => boolean,
  entryRefOf: (e: CatalogEntry) => string
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [id, tps] of Object.entries(chatEma ?? {})) {
    if (typeof tps === "number" && Number.isFinite(tps) && tps > 0) out[id] = tps;
  }
  for (const rec of Array.isArray(evidence) ? evidence : []) {
    if (rec.kind !== "performance-measured" || !rec.ref) continue;
    // the stored result carries the measured run (see recordSpeed in the sidecar)
    const result = (rec.result ?? {}) as { tokPerSec?: unknown; tokens?: unknown };
    const tps = result.tokPerSec;
    if (typeof tps !== "number" || !Number.isFinite(tps) || tps <= 0) continue;
    const e = entries.find((x) => entryRefOf(x) === rec.ref || entryMatches(x, rec.ref));
    if (e && out[e.id] === undefined) out[e.id] = tps;
  }
  return out;
}
