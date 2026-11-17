import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { filesReadiness } from "../src/renderer/Projects";

/**
 * A project page gave "New chat" the main place and left the files further down,
 * with no word on whether they were ready. It now offers two starting actions side
 * by side, Add files and Start chat, with the files' readiness on the same line.
 */

const src = readFileSync("src/renderer/Projects.tsx", "utf8");

describe("a project page starts with Add files and Start chat", () => {
  it("offers both actions beside the chat box", () => {
    const foot = src.slice(src.indexOf('className="proj-ask-foot"'), src.indexOf('<h2 className="proj-sub">Recents'));
    expect(foot).toMatch(/>Add files</);
    expect(foot).toMatch(/>Start chat</);
    expect(foot).toMatch(/filesReadiness\(/);
  });

  it("says whether the files are ready", () => {
    expect(filesReadiness(0, null, false)).toMatch(/^No files yet/);
    expect(filesReadiness(1, null, false)).toBe("1 file · ready, sent whole with every message");
    expect(filesReadiness(3, "ready", true)).toBe("3 files · ready, searched for each question");
    expect(filesReadiness(3, "indexing", true)).toMatch(/getting ready/);
    expect(filesReadiness(3, "failed", true)).toMatch(/failed: retry/);
  });
});
