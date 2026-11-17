import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

/**
 * A dead sidecar settles EVERYTHING it was doing, not only chats: a model install,
 * the benchmark, the NPU load test, the prompt lab and a code run were left
 * "running" forever, their Stop buttons talking to a process that no longer exists.
 */

let handlers: Record<string, (e: { payload: any }) => void> = {};

function storage(): Storage {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as unknown as Storage;
}

beforeEach(async () => {
  handlers = {};
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as any).mockReset();
  (ev.listen as any).mockImplementation(async (name: string, h: any) => { handlers[name] = h; return () => {}; });
  vi.stubGlobal("localStorage", storage());
});

const emit = (name: string, payload: unknown) => handlers["sidecar-event"]?.({ payload: { name, payload } });

describe("a dead sidecar settles what it was doing", () => {
  it("ends an install, the benchmark, the NPU test, the lab and a code run, keeping what they showed", async () => {
    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api: any = createTauriApi();
    await new Promise((r) => setTimeout(r, 0));
    const got: Record<string, any[]> = { install: [], npu: [], bench: [], lab: [], run: [] };
    api.onInstall((p: any) => got.install.push(p));
    api.onNpuTest((s: any) => got.npu.push(s));
    api.onBench((s: any) => got.bench.push(s));
    api.onLab((s: any) => got.lab.push(s));
    api.onRun((e: any) => got.run.push(e));

    emit("install", { ref: "q/repo:Q4", phase: "downloading", percent: 40 });
    emit("npuTest", { running: true, lines: ["trying setting 1"], results: [] });
    emit("bench", { running: true, phase: "testing", lines: ["model 1 of 3"] });
    emit("lab", { running: true, phase: "asking", log: ["prompt 1"] });
    emit("run", { runId: "r1", type: "out", text: "hello" });
    emit("sidecarExited", { generation: 3 });

    expect(got.install.at(-1)).toMatchObject({ ref: "q/repo:Q4", phase: "error" });
    expect(got.npu.at(-1)).toMatchObject({ running: false });
    expect(got.npu.at(-1).lines).toContain("trying setting 1");
    expect(got.bench.at(-1)).toMatchObject({ running: false });
    expect(got.lab.at(-1)).toMatchObject({ running: false });
    expect(got.run.at(-1)).toMatchObject({ runId: "r1", type: "exit", stopped: true });
  });

  it("does not touch what had already finished", async () => {
    const { createTauriApi } = await import("../src/renderer/tauriBridge");
    const api: any = createTauriApi();
    await new Promise((r) => setTimeout(r, 0));
    const installs: any[] = [];
    api.onInstall((p: any) => installs.push(p));
    emit("install", { ref: "done/one:Q4", phase: "done", percent: 100 });
    emit("sidecarExited", { generation: 4 });
    expect(installs.filter((p) => p.ref === "done/one:Q4" && p.phase === "error")).toEqual([]);
  });
});
