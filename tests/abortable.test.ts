import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { raceAbort } from "../src/core/abortable";

/**
 * Stop in the NPU load test reached the chat calls only: a model start (up to ten
 * minutes) could not be interrupted. The start is now raced against Stop.
 */

describe("raceAbort", () => {
  it("ends the wait at once when the signal aborts", async () => {
    const ac = new AbortController();
    const never = new Promise<string>(() => {});
    const p = raceAbort(never, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow("Stopped.");
  });

  it("passes the work's own result and error through", async () => {
    const ac = new AbortController();
    await expect(raceAbort(Promise.resolve(7), ac.signal)).resolves.toBe(7);
    await expect(raceAbort(Promise.reject(new Error("no")), ac.signal)).rejects.toThrow("no");
  });

  it("the NPU load test races its model start against Stop (source pin)", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toContain("await raceAbort(ensureServer(e, { setting: s, force: true }), ac.signal)");
  });
});
