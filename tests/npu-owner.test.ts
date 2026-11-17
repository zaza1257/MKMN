import { describe, expect, it } from "vitest";
import { NpuOwner } from "../src/core/npuOwner";

/**
 * The registered machine `npuOwner`: one engine on the NPU at a time. On GenieX started while Foundry
 * Local held the NPU and its DSP crashed. Every start goes through `claim`, which releases the other engine first,
 * always, because the holder may have been started by a path this process does not see.
 */
const releases = (log: string[]) => ({
  geniex: async () => { log.push("release geniex"); },
  foundry: async () => { log.push("release foundry"); },
});

describe("one engine on the NPU", () => {
  it("releases Foundry Local before GenieX takes the NPU, and records the owner", async () => {
    const log: string[] = [];
    const o = new NpuOwner(releases(log));
    await o.claim("geniex");
    expect(log).toEqual(["release foundry"]);
    expect(o.state).toBe("geniex");
  });

  it("goes through free on a switch, never straight from one engine to the other", async () => {
    const log: string[] = [];
    const seen: string[] = [];
    const o = new NpuOwner(releases(log), (s) => seen.push(s));
    await o.claim("geniex");
    await o.claim("foundry");
    expect(log).toEqual(["release foundry", "release geniex"]);
    expect(seen).toEqual(["geniex", "free", "foundry"]);
  });

  it("releases the other engine even when this process thinks the NPU is free (a start it did not see)", async () => {
    const log: string[] = [];
    const o = new NpuOwner(releases(log));
    await o.claim("foundry");
    expect(log).toEqual(["release geniex"]);
  });

  it("keeps ownership and refuses a start when release fails", async () => {
    const errors: string[] = [];
    const o = new NpuOwner({ geniex: async () => {}, foundry: async () => { throw new Error("daemon gone"); } }, undefined, (e) => errors.push(e));
    await o.claim("foundry");
    await expect(o.claim("geniex")).rejects.toThrow("daemon gone");
    expect(o.state).toBe("foundry");
    expect(errors.join(" ")).toContain("daemon gone");
  });

  it("an engine stopped by itself frees the NPU", async () => {
    const o = new NpuOwner(releases([]));
    await o.claim("foundry");
    o.released("foundry");
    expect(o.state).toBe("free");
    o.released("geniex"); // not the owner: nothing changes
    expect(o.state).toBe("free");
  });

  it("holds admission through both release and start", async () => {
    const release = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const log: string[] = [];
    const o = new NpuOwner({ foundry: () => release.promise, geniex: async () => { log.push("release geniex"); } });
    const first = o.run("geniex", () => { entered.resolve(); return done.promise; });
    await expect(o.run("foundry", async () => {})).rejects.toThrow(/another model/i);
    release.resolve();
    await entered.promise;
    await expect(o.run("foundry", async () => {})).rejects.toThrow(/another model/i);
    expect(log).toEqual([]);
    done.resolve();
    await first;
    await o.run("foundry", async () => { log.push("start foundry"); });
    expect(log).toEqual(["release geniex", "start foundry"]);
  });
});
