import { describe, it, expect, vi, beforeEach } from "vitest";

// The real Tauri bridge, with invoke intercepted and the sidecar-event source faked
// (the same harness as bridge-setup.test.ts).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/**
 * The placement contract: where a model runs is a MEASUREMENT (settings.placements,
 * written by the load test and the benchmark through the sidecar's saveSettings host
 * call), and the bridge must find it under BOTH keys the writers use — the repo-style
 * ref ("unsloth/Qwen3-0.6B-GGUF:Q4_0") and the entry id ("custom:...") — the same
 * both-keys rule dynamicItems already follows.
 *
 * And the badge on a custom model's card must say where the benchmark saw it run even
 * when the placement never landed in settings.json: the SAME local bench record the
 * "Measured here" line reads (hardware.json calibratedProfiles) feeds the badge, so
 * one measurement shows in both places instead of a card claiming "Not measured here"
 * beside its own "Measured here · 135.5 tok/s" line.
 */
import { badgePlacement } from "../src/core/modelList";

const ENTRY = {
  id: "custom:unsloth/qwen3-0.6b-gguf:q4_0",
  name: "Qwen3 0.6B (custom)",
  repo: "unsloth/Qwen3-0.6B-GGUF",
  quant: "Q4_0",
  engine: "llama_cpp" as const,
  role: "chat",
  architecture: "qwen3",
  sizeGB: 0.4,
  recommendedContext: 4096,
  sampling: { temperature: 0.7, top_p: 0.8, max_tokens: 512 },
};
const REF = "unsloth/Qwen3-0.6B-GGUF:Q4_0";

beforeEach(async () => {
  const core = await import("@tauri-apps/api/core");
  (core.invoke as unknown as ReturnType<typeof vi.fn>).mockReset();
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockReset();
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(async () => () => {});
});

async function catalogWithPlacements(placements: Record<string, string>) {
  const core = await import("@tauri-apps/api/core");
  const invoke = core.invoke as unknown as ReturnType<typeof vi.fn>;
  invoke.mockImplementation(async (cmd: string, args?: any) => {
    if (cmd === "get_hardware_cmd") return { ramGB: 32 };
    if (cmd === "get_settings") return { placements };
    if (cmd === "get_installed_models_cmd") return [];
    if (cmd === "sidecar_call") {
      if (args.method === "customEntries") return [ENTRY];
      if (args.method === "foundryEntries") return [];
      if (args.method === "compiledContexts") return {};
      throw new Error(`unexpected sidecar method ${args.method}`);
    }
    throw new Error(`unexpected command ${cmd}`);
  });
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await new Promise((r) => setTimeout(r, 0));
  return a.catalog();
}

describe("the bridge reads a placement under both keys it is written under", () => {
  it("a placement saved under the entry id is found (the ref alone missed it)", async () => {
    const items = await catalogWithPlacements({ [ENTRY.id]: "npu" });
    const item = items.find((i) => i.entry.id === ENTRY.id);
    expect(item?.runsOn).toBe("npu");
  });

  it("a placement saved under the repo-style ref is found too (the control)", async () => {
    const items = await catalogWithPlacements({ [REF]: "hybrid" });
    const item = items.find((i) => i.entry.id === ENTRY.id);
    expect(item?.runsOn).toBe("hybrid");
  });
});

describe("badgePlacement — the badge falls back to the same bench record the Measured-here line reads", () => {
  const unplaced = { entry: ENTRY, runsOn: undefined };

  it("an explicit placement wins and stays a here-measurement", () => {
    expect(badgePlacement({ entry: ENTRY, runsOn: "npu" })).toEqual({ on: "npu", here: true });
  });

  it("no placement but a real bench record: the badge shows where THAT ran, as a here-measurement", () => {
    expect(badgePlacement(unplaced, "npu")).toEqual({ on: "npu", here: true });
    expect(badgePlacement(unplaced, "hybrid")).toEqual({ on: "hybrid", here: true });
  });

  it("no placement and no usable bench record: the badge stays Not measured here", () => {
    expect(badgePlacement(unplaced, undefined)).toEqual({ on: undefined, here: false });
    expect(badgePlacement(unplaced, null)).toEqual({ on: undefined, here: false });
    // an unknown compute string never reaches the badge (its label map has no entry for it)
    expect(badgePlacement(unplaced, "geniex")).toEqual({ on: undefined, here: false });
  });
});
