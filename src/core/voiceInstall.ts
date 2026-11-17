// Installing a downloaded voice-model archive: nothing from the download is
// extracted until its SHA-256 and size are the ones pinned in the catalog
// (src/core/voiceModels.ts), the archive's entry names are checked before tar
// runs, the files land in a staging folder, a link anywhere in it refuses the
// install, and only then does the staging folder replace the model's folder.
// An installed model is never left half-replaced.

import { execFile } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as path from "path";

export type TarRun = (args: string[]) => Promise<string>;

/** Windows' own tar.exe (bsdtar, Windows 10+, reads .tar.bz2), named by its full path: the
 *  first "tar" on the PATH may be another program (Git's GNU tar reads "C:" as a remote host). */
export function tarPath(): string {
  if (process.platform !== "win32") return "tar";
  const own = path.join(process.env.SystemRoot || process.env.windir || "C:\\Windows", "System32", "tar.exe");
  return fs.existsSync(own) ? own : "tar";
}

export const runTar: TarRun = (args) => new Promise((resolve, reject) => {
  execFile(tarPath(), args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, out, se) => {
    if (err) reject(new Error(String(se || err.message).trim()));
    else resolve(String(out));
  });
});

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(file).on("data", (b) => hash.update(b)).on("end", resolve).on("error", reject);
  });
  return hash.digest("hex");
}

/** Why the archive's entry list cannot be extracted safely, or null. With the
 *  first path part stripped (as the install does), every entry must stay inside
 *  the model's folder: no absolute path, no drive, no "..". */
export function archiveMemberProblem(names: string[]): string | null {
  if (!names.length) return "the archive is empty";
  for (const raw of names) {
    const n = raw.replace(/\\/g, "/");
    if (n.startsWith("/") || /^[a-zA-Z]:/.test(n)) return `the archive holds an absolute path (${raw})`;
    if (n.split("/").some((part) => part === "..")) return `the archive holds a path that leaves its folder (${raw})`;
  }
  return null;
}

/** A symbolic link or junction anywhere under `dir`, or null. */
export function linkInTree(dir: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (fs.lstatSync(p).isSymbolicLink()) return p;
    if (e.isDirectory()) {
      const deeper = linkInTree(p);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** Checks the archive against its pin, extracts it into `${dir}.staging` and promotes it to `dir`.
 *  The archive is deleted whatever happens: a file that failed a check is never resumed. */
export async function installVoiceArchive(
  archive: string,
  pin: { sha256?: string; bytes?: number },
  dir: string,
  tar: TarRun = runTar,
): Promise<void> {
  const staging = `${dir}.staging`;
  try {
    if (!pin.sha256 || !/^[0-9a-f]{64}$/.test(pin.sha256)) throw new Error("this model has no pinned SHA-256, so its download is not installed");
    const size = fs.statSync(archive).size;
    if (pin.bytes !== undefined && size !== pin.bytes) throw new Error(`the download is ${size} bytes, the published archive is ${pin.bytes}`);
    const got = await sha256File(archive);
    if (got !== pin.sha256) throw new Error(`the download's SHA-256 is ${got}, the published archive's is ${pin.sha256}`);
    const listed = (await tar(["-tjf", archive])).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const bad = archiveMemberProblem(listed);
    if (bad) throw new Error(bad);
    fs.rmSync(staging, { recursive: true, force: true });
    fs.mkdirSync(staging, { recursive: true });
    await tar(["-xjf", archive, "-C", staging, "--strip-components=1"]);
    const link = linkInTree(staging);
    if (link) throw new Error(`the archive holds a link (${path.relative(staging, link)})`);
    fs.writeFileSync(path.join(staging, ".complete"), new Date().toISOString());
    fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(staging, dir);
  } catch (e) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw e;
  } finally {
    fs.rmSync(archive, { force: true });
  }
}
