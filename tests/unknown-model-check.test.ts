import { describe, it, expect } from "vitest";
import type { CatalogEntry } from "../src/shared/types";
import { startUnknownModelCheck, type UnknownModelCheckDeps } from "../src/sidecar/unknownModelCheck";

/**
 * The startup check for models the app does not know but that are ALREADY installed
 * (imported outside the app): the sidecar only gave its badge to models it installed
 * itself, so those sat unmeasured forever. Here: which models are checked, that the
 * check is deferred, one at a time, never over a busy NPU, and once per launch.
 */

const e = (id: string, name = id): CatalogEntry => ({
  id, name, repo: `org/${id}`, quant: "Q4_0", engine: "llama_cpp", role: "chat",
  architecture: "llama", sizeGB: 1, recommendedContext: 4096,
  sampling: { temperature: 0.7, top_p: 0.9, max_tokens: 512 },
});

function deps(over: Partial<UnknownModelCheckDeps> = {}): UnknownModelCheckDeps & { checks: string[] } {
  const installed: CatalogEntry[] = over.installedEntries ? [] : [e("custom:a"), e("custom:b")];
  const d = {
    checks: [] as string[],
    installedEntries: async () => installed,
    isUnknown: (x: CatalogEntry) => x.id.startsWith("custom:"),
    check: async (x: CatalogEntry) => { d.checks.push(x.id); },
    busy: () => false,
    delay: async () => {},
    initialDelayMs: 20_000,
    log: () => {},
  };
  return Object.assign(d, over);
}

describe("the startup check for already-installed unknown models", () => {
  it("checks exactly the unknown installed models, one at a time, once per launch", async () => {
    const d = deps();
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual(["custom:a", "custom:b"]);
    expect(h.state().running).toBe(false);
    expect(h.state().pending).toEqual([]);
  });

  it("a busy NPU is never taken over: the check waits, and gives up only after its bound", async () => {
    const d = deps({ busy: () => true });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual([]);
    expect(h.state().log.join(" ")).toContain("busy");
  });

  it("waits for a busy NPU and goes on once it is free, instead of leaving the queue for the next launch", async () => {
    // A chat at startup cancelled the whole check until the next launch
    let polls = 0;
    const d = deps({ busy: () => ++polls <= 3 });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual(["custom:a", "custom:b"]);
  });

  it("reads an unreadable model list again before giving up the launch", async () => {
    // One failed read during an install ("GenieX is not installed") cancelled the whole check
    let reads = 0;
    const d = deps({
      installedEntries: async () => { if (++reads < 3) throw new Error("GenieX is not installed"); return [e("custom:a")]; },
    });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(reads).toBe(3);
    expect(d.checks).toEqual(["custom:a"]);
  });

  it("the NPU is re-checked between models: a chat that starts mid-queue and never ends stops the rest", async () => {
    const busy = { on: false };
    const d = deps({
      busy: () => busy.on,
      check: async (x) => { d.checks.push(x.id); busy.on = true; }, // a chat starts while the first model is checked
    });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual(["custom:a"]);
    expect(h.state().log.join(" ")).toContain("custom:b");
  });

  it("one model's failed check does not stop the others (a failure is model-specific)", async () => {
    const d = deps({
      check: async (x) => {
        d.checks.push(x.id);
        if (x.id === "custom:a") throw new Error("would not load");
      },
    });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual(["custom:a", "custom:b"]);
    expect(h.state().log.join(" ")).toContain("the check failed");
  });

  it("nothing unknown installed: nothing runs", async () => {
    const d = deps({ installedEntries: async () => [], isUnknown: () => true });
    const h = startUnknownModelCheck(d);
    await h.run();
    expect(d.checks).toEqual([]);
  });

  it("the check is DEFERRED: the initial delay runs before the inventory is even read", async () => {
    const order: string[] = [];
    const d = deps({
      installedEntries: async () => { order.push("inventory"); return []; },
      delay: async (ms) => { order.push(`delay:${ms}`); },
    });
    await startUnknownModelCheck(d).run();
    expect(order[0]).toBe("delay:20000");
  });
});
