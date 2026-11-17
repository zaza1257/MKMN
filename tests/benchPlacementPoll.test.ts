import { describe, it, expect } from "vitest";
import { pollPlacement } from "../src/core/benchRunner";

/**
 * The placement poll: the cheap probe answers utilization every turn; the dedicated
 * memory probe (a process per read, seconds each) is read at most every 5 s, so a
 * placement never spawns it non-stop during the load being timed.
 */
describe("the placement poll reads the memory probe at most every 5 s", () => {
  it("a 30 s placement makes at most 7 memory reads (and uses the cheap probe between them)", async () => {
    // a fake clock that advances 200 ms a turn (the poll's pause): a 30 s placement is
    // 150 turns, and every probe is counted
    let t = 0;
    let mem = 0;
    let cheap = 0;
    const { peakUtil, peakMem } = await pollPlacement(
      async () => { cheap++; return { util: 50, memGB: null }; },
      async () => { mem++; return { util: null, memGB: 4 }; },
      () => {},
      { shouldRun: () => t < 150, sleep: async () => { t++; }, now: () => t * 200 }
    );
    expect(mem).toBeLessThanOrEqual(7);
    expect(mem).toBeGreaterThanOrEqual(6); // the memory is still read: the delta it reports needs it
    expect(cheap).toBe(150); // utilization every turn, no process spawn between
    expect(peakUtil).toBe(50);
    expect(peakMem).toBe(4);
  });

  it("the peaks are kept exactly as before: the largest of every reading, unknowns skipped", async () => {
    // a one-tick clock: sleep advances it, so the loop terminates on its own
    let t = 0;
    const { peakUtil, peakMem } = await pollPlacement(
      async () => ({ util: t === 0 ? 30 : 80, memGB: null }),
      async () => ({ util: null, memGB: t >= 1 ? 3.5 : null }),
      () => {},
      { shouldRun: () => t < 3, sleep: async () => { t++; }, now: () => t, memEveryMs: 2 }
    );
    expect(peakUtil).toBe(80);
    expect(peakMem).toBe(3.5); // the first memory reading was unknown: null, never a 0 in the peak
  });
});
