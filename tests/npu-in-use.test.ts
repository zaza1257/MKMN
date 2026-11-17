import { describe, expect, it } from "vitest";
import { npuInUse } from "../src/core/npuInUse";

// The startup load test of unknown models took the NPU while a Computer Use run waited for its model;
// the run never got it, stayed "active", and every new run was refused ("a run is already active").
describe("what keeps the NPU's background work waiting", () => {
  const idle = { chats: 0, benchRunning: false, npuTestRunning: false, leaseBusy: false, agentRuns: 0 };
  it("a Computer Use run in progress", () => {
    expect(npuInUse({ ...idle, agentRuns: 1 })).toBe(true);
  });
  it("a chat, a benchmark, the NPU test or a held runtime", () => {
    expect(npuInUse({ ...idle, chats: 1 })).toBe(true);
    expect(npuInUse({ ...idle, benchRunning: true })).toBe(true);
    expect(npuInUse({ ...idle, npuTestRunning: true })).toBe(true);
    expect(npuInUse({ ...idle, leaseBusy: true })).toBe(true);
  });
  it("nothing else", () => {
    expect(npuInUse(idle)).toBe(false);
  });
});
