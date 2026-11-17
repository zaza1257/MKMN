import { describe, it, expect, vi, beforeEach } from "vitest";
import { ModelSwitcher, switchNoteOutdated, uninstallGate, type SwitchPhase } from "../src/renderer/modelSwitch";

/**
 * Switching models from Settings → Models → Use. Observed: a click showed nothing for 46 s or more,
 * a second click was silently ignored, and the only way out was to wait. Required: "Starting <model>…" then
 * "Warming up…" while it happens, Cancel that stops only the pending switch, and the selection saved only after
 * the requested model warmed up: a cancelled or failed switch keeps the previous selection, and a late answer
 * of a cancelled switch saves nothing.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function localStorageStub(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as unknown as Storage;
}

/** The host, faked by command: start_server answers when `release` is called. */
async function fakeHost() {
  const core = await import("@tauri-apps/api/core");
  const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
  const calls: { cmd: string; args?: any }[] = [];
  let release: (v: unknown) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  invoke.mockReset();
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    calls.push({ cmd, args });
    if (cmd === "sidecar_call") return args.method === "customEntries" ? [] : null;
    if (cmd === "get_installed_models_cmd") return [{ ref: "org/model:Q4_0", name: "org/model" }];
    if (cmd === "get_settings") return { selectedModelId: "org/previous:Q4_0" };
    if (cmd === "start_server") return new Promise((res, rej) => { release = res; fail = rej; });
    return {};
  });
  return { calls, release: (v: unknown = { state: "ready", model: "org/model:Q4_0" }) => release(v), fail: (e: Error) => fail(e) };
}

async function bridge() {
  vi.stubGlobal("localStorage", localStorageStub());
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await tick();
  return a;
}

const saved = (calls: { cmd: string; args?: any }[]) => calls.filter((c) => c.cmd === "save_settings_cmd").map((c) => c.args?.patch?.selectedModelId);

describe("selectModel saves only a switch that warmed up and was not cancelled", () => {
  beforeEach(() => vi.resetModules());

  it("a successful switch saves the new selection after the start answers", async () => {
    const host = await fakeHost();
    const api = await bridge();
    const p = api.selectModel("org/model:Q4_0", true);
    await tick(5);
    expect(saved(host.calls)).toEqual([]); // nothing saved while the model starts
    host.release();
    await p;
    expect(saved(host.calls)).toEqual(["org/model:Q4_0"]);
  });

  it("a late answer of a cancelled switch saves nothing", async () => {
    const host = await fakeHost();
    const api = await bridge();
    const ac = new AbortController();
    const p = api.selectModel("org/model:Q4_0", true, { signal: ac.signal });
    await tick(5);
    ac.abort();
    host.release(); // the host answers after the cancel
    await expect(p).rejects.toThrow(/cancelled/i);
    expect(saved(host.calls)).toEqual([]);
  });

  it("a switch cancelled before it reached the host never starts a server", async () => {
    const host = await fakeHost();
    const api = await bridge();
    const ac = new AbortController();
    ac.abort();
    await expect(api.selectModel("org/model:Q4_0", true, { signal: ac.signal })).rejects.toThrow(/cancelled/i);
    expect(host.calls.some((c) => c.cmd === "start_server")).toBe(false);
  });

  it("a failed start keeps the previous selection", async () => {
    const host = await fakeHost();
    const api = await bridge();
    const p = api.selectModel("org/model:Q4_0", true);
    await tick(5);
    host.fail(new Error("GenieX is running, but its model list does not hold org/model:Q4_0. Requested: org/model:Q4_0. Returned (1): a/b."));
    await expect(p).rejects.toThrow(/does not hold org\/model:Q4_0/);
    expect(saved(host.calls)).toEqual([]);
  });
});

/** A switcher over fakes: `select` resolves or rejects when told, `state` is what the host reports. */
function switcher() {
  const phases: SwitchPhase[] = [];
  const pending: { id: string; signal: AbortSignal; resolve: () => void; reject: (e: Error) => void }[] = [];
  let state: string | null = "starting";
  const stops = vi.fn(async () => undefined);
  const s = new ModelSwitcher({
    select: (id, signal) => new Promise<void>((resolve, reject) => {
      pending.push({ id, signal, resolve, reject });
      signal.addEventListener("abort", () => reject(Object.assign(new Error("The model switch was cancelled"), { name: "AbortError" })));
    }),
    serverState: async () => state,
    stopPending: stops,
    onPhase: (p) => phases.push(p),
    pollMs: 1,
  });
  return { s, phases, pending, stops, setState: (v: string | null) => { state = v; } };
}

