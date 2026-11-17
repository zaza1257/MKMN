import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";

/**
 * The gateway is the only caller of the model transport. This scan fails on any
 * new direct model call — a `streamChat`/`streamComplete` call or definition, or
 * a `chat/completions` request URL — outside the two files allowed to have them:
 *
 *  - `src/core/chat.ts`: the transport itself. It owns the HTTP requests (both
 *    the streaming and the non-streaming fallback), its own internal delegation
 *    (streamComplete fits the window and calls streamChat), and it defines both
 *    functions. It is not a caller of the gateway; it is what the gateway wraps.
 *  - `src/core/harness/gateway.ts`: the one door. The only module in the app
 *    that starts a model call; every pipeline asks through it.
 *
 * Mentions of the endpoint path inside comments are stripped before scanning, so
 * a doc comment does not fail the scan — only a real request shape does.
 */

const ALLOWED = new Map([
  ["core/chat.ts", "the transport implementation: the request URLs and the internal delegation live here"],
  ["core/harness/gateway.ts", "the one door: the only module allowed to start a model call"],
]);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });
}

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

const DIRECT_CALL = /streamChat\(|streamComplete\(/;
const MODEL_URL = /(?:https?:[^"'` ]*|\/v1)\/chat\/completions/;

describe("the gateway is the only caller of the model transport", () => {
  it("no file outside chat.ts and the gateway starts a model call or builds a model request URL", () => {
    const src = path.join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const f of walk(src)) {
      const rel = path.relative(src, f).replaceAll("\\", "/");
      const text = stripComments(readFileSync(f, "utf8"));
      const calls = DIRECT_CALL.test(text);
      const urls = MODEL_URL.test(text);
      if (!calls && !urls) continue;
      if (ALLOWED.has(rel) || (!calls && rel === "renderer/HumainSettings.tsx")) continue;
      offenders.push(`${rel}${calls ? " [direct call]" : ""}${urls ? " [request URL]" : ""}`);
    }
    expect(offenders, `model calls are only allowed in: ${[...ALLOWED.keys()].join(", ")}`).toEqual([]);
  });

  it("the allowed files are exactly the two that exist, so the allowlist never rots", () => {
    const src = path.join(process.cwd(), "src");
    for (const rel of ALLOWED.keys()) {
      expect(readFileSync(path.join(src, rel), "utf8"), rel).toBeTruthy();
    }
  });
});
