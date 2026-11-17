import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveMemberProblem, installVoiceArchive, linkInTree, runTar } from "../src/core/voiceInstall";
import { VOICE_MODELS } from "../src/core/voiceModels";

/**
 * 2026-11-17 review: a voice-model archive was extracted with tar straight into the
 * model's folder, with no check of what was downloaded. Upstream archives change
 * (Kokoro and Parakeet were re-uploaded in October and November 2026), so a resumed
 * download could even join two different files. The archive is now checked against
 * a pinned SHA-256 and size, its entry names are checked, it lands in a staging
 * folder, a link refuses it, and only then does it replace the installed model.
 */

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-voice-install-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

async function makeArchive(): Promise<{ archive: string; sha256: string; bytes: number }> {
  const src = path.join(root, "src", "sherpa-model");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "tokens.txt"), "a 0\nb 1\n");
  fs.writeFileSync(path.join(src, "model.onnx"), Buffer.alloc(2048, 7));
  const archive = path.join(root, "m.tar.bz2.part");
  await runTar(["-cjf", archive, "-C", path.join(root, "src"), "sherpa-model"]);
  const buf = fs.readFileSync(archive);
  return { archive, sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length };
}

describe("a voice-model archive is installed only when it is the published one", () => {
  it("installs a matching archive through a staging folder and removes the download", async () => {
    const { archive, sha256, bytes } = await makeArchive();
    const dir = path.join(root, "models", "stt-x");
    await installVoiceArchive(archive, { sha256, bytes }, dir);
    expect(fs.readFileSync(path.join(dir, "tokens.txt"), "utf8")).toContain("a 0");
    expect(fs.existsSync(path.join(dir, ".complete"))).toBe(true);
    expect(fs.existsSync(`${dir}.staging`)).toBe(false);
    expect(fs.existsSync(archive)).toBe(false);
  });

  it("refuses a download whose SHA-256 differs and leaves the installed model as it was", async () => {
    const { archive, bytes } = await makeArchive();
    const dir = path.join(root, "models", "stt-x");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, ".complete"), "earlier");
    await expect(installVoiceArchive(archive, { sha256: "0".repeat(64), bytes }, dir)).rejects.toThrow(/SHA-256/);
    expect(fs.readFileSync(path.join(dir, ".complete"), "utf8")).toBe("earlier");
    expect(fs.existsSync(archive)).toBe(false); // never resumed onto
  });

  it("refuses a download of the wrong size before hashing it", async () => {
    const { archive, sha256, bytes } = await makeArchive();
    await expect(installVoiceArchive(archive, { sha256, bytes: bytes + 1 }, path.join(root, "d"))).rejects.toThrow(/bytes/);
  });

  it("refuses a model with no pinned digest", async () => {
    const { archive } = await makeArchive();
    await expect(installVoiceArchive(archive, {}, path.join(root, "d"))).rejects.toThrow(/no pinned SHA-256/);
  });

  it("refuses an archive whose entries leave the folder, before tar extracts anything", async () => {
    const { archive, sha256, bytes } = await makeArchive();
    const calls: string[][] = [];
    const tar = async (args: string[]) => { calls.push(args); return "model/ok.txt\nmodel/../../evil.dll\n"; };
    await expect(installVoiceArchive(archive, { sha256, bytes }, path.join(root, "d"), tar)).rejects.toThrow(/leaves its folder/);
    expect(calls.map((c) => c[0])).toEqual(["-tjf"]);
  });

  it("names absolute paths, drives and parent steps as unsafe entries", () => {
    expect(archiveMemberProblem(["m/a", "m/b/c"])).toBeNull();
    expect(archiveMemberProblem(["/etc/passwd"])).toMatch(/absolute/);
    expect(archiveMemberProblem(["C:\\Windows\\x"])).toMatch(/absolute/);
    expect(archiveMemberProblem(["m\\..\\..\\x"])).toMatch(/leaves/);
    expect(archiveMemberProblem([])).toMatch(/empty/);
  });

  it("finds a junction anywhere in an extracted tree", () => {
    const tree = path.join(root, "tree", "deep");
    fs.mkdirSync(tree, { recursive: true });
    expect(linkInTree(path.join(root, "tree"))).toBeNull();
    fs.symlinkSync(os.tmpdir(), path.join(tree, "out"), "junction");
    expect(linkInTree(path.join(root, "tree"))).toMatch(/out$/);
  });

  it("every catalog voice model carries its SHA-256 and exact size", () => {
    for (const m of VOICE_MODELS) {
      expect(m.sha256, m.id).toMatch(/^[0-9a-f]{64}$/);
      expect(m.bytes, m.id).toBeGreaterThan(1_000_000);
    }
  });
});
