import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/**
 * A scheduled task carries a copy of its project (the scheduler runs in the
 * sidecar, which cannot read the project store). The copy was taken only when the
 * TASK was saved: editing the project later, or deleting it, left the old
 * instructions and files in every scheduled run. Saving a project now refreshes
 * the copy of each of its tasks, and deleting it removes the copy.
 */

let saved: any[];

function storage(seed: Record<string, unknown>): Storage {
  const m = new Map<string, string>(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear(), key: () => null, get length() { return m.size; } } as unknown as Storage;
}

const P1 = { id: "p1", name: "Alpha", description: "", instructions: "old rules", files: [], created: 1, updated: 1 };
const TASK = { id: "t1", name: "Digest", prompt: "x", projectId: "p1", project: P1, modelId: null, enabled: true, schedule: { kind: "daily", time: "08:00" }, runs: [] };
const LONE = { ...TASK, id: "t2", projectId: null, project: null };

beforeEach(async () => {
  saved = [];
  vi.stubGlobal("localStorage", storage({ "mkmn.projects": [P1], "mkmn.tasks": [TASK, LONE] }));
  const core = await import("@tauri-apps/api/core");
  (core.invoke as any).mockReset();
  (core.invoke as any).mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "sidecar_call" && args.method === "saveTask") { saved.push(args.args[0]); return [args.args[0]]; }
    return null;
  });
});

async function api() {
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  return createTauriApi();
}

describe("a task's copy of its project follows the project", () => {
  it("saving the project refreshes the copy its tasks carry, and only theirs", async () => {
    await (await api()).saveProject({ ...P1, instructions: "new rules" } as any);
    expect(saved.map((t) => t.id)).toEqual(["t1"]);
    expect(saved[0].project.instructions).toBe("new rules");
  });

  it("deleting the project removes the copy from its tasks", async () => {
    await (await api()).deleteProject("p1");
    expect(saved.map((t) => t.id)).toEqual(["t1"]);
    expect(saved[0].projectId).toBeNull();
    expect(saved[0].project).toBeNull();
  });
});
