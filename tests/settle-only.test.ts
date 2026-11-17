import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

/**
 * settle() (src/core/harness/settle.ts) is the only writer of a run's final status.
 * The scan proves it against the tree, not against a claim:
 *
 *  - `settle(` may be called in src only inside the harness and the named
 *    pipelines below, each counted, each with its reason; any other caller or
 *    any uncounted call is a status writer outside the one place.
 *  - No pipeline writes a final build status as a literal: the last build event
 *    of every build-machine pipeline is derived from settle()'s verdict. A
 *    progress event (`run("running")`) is not a final status and stays free.
 *  - No code writes the build machine's `unresolved` state directly.
 *
 * Out of scope, named here so the exception cannot rot silently: the review and
 * loop panels (src/core/review.ts) report `status: "running" | "done"` — a type
 * with no other terminal value, whose errors surface as error notes, so their
 * literal names no decision; they are not the build machine.
 */

/** Remove block comments and line comments (a `//` inside a URL scheme is not a comment). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      let out = "";
      let inStr: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        const prev = line[i - 1];
        if (inStr) {
          if (c === inStr && prev !== "\\") inStr = null;
          out += c;
          continue;
        }
        if (c === '"' || c === "'" || c === "`") {
          inStr = c;
          out += c;
          continue;
        }
        if (c === "/" && line[i + 1] === "/" && prev !== ":") break;
        out += c;
      }
      return out;
    })
    .join("\n");
}

const ROOT = path.resolve(__dirname, "..", "src");

function walk2(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk2(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk2(ROOT);
const rel = (p: string) => path.relative(ROOT, p).replace(/\\/g, "/");
const code = (p: string) => stripComments(readFileSync(p, "utf8"));

/** Where `settle(` may appear outside the harness, with the exact count each file may hold. */
const SETTLE_SITES: Record<string, { count: number; why: string }> = {
  "core/build.ts": { count: 2, why: "the program build: buildStatus (the rules as an adapter) and the final site of stepwise, over the run's steps and gates" },
  "core/deckBuild.ts": { count: 1, why: "the deck's final event, over the deck run's steps" },
  "core/deckEdit.ts": { count: 1, why: "the deck change's final event, over its run's steps" },
  "core/templates/build.ts": { count: 2, why: "makeFromTemplate's two final sites (the multi-page site and the single file)" },
  "core/templates/calcsheet.ts": { count: 1, why: "the calculation sheet's final event" },
  "core/templates/freefile.ts": { count: 1, why: "the freely written file's final event" },
};

/** The pipelines that emit build-machine events: a final status must never be a literal there. */
const BUILD_MACHINE_FILES = [
  "core/build.ts",
  "core/deckBuild.ts",
  "core/deckEdit.ts",
  "core/templates/build.ts",
  "core/templates/calcsheet.ts",
  "core/templates/freefile.ts",
];

describe("settle is the only writer of a final status", () => {
  it("the harness settle is imported only by the harness and the named, counted sites", () => {
    // `settle(` as a word also names unrelated local functions (an NPU spec settler, a memory
    // settler in the NPU test, the renderer's turn settler): what decides a RUN's final status
    // is the harness settle, and only an import of it can call it.
    const offenders: string[] = [];
    for (const f of files) {
      const r = rel(f);
      if (r.startsWith("core/harness/")) continue; // the harness itself: the kernel and settle
      if (/from "[^"]*harness\/settle"/.test(code(f)) && !SETTLE_SITES[r]) offenders.push(r);
    }
    expect(offenders, `the harness settle imported outside the one place: ${offenders.join("; ")}`).toEqual([]);
    for (const [r, site] of Object.entries(SETTLE_SITES)) {
      expect(files.some((f) => rel(f) === r), `the named site ${r} no longer exists`).toBe(true);
      const src = code(path.join(ROOT, r));
      expect(/from "[^"]*harness\/settle"/.test(src), `${r} no longer imports the harness settle`).toBe(true);
      expect((src.match(/\bsettle\(/g) ?? []).length, `${r}: settle calls`).toBe(site.count);
    }
  });

  it("no build-machine pipeline writes its final status as a literal; every last event derives from the verdict", () => {
    const literal = /yield run\("(?:done|unresolved|error|failed|cancelled)"\)/;
    const derived = /=== "done" \? "done" : "unresolved"/;
    for (const r of BUILD_MACHINE_FILES) {
      const src = code(path.join(ROOT, r));
      const hits = src.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => literal.test(l));
      expect(hits.map(([n]) => n), `${r} writes a final status literal`).toEqual([]);
      expect(derived.test(src), `${r} derives its last event from the verdict`).toBe(true);
    }
  });

  it("the build machine's unresolved state is never written directly by app code", () => {
    const offenders = files
      .filter((f) => !rel(f).startsWith("core/harness/"))
      .filter((f) => /status:\s*"unresolved"/.test(code(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});
