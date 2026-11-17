import type { CatalogEntry } from "../shared/types";
import { ref } from "./catalog";
import { canonicalName } from "./geniex";

/** One model of `geniex list --format json`. */
export interface InstalledGeniexModel {
  name: string;
  size: number | null;
  runtime: string;
  type: string;
  precisions: string[];
}

/** The models GenieX holds, read from its JSON list; anything else reads as nothing. */
export function parseInstalledJson(out: string): InstalledGeniexModel[] {
  let data: unknown;
  try { data = JSON.parse(out); } catch { return []; }
  if (!Array.isArray(data)) return [];
  return data.flatMap((m) => {
    if (!m || typeof m.name !== "string" || !m.name.includes("/")) return [];
    return [{
      name: m.name,
      size: typeof m.size === "number" && m.size > 0 ? m.size : null,
      runtime: String(m.runtime ?? ""),
      type: String(m.type ?? ""),
      precisions: Array.isArray(m.precisions) ? m.precisions.filter((p: unknown): p is string => typeof p === "string") : [],
    }];
  });
}

const CHAT_TYPES = new Set(["llm", "vlm"]);

const prettyName = (repo: string) => repo.split("/").pop()!.replace(/-GGUF$/i, "").replace(/^[A-Za-z]+_(?=[A-Z])/, "");

/**
 * An entry for every chat model installed in GenieX that no other entry names (catalog, packs, custom),
 * so a model installed outside the app is listed too. Its engine and size are GenieX's own answer; where it
 * runs is left to the load test, like any model the app does not know.
 */
export function installedOnlyEntries(installed: InstalledGeniexModel[], known: CatalogEntry[]): CatalogEntry[] {
  const names = new Set<string>();
  for (const e of known) { names.add(canonicalName(ref(e))); names.add(canonicalName(e.repo)); }
  const out: CatalogEntry[] = [];
  for (const m of installed) {
    if (!CHAT_TYPES.has(m.type)) continue;
    const qairt = m.runtime === "qairt";
    const quant = qairt ? null : (m.precisions[0] ?? null);
    const asRef = quant ? `${m.name}:${quant}` : m.name;
    if (names.has(canonicalName(asRef)) || names.has(canonicalName(m.name))) continue;
    names.add(canonicalName(asRef));
    out.push({
      id: `installed:${asRef.toLowerCase()}`, name: prettyName(m.name), repo: m.name, quant,
      engine: qairt ? "qairt" : "llama_cpp", role: m.type === "vlm" ? "Chat with pictures" : "Chat",
      architecture: "unknown", sizeGB: m.size ? Math.round((m.size / 1e9) * 100) / 100 : 0,
      recommendedContext: 4096, sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 2048 },
    });
  }
  return out;
}
