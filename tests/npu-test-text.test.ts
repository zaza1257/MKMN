import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The NPU load test's own description must match what the desktop build does: it
 * promised "the server's own error lines" (the desktop build has none to give —
 * the server belongs to the Rust host) and every one of its settings (those set by
 * environment variables are skipped, and named, in this build).
 */

const src = readFileSync("src/renderer/NpuLoadTest.tsx", "utf8");

describe("the NPU load test says what it really does", () => {
  it("does not promise server error lines", () => {
    expect(src).not.toMatch(/keeps the server's own error lines/);
  });

  it("says that settings this build cannot start are skipped and named", () => {
    expect(src).toMatch(/skipped and named/);
  });
});
