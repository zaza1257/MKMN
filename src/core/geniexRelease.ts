/**
 * Qualcomm's GenieX release feed: `index.json` names the latest stable tag and the manifest of each
 * release; `manifest-<tag>.json` lists every asset with its url, size and sha256. The Windows ARM64 CLI installer is
 * the asset of kind `cli-installer`, platform `windows`, arch `arm64`. The feed is what tells MKMN which GenieX is
 * current and what the installer it downloads must hash to; the unversioned `geniex-cli.exe` it used before says neither.
 */

export const GENIEX_FEED_BASE = "https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-geniex/";
export const GENIEX_INDEX_URL = `${GENIEX_FEED_BASE}index.json`;

export interface GeniexInstaller { tag: string; url: string; sha256: string; size: number }

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);

/** The latest stable tag and its manifest file, or null when the index is not the shape Qualcomm publishes. */
export function parseGeniexIndex(json: unknown): { latestStable: string; manifest: string } | null {
  const j = rec(json);
  const tag = typeof j?.latest_stable === "string" ? j.latest_stable.trim() : "";
  if (!/^v?\d+\.\d+\.\d+$/.test(tag)) return null;
  const versions = Array.isArray(j?.versions) ? j!.versions : [];
  const entry = versions.map(rec).find((v) => v?.tag === tag);
  const manifest = typeof entry?.manifest === "string" && /^[\w.-]+\.json$/.test(entry.manifest) ? entry.manifest : `manifest-${tag}.json`;
  return { latestStable: tag, manifest };
}

/** The Windows ARM64 CLI installer of a release manifest, only when its url is https and its sha256 is a real one. */
export function parseWindowsInstaller(json: unknown): GeniexInstaller | null {
  const j = rec(json);
  const tag = typeof j?.tag === "string" ? j.tag : "";
  const assets = Array.isArray(j?.assets) ? j!.assets.map(rec) : [];
  const a = assets.find((x) => x?.kind === "cli-installer" && x?.platform === "windows" && x?.arch === "arm64");
  if (!a || !tag) return null;
  const url = typeof a.url === "string" ? a.url : "";
  const sha256 = typeof a.sha256 === "string" ? a.sha256.toLowerCase() : "";
  const size = typeof a.size === "number" && a.size > 0 ? a.size : 0;
  if (!/^https:\/\//i.test(url) || !/^[0-9a-f]{64}$/.test(sha256) || !size) return null;
  return { tag, url, sha256, size };
}

/** The first x.y.z of a tag or of what `geniex --version` prints ("GenieX CLI Version: v0.11.0" then "QAIRT Runtime Version: 2.50"). */
const parts = (v: string) => (v.match(/\d+\.\d+\.\d+/)?.[0] ?? "").split(".").map((n) => Number(n));

/** True when the feed's version is above the installed one; null when either is unknown. A pre-release counts as its number. */
export function geniexReleaseNewer(latest: string | null, installed: string | null): boolean | null {
  if (!latest || !installed) return null;
  const a = parts(latest);
  const b = parts(installed);
  if (a.length < 3 || b.length < 3 || [...a, ...b].some((n) => !Number.isFinite(n))) return null;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

/** The latest stable Windows installer, read from the index and the manifest it names; null when the feed cannot be read. */
export async function resolveGeniexRelease(fetchFn: typeof fetch = fetch): Promise<GeniexInstaller | null> {
  const get = async (url: string) => {
    const r = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
    return r.ok ? r.json() : null;
  };
  let index: ReturnType<typeof parseGeniexIndex>;
  let installer: GeniexInstaller | null;
  try {
    index = parseGeniexIndex(await get(GENIEX_INDEX_URL));
    if (!index) return null;
    installer = parseWindowsInstaller(await get(`${GENIEX_FEED_BASE}${index.manifest}`));
  } catch {
    return null;
  }
  if (installer && installer.tag.replace(/^v/, "") !== index.latestStable.replace(/^v/, "")) {
    throw new Error(`Qualcomm's GenieX manifest names ${installer.tag}, but the release index names ${index.latestStable}. Try again later.`);
  }
  return installer;
}