describe("the model switch in Settings", () => {
  it("says Starting, then Warming up once the model is listed, then done", async () => {
    const t = switcher();
    const run = t.s.start("org/model:Q4_0", "Model");
    await tick(5);
    expect(t.phases.at(-1)).toMatchObject({ kind: "starting", id: "org/model:Q4_0", name: "Model" });
    t.setState("loading"); // the host's "listed, warming up"
    await tick(10);
    expect(t.phases.at(-1)).toMatchObject({ kind: "warming", name: "Model" });
    t.pending[0].resolve();
    expect(await run).toBe("done");
    expect(t.phases.at(-1)).toMatchObject({ kind: "idle" });
    expect(t.s.busy).toBe(false);
  });

  it("Cancel stops only the pending switch, and another selection then runs", async () => {
    const t = switcher();
    const first = t.s.start("org/big:Q4_0", "Big");
    await tick(5);
    await t.s.cancel();
    expect(await first).toBe("cancelled");
    expect(t.stops).toHaveBeenCalledTimes(1);
    expect(t.phases.at(-1)).toMatchObject({ kind: "cancelled", id: "org/big:Q4_0" });
    expect(t.s.busy).toBe(false);
    const second = t.s.start("org/small:Q4_0", "Small");
    await tick(5);
    expect(t.pending[1].id).toBe("org/small:Q4_0");
    t.pending[1].resolve();
    expect(await second).toBe("done");
  });

  it("a late success of a cancelled switch is still a cancelled switch", async () => {
    const phases: SwitchPhase[] = [];
    let resolveLate: () => void = () => undefined;
    const s = new ModelSwitcher({
      select: () => new Promise<void>((r) => { resolveLate = r; }), // ignores the signal: the answer comes late
      serverState: async () => "starting",
      stopPending: async () => undefined,
      onPhase: (p) => phases.push(p),
      pollMs: 1,
    });
    const run = s.start("org/big:Q4_0", "Big");
    await tick(5);
    await s.cancel();
    resolveLate();
    expect(await run).toBe("cancelled");
    expect(phases.some((p) => p.kind === "idle" && phases.indexOf(p) > phases.findIndex((q) => q.kind === "cancelled"))).toBe(false);
  });

  it("a failure is reported with its error and leaves the switcher free", async () => {
    const t = switcher();
    const run = t.s.start("org/model:Q4_0", "Model");
    await tick(5);
    t.pending[0].reject(new Error("GenieX failed to load org/model:Q4_0"));
    expect(await run).toBe("failed");
    expect(t.phases.at(-1)).toMatchObject({ kind: "failed", error: "GenieX failed to load org/model:Q4_0" });
    expect(t.s.busy).toBe(false);
  });

  it("a second Use while a switch runs is refused, not silently dropped", async () => {
    const t = switcher();
    void t.s.start("org/a:Q4_0", "A");
    await tick(5);
    expect(await t.s.start("org/b:Q4_0", "B")).toBe("busy");
    expect(t.pending).toHaveLength(1);
  });
});

describe("the switch's outcome note stays true", () => {
  // Seen on an installed build: "The switch to Qwen3-8B was cancelled ... no model is loaded now" still showed after
  // the next message had loaded Qwen3-4B. A note about what runs is cleared once a model is loaded again.
  it("is cleared when the model server becomes ready or busy again, not before", () => {
    expect(switchNoteOutdated("stopped", "starting")).toBe(false);
    expect(switchNoteOutdated("starting", "loading")).toBe(false);
    expect(switchNoteOutdated("loading", "ready")).toBe(true);
    expect(switchNoteOutdated("stopped", "busy")).toBe(true);
    expect(switchNoteOutdated("ready", "ready")).toBe(false); // no change: a note written while a model runs stays
    expect(switchNoteOutdated("ready", "stopped")).toBe(false);
  });
});

describe("removing a model while one starts", () => {
  it("is refused while a model is starting or loading, and stops a ready server first", () => {
    expect(uninstallGate("starting")).toBe("refuse");
    expect(uninstallGate("loading")).toBe("refuse");
    expect(uninstallGate("busy")).toBe("refuse"); // a reply is being written
    expect(uninstallGate("ready")).toBe("stop");
    expect(uninstallGate("stopped")).toBe("go");
    expect(uninstallGate(null)).toBe("go");
  });
});
