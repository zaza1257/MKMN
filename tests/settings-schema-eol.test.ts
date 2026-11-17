import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The settings generator must read its own inventory whatever the line endings
 * of the checkout. On a Windows checkout (CRLF) its findings regex looked for
 * "\n" only, so `--check` called a fresh file stale and `--write` silently dropped
 * the hand-written FINDINGS block.
 */

const ROOT = process.cwd();
const run = (args: string[]) => spawnSync(process.execPath, [join(ROOT, "scripts/generate-settings-schema.mjs"), ...args], { cwd: ROOT, encoding: "utf8", windowsHide: true });

describe("the settings generator and line endings", () => {
  it("--check passes on the committed inventory read with CRLF line endings", () => {
    const file = join(ROOT, "docs/settings-inventory.md");
    const original = readFileSync(file, "utf8");
    const crlf = original.replace(/\r?\n/g, "\r\n");
    try {
      writeFileSync(file, crlf);
      const r = run(["--check"]);
      expect(r.status, r.stderr).toBe(0);
    } finally {
      writeFileSync(file, original);
    }
  });

  it("keeps the FINDINGS block when the inventory has CRLF line endings", () => {
    const file = join(ROOT, "docs/settings-inventory.md");
    const original = readFileSync(file, "utf8");
    const backup = join(mkdtempSync(join(tmpdir(), "inv-")), "inventory.md");
    copyFileSync(file, backup);
    try {
      writeFileSync(file, original.replace(/\r?\n/g, "\r\n"));
      run(["--write"]);
      const after = readFileSync(file, "utf8");
      expect(after).toContain("None recorded for this release.");
    } finally {
      copyFileSync(backup, file);
    }
  });
});
