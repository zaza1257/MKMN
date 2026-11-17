import type { CatalogEntry } from "../shared/types";
import { CATALOG, ref as entryRef } from "./catalog";
import { DYNAMIC_DATA } from "./dynamic-data";
import { isDynamicId, tierOf } from "./dynamic";

/** The canonical model name/ref: lower-cased, with the marketplace namespace
 * spelling collapsed to the cache spelling. Lives here (the pure identity
 * module) rather than in the node-only CLI wrapper, so the renderer's bundle
 * never drags node built-ins in through the identity resolver. */
export const canonicalName = (s: string) => s.trim().toLowerCase().replace(/^ai-hub-models\//, "qualcomm/");

/**
 * One model-identity resolver for the whole app — preload, chat, tests and
 * benchmarks must resolve an application alias to the SAME exact cache
 * reference (repository, revision, precision) before anything reaches
 * `geniex serve --model` or a completions call.
 *
 * This used to live only in the renderer's bridge (`resolveServeRef`): the
 * chat path resolved through `entryRef(entry)` instead, so the same alias
 * could serve a different spelling of the same model depending on the entry
 * point — an `ai-hub-models/...` catalog ref and a `qualcomm/...` cache name
 * are the same artifact, but the readiness probe must see the identity that
 * was actually requested. Resolution is now this one pure function; the
 * renderer and the sidecar each gather the same context and call it.
 *
 * Internal application ids (`custom:...`, `dynamic:<tier>`) are NEVER a
 * result: GenieX answers `SDKError(File not found or inaccessible), model
 * 'custom:...' not found in local cache` for them. An id that cannot be
 * resolved to a concrete cache-shaped ref comes back as a refusal with the
 * reason, so the caller can fail fast with a truthful message instead of
 * launching a server that cannot load.
 */

export interface ModelIdentityContext {
  /** Every selectable catalog entry (the shipped catalog). */
  catalogEntries?: CatalogEntry[];
  /** The user's saved custom entries (custom-models.json). */
  customEntries?: CatalogEntry[];
  /** The refs the GenieX cache actually holds (as the inventory reports them). */
  installedRefs?: string[];
  /** The Dynamic packs, by pack id ("2B", "4B", ...). Defaults to the shipped data. */
  packs?: Record<string, { models: { ref: string; name: string; repo: string; altRepos?: string[]; quant: string | null; altQuant?: string; foundryOnly?: boolean }[] }>;
}

export type ModelResolution =
  | { ok: true; /** The concrete cache-shaped reference to serve and to name in completions. */
      ref: string;
      /** The id that was asked for. */
      requested: string;
      /** How the identity was resolved — for logs and error attribution. */
      how: "installed-cache" | "catalog" | "custom-entry" | "dynamic-pack" | "as-asked" }
  | { ok: false; requested: string; reason: string };

const canon = (s: string) => canonicalName(String(s ?? ""));

/** The cache's namespace spelling of a repo ref, with its original case kept: this
 * maps the old `ai-hub-models/` publisher name onto the cache's `qualcomm/` and
 * leaves every other name byte-for-byte as it was asked for. */
const reNamespace = (s: string) => String(s ?? "").trim().replace(/^ai-hub-models\//i, "qualcomm/");

/** The cache spelling of a repo ref, without any precision suffix. */
const baseOf = (s: string) => canon(s).replace(/:[^:]*$/, "");

/** The pack id a model belongs to: a "dynamic:<tier>" id's tier, or the pack owning a pack-model ref. */
export function packIdOf(modelId: string, packs?: ModelIdentityContext["packs"]): string | undefined {
  const table = packs ?? DYNAMIC_DATA.packs;
  if (isDynamicId(modelId)) return tierOf(modelId);
  return Object.entries(table).find(([, p]) => p.models.some((m) => m.ref === modelId))?.[0];
}

/**
 * Resolves an application model id to the concrete cache reference.
 * Pure: every data source is a parameter (or the shipped default), so the
 * renderer, the sidecar and the tests run the exact same resolution.
 */
export function resolveModelIdentity(modelId: string, ctx: ModelIdentityContext = {}): ModelResolution {
  const id = String(modelId ?? "").trim();
  const catalog = ctx.catalogEntries ?? CATALOG;
  const customEntries = ctx.customEntries ?? [];
  const installed = ctx.installedRefs ?? [];
  const packs = ctx.packs ?? DYNAMIC_DATA.packs;
  if (!id) return { ok: false, requested: id, reason: "No model id was given." };

  const installedCanon = installed.map(canon);
  const installedHit = (wanted: string): string | undefined => {
    const w = canon(wanted);
    const i = installedCanon.indexOf(w);
    if (i >= 0) return installed[i];
    // No exact match: a wanted ref WITHOUT a precision (a catalog bundle entry has
    // none) matches the cache's only build of that base — a bigger quant of the same
    // model is a different artifact, so an ambiguous base stays unmatched.
    if (!w.includes(":")) {
      const matches = installed.filter((im) => baseOf(im) === baseOf(w));
      if (matches.length === 1) return matches[0];
    }
    return undefined;
  };

  const inCatalog = catalog.find((e) => e.id === id);
  // what the catalog entry (or the raw id itself) would ask for
  const requested = inCatalog ? entryRef(inCatalog) : id;

  // serve refs name installed models: an ai-hub-models/X entry serves the qualcomm/X
  // the cache actually holds (GenieX accepts both, but the served name is the one the
  // readiness probe and status must agree on)
  const cacheHit = installedHit(requested);
  if (cacheHit) return { ok: true, ref: cacheHit, requested: id, how: "installed-cache" };
  if (inCatalog) {
    // not installed: ask for the canonical spelling of the entry's ref, so the error
    // names a cache-shaped name in the cache's own namespace
    return { ok: true, ref: reNamespace(requested), requested: id, how: "catalog" };
  }

  // A saved custom entry, by id (the "custom:<repo>:<quant>" forms the app mints) —
  // checked before the raw-id fallbacks below so the entry's own repo/quant wins.
  const customEntry = customEntries.find((e) => String(e.id).toLowerCase() === id.toLowerCase());
  if (customEntry) {
    const wanted = entryRef(customEntry);
    const hit = installedHit(wanted);
    if (hit) return { ok: true, ref: hit, requested: id, how: "custom-entry" };
    // not installed: ask for the entry's ref, so the error names a real cache-shaped name
    return { ok: true, ref: reNamespace(wanted), requested: id, how: "custom-entry" };
  }

  const packId = packIdOf(id, packs);
  const pack = packId ? packs[packId] : undefined;
  if (packId && pack) {
    // An id naming ONE pack member asks for THAT member, and its precision is part
    // of the request: it is resolved before the pack's first-installed scan (a
    // sibling that happens to be installed must not win), and it is not silently
    // served in a different precision — the pack's measured numbers are this
    // member's quant, so another quant is a different artifact.
    const member = pack.models.find((m) => m.ref === id);
    if (member && !String(member.repo).startsWith("foundry:")) {
      const wanted = [
        [member.repo, member.quant] as [string, string | null],
        ...(member.altRepos ?? []).map((a) => [a, member.altQuant ?? member.quant] as [string, string | null])
      ];
      let baseInstalled: string | undefined;
      for (const [r, q] of wanted) {
        const hit = installedHit(q && !r.includes(":") ? `${r}:${q}` : r);
        if (hit) return { ok: true, ref: hit, requested: id, how: "dynamic-pack" };
        baseInstalled ??= installed.find((im) => baseOf(im) === baseOf(r));
      }
      // The right repo IS installed, in another precision: refuse instead of
      // downgrading. And when the member is not installed at all, refuse too:
      // an id naming ONE member asked for THAT artifact — serving an installed
      // sibling would put different weights behind this id's measured numbers.
      // (Only a BARE tier id — one that names no member — may fall through to
      // the pack scan below and be served by whatever member is installed.)
      if (baseInstalled) {
        return { ok: false, requested: id, reason: `'${id}' asks for ${member.name} in ${member.quant ?? "its packaged precision"}, but the installed build is '${baseInstalled}'. Install the packaged precision in Models to serve this member.` };
      }
      return { ok: false, requested: id, reason: `'${id}' (${member.name}) is not installed. Install it in Models, or request the pack's installed member by its bare tier id.` };
    }
    for (const m of pack.models) {
      for (const r of [m.repo, ...(m.altRepos ?? [])]) {
        const hit = installed.find((im) => baseOf(im) === baseOf(r));
        if (hit) return { ok: true, ref: hit, requested: id, how: "dynamic-pack" };
      }
    }
    // not installed: ask for the pack model's own repo, so the error names what is missing
    const wanted = pack.models.find((m) => m.ref === id) ?? pack.models[0];
    if (wanted) return { ok: true, ref: reNamespace(wanted.repo), requested: id, how: "dynamic-pack" };
  }

  // A "custom:..." id with no saved entry (e.g. written by an older build): the id
  // itself carries the repo and maybe the quant after the prefix. Try the remainder
  // against the cache — as a whole, as repo-only, and as repo:quant — instead of
  // passing the application id to GenieX.
  // "installed:..." names a model listed from the GenieX cache the same way: the rest is its cache name
  const appPrefix = /^(custom|installed):/i.exec(id)?.[0];
  if (appPrefix) {
    const rest = id.slice(appPrefix.length);
    const segs = rest.split(":").filter(Boolean);
    const candidates = [rest];
    if (segs.length >= 2) {
      candidates.push(`${segs[segs.length - 2]}:${segs[segs.length - 1]}`); // repo:quant
    }
    for (const c of candidates) {
      const want = canon(c);
      const hit = installed.find((im) => {
        const r = canon(im);
        return r === want || r.startsWith(`${want}:`) || r.replace(/:[^:]*$/, "") === want;
      });
      if (hit) return { ok: true, ref: hit, requested: id, how: "custom-entry" };
    }
    // A legacy id that names a precision the cache does not hold is refused, not
    // downgraded to whatever build of the same repo IS installed: a different
    // quant is a different artifact, and the answer/speed/memory of one says
    // nothing about the other.
    if (segs.length >= 2) {
      const wrongBuild = installed.find((im) => baseOf(im) === baseOf(rest));
      if (wrongBuild) {
        return { ok: false, requested: id, reason: `'${id}' asks for a build the cache does not hold; the installed build of this model is '${wrongBuild}'. Install the requested precision, or pick the model again in Models.` };
      }
    }
    if (rest && /^custom:/i.test(id)) return { ok: true, ref: rest, requested: id, how: "as-asked" }; // a bare repo name is a real cache-shaped request; "custom:..." is not
  }

  const direct = installed.find((im) => im === id || canon(im) === canon(id));
  if (direct) return { ok: true, ref: direct, requested: id, how: "installed-cache" };

  // An unresolvable id: refusing here (instead of forwarding it) is the contract —
  // the caller fails fast with a truthful message and can retry after a real fix.
  if (/^(dynamic|custom|installed):/i.test(id)) {
    return { ok: false, requested: id, reason: `'${id}' is an application model id and no installed model, saved custom entry or Dynamic pack matches it. Pick the model again in Models.` };
  }
  return { ok: true, ref: id, requested: id, how: "as-asked" };
}
