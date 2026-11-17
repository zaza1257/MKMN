import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROUTER_GPU_AFTER, RouterPlacement, routerWhere } from "../src/core/router";

/**
 * Where the router runs (decided by the owner): on the CPU first, the GPU when the CPU is too busy.
 * Measured here on GenieX 0.11.0: the CPU router answered in 39-274 ms (76-125 tokens/s) with the PC at 32-40 %
 * load, and in tens of seconds (0.06 tokens/s) while other programs kept the CPU at 60-100 % (18 spinning
 * threads); the GPU answered in about 120 ms (31-57 tokens/s) either way.
 */
describe("the router's placement", () => {
  it("starts on the CPU and moves to the GPU after consecutive misses of a warmed router", () => {
    const p = new RouterPlacement();
    expect(p.compute).toBe("cpu");
    for (let i = 1; i < ROUTER_GPU_AFTER; i++) expect(p.missed()).toBe(false);
    expect(p.missed()).toBe(true);
    expect(p.compute).toBe("gpu");
    expect(p.reason).toMatch(/did not answer in time/);
  });

  it("an answer between two misses resets the count (one slow answer is not a busy CPU)", () => {
    const p = new RouterPlacement();
    p.missed();
    p.answered();
    for (let i = 1; i < ROUTER_GPU_AFTER; i++) expect(p.missed()).toBe(false);
    expect(p.compute).toBe("cpu");
  });

  it("stays on the GPU once there (no flapping back during the session)", () => {
    const p = new RouterPlacement();
    for (let i = 0; i < ROUTER_GPU_AFTER; i++) p.missed();
    expect(p.missed()).toBe(false);
    p.answered();
    expect(p.compute).toBe("gpu");
  });

  it("says where it runs in plain words", () => {
    expect(routerWhere("cpu")).toBe("runs on the processor, not on the NPU");
    expect(routerWhere("gpu")).toBe("runs on the graphics processor (the processor was too busy), not on the NPU");
  });

  it("a server started from a compute function reports that compute, not the NPU", async () => {
    const { ServerManager } = await import("../src/core/server");
    let compute = "cpu";
    const srv = new ServerManager({ exe: "geniex.exe", host: "127.0.0.1:18199", computeFn: () => compute });
    expect(srv.status().compute).toBe("cpu");
    compute = "gpu";
    expect(srv.status().compute).toBe("gpu");
  });

  it("the sidecar starts the router from the placement, never from a fixed compute", () => {
    const main = readFileSync("src/sidecar/main.ts", "utf8");
    expect(main).toMatch(/computeFn: \(\) => routerPlacement\.compute/);
    expect(main).not.toMatch(/host: ROUTER_HOST, compute: "cpu"/);
    // both ways of asking the router report a miss of a warmed router
    expect(main.match(/routerMissed\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
