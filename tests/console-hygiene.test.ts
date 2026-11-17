import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * No background command may flash a console window (seen on an installed build): `bench.rs` and
 * `voice.rs` passed ONLY a priority to `creation_flags` (a second call overwrites the
 * first, so a later `CREATE_NO_WINDOW` would be lost), and two Node spawns had no
 * `windowsHide` at all. The scan below is the guard: a new command must either use the
 * shared hidden helper or explicitly combine CREATE_NO_WINDOW with its priority, and a
 * Node child process must set windowsHide. Only windows the PERSON asked to see are
 * allowed to be visible, and each one is listed with its reason.
 */

const ROOT = process.cwd();
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Commands whose window the person explicitly asked to see. */
const VISIBLE_RUST = [
  { file: "commands.rs", call: 'Command::new("taskmgr.exe")', why: "the user pressed Open Task Manager" },
  { file: "sidecar.rs", call: 'Command::new("explorer.exe")', why: "the user asked to open a folder in Explorer" },
  { file: "single_instance.rs", call: 'Command::new("explorer.exe")', why: "the person launched the app elevated; this hands the app window back to their desktop" },
];

function productionPart(code: string): string {
  // Test modules may spawn anything: they run in the test binary, never in the app.
  const test = code.search(/#\[cfg\([^\]]*\btest\b[^\]]*\)\]/);
  return test < 0 ? code : code.slice(0, test);
}

function rustCommands(code: string): { index: number; text: string }[] {
  const out: { index: number; text: string }[] = [];
  const re = /Command::new\s*\(/g;
  for (const m of code.matchAll(re)) {
    const index = m.index!;
    // One builder chain; 1200 chars covers the cfg(windows) block that adds the flags.
    out.push({ index, text: code.slice(index, index + 1200) });
  }
  return out;
}

describe("no background process creates a console window", () => {
  it("every Rust Command combines CREATE_NO_WINDOW with its priority (or uses the helper)", () => {
    const dir = join(ROOT, "src-tauri", "src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".rs"));
    const failures: string[] = [];
    for (const file of files) {
      const code = productionPart(read(join("src-tauri", "src", file)));
      for (const cmd of rustCommands(code)) {
        const line = code.slice(0, cmd.index).split("\n").length;
        const visible = VISIBLE_RUST.some((v) => v.file === file && cmd.text.includes(v.call));
        if (visible) continue;
        const hidden = /\bhidden_command\b|\bCREATE_NO_WINDOW\b|0x0800_?0000/i.test(cmd.text);
        if (!hidden) failures.push(`${file}:${line}: ${cmd.text.split("\n")[0].trim()}`);
      }
    }
    expect(failures, `commands that may flash a console:\n${failures.join("\n")}`).toEqual([]);
  });

  it("the deliberate visible windows are the only exceptions, and each is documented", () => {
    for (const v of VISIBLE_RUST) {
      expect(read(join("src-tauri", "src", v.file))).toContain(v.call);
    }
    // The list is short on purpose: a growing list is a review, not a silent default.
    expect(VISIBLE_RUST.length).toBeLessThanOrEqual(4);
  });

  const CHILD = /(?:^|[^\w.$])(spawn|spawnSync|execFile|execFileSync|fork)\s*\(/g;

  function nodeCalls(code: string): { index: number; text: string }[] {
    const out: { index: number; text: string }[] = [];
    for (const m of code.matchAll(CHILD)) {
      const index = m.index!;
      // A function definition is not a spawn.
      if (/function\s*$/.test(code.slice(Math.max(0, index - 30), index))) continue;
      // A commented-out call is not a spawn either.
      const lineStart = code.lastIndexOf("\n", index) + 1;
      if (code.slice(lineStart, index).includes("//")) continue;
      const open = index + m[0].length - 1;
      let depth = 0;
      let end = open;
      for (; end < code.length; end++) {
        if (code[end] === "(") depth++;
        else if (code[end] === ")") {
          depth--;
          if (depth === 0) { end++; break; }
        }
      }
      out.push({ index, text: code.slice(index, end) });
    }
    return out;
  }

  it("every Node child process sets windowsHide (the Qualcomm installer is the documented exception)", () => {
    const failures: string[] = [];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(dir, e.name));
      }
    };
    walk("src");
    for (const file of files) {
      const code = read(file);
      const lines = code.split("\n");
      for (const call of nodeCalls(code)) {
        const line = code.slice(0, call.index).split("\n").length;
        if (/\bwindowsHide\s*:\s*true\b/.test(call.text)) continue;
        const nearby = lines.slice(Math.max(0, line - 3), line + 1).join("\n");
        if (/\bwindowsHide\s*:\s*false\b/.test(call.text) && /deliberate|intentional/i.test(nearby)) continue;
        failures.push(`${file}:${line}: ${call.text.split("\n")[0].trim()}`);
      }
    }
    expect(failures, `Node children that may flash a console:\n${failures.join("\n")}`).toEqual([]);
  });

  it("the Qualcomm installer's visible window is documented where it is kept", () => {
    const setup = read("src/core/setupService.ts");
    const lines = setup.split("\n");
    const at = lines.findIndex((l) => l.includes("windowsHide: false"));
    expect(at, "the deliberate windowsHide: false moved: update the allowlist or remove it").toBeGreaterThanOrEqual(0);
    const near = lines.slice(Math.max(0, at - 2), at + 2).join("\n");
    expect(near).toMatch(/deliberate|intentional/i);
    expect(near).toMatch(/Qualcomm|installer/i);
  });
});
