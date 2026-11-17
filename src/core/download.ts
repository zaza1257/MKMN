import * as fs from "fs";
import * as http from "http";
import * as https from "https";

/** Resumable download to a file with progress. Follows redirects; throws on HTTP errors.
 *  https only, at every hop (a redirect to plain http is refused); `allowHttp` is for the
 *  tests' local server. The caller checks what was downloaded (the GenieX installer: its
 *  published SHA-256, then its signature) — a resumed file is never trusted on its own. */
export function downloadFile(url: string, dest: string, onPercent: (p: number | null) => void, signal?: { cancelled: boolean }, opts: { allowHttp?: boolean } = {}): Promise<void> {
  const part = dest + ".part";
  const get = (u: string, redirects = 0, retriedRange = false): Promise<void> => new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error("Too many redirects"));
    if (!u.startsWith("https:") && !(opts.allowHttp && u.startsWith("http:"))) return reject(new Error(`Download refused: only https addresses are downloaded (${u.split(":")[0]})`));
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const lib = u.startsWith("https:") ? https : http;
    const req = lib.get(u, { headers: { "User-Agent": "MKMN", ...(have ? { Range: `bytes=${have}-` } : {}) } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(get(new URL(res.headers.location, u).toString(), redirects + 1, retriedRange));
      }
      if (res.statusCode === 416) {
        res.resume();
        // An unsatisfiable range does not prove that the staged file is complete.
        // Retry once from zero, never promote unverified partial bytes.
        if (!have || retriedRange) return reject(new Error("Download failed: invalid byte range (HTTP 416)"));
        try { fs.truncateSync(part, 0); } catch (e) { return reject(e); }
        return resolve(get(u, redirects, true));
      }
      if (!res.statusCode || res.statusCode >= 400) { res.resume(); return reject(new Error(`Download failed (HTTP ${res.statusCode})`)); }
      const resumed = res.statusCode === 206;
      let rangeBytes: number | null = null;
      if (resumed) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(res.headers["content-range"] ?? ""));
        if (!range || Number(range[1]) !== have || Number(range[2]) < have || Number(range[3]) - 1 !== Number(range[2])) {
          res.resume();
          return reject(new Error("Download failed: invalid Content-Range"));
        }
        rangeBytes = Number(range[2]) - have + 1;
      }
      const total = (parseInt(String(res.headers["content-length"] ?? "0"), 10) || 0) + (resumed ? have : 0);
      let got = resumed ? have : 0;
      const out = fs.createWriteStream(part, { flags: resumed ? "a" : "w" });
      res.on("data", (b: Buffer) => {
        got += b.length;
        if (signal?.cancelled) req.destroy(new Error("cancelled"));
        onPercent(total ? Math.round((got / total) * 100) : null);
      });
      res.pipe(out);
      // Wait for the file handle to close before renaming, including on Windows.
      let finished = false;
      out.on("finish", () => { finished = true; });
      out.on("close", () => {
        if (!finished) return;
        if (rangeBytes !== null && got - have !== rangeBytes) return reject(new Error("Download failed: incomplete byte range"));
        resolve();
      });
      out.on("error", reject);
      res.on("error", (error) => { out.destroy(); reject(error); });
    });
    req.on("error", reject);
  });
  return get(url).then(() => { fs.renameSync(part, dest); });
}
