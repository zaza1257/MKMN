// The pure pieces of the GenieX CLI surface MKMN drives: the exact `geniex pull`
// argument list for every documented option, and the parsing of `geniex config list`.
// The CLI itself is only exercised where a fake can stand in (the pull spawn below).
import { describe, expect, it } from "vitest";
import { pullArgs, parseConfigList, pullModel, setModelType } from "../src/core/geniex";

describe("geniex pull arguments", () => {
  it("sends a plain pull with no options", () => {
    expect(pullArgs("org/model:Q4_0", undefined)).toEqual(["pull", "org/model:Q4_0"]);
    expect(pullArgs("org/model:Q4_0", {})).toEqual(["pull", "org/model:Q4_0"]);
  });

  it("passes the entry's known source as --model-hub", () => {
    // geniex's own detection can misread a short docker name as an HF repo, so a
    // known source is always stated.
    expect(pullArgs("qaihub/model", { modelHub: "aihub" })).toEqual(["pull", "qaihub/model", "--model-hub", "aihub"]);
    expect(pullArgs("user/img", { modelHub: "docker" })).toEqual(["pull", "user/img", "--model-hub", "docker"]);
  });

  it("prefers --local-path for a local import and never sends --model-hub beside it", () => {
    expect(pullArgs("local/mine", { localPath: "C:/models/mine", modelHub: "localfs" }))
      .toEqual(["pull", "local/mine", "--local-path", "C:/models/mine"]);
  });

  it("passes the model type when known", () => {
    expect(pullArgs("local/mine", { localPath: "C:/m", modelType: "vlm" }))
      .toEqual(["pull", "local/mine", "--local-path", "C:/m", "--model-type", "vlm"]);
    expect(pullArgs("org/m", { modelHub: "hf", modelType: "llm" }))
      .toEqual(["pull", "org/m", "--model-hub", "hf", "--model-type", "llm"]);
  });

  it("pulls a local path through the real spawn path with the options attached", async () => {
    const seen: string[][] = [];
    const { EventEmitter } = await import("node:events");
    const mk = () => { const e: any = new EventEmitter(); e.stdout = new EventEmitter(); e.stderr = new EventEmitter(); e.kill = () => {}; return e; };
    const child = mk();
    const spy = ((_exe: string, args: string[]) => { seen.push(args); return child; }) as any;
    const p = pullModel("geniex", "local/mine", () => undefined, spy, { localPath: "C:/models/mine", modelType: "llm" });
    child.stdout.emit("data", Buffer.from("done\n"));
    child.emit("close", 0);
    await p.done;
    expect(seen[0]).toContain("--local-path");
    expect(seen[0]).toContain("C:/models/mine");
    expect(seen[0]).toContain("--model-type");
    expect(seen[0]).not.toContain("--model-hub");
  });
});

describe("geniex config list parsing", () => {
  it("reads both key: value and key = value rows", () => {
    const r = parseConfigList("chipset: Snapdragon X Elite CRD\nruntime = 0.10.0\n");
    expect(r.rows).toEqual([
      { key: "chipset", value: "Snapdragon X Elite CRD" },
      { key: "runtime", value: "0.10.0" },
    ]);
    expect(r.other).toEqual([]);
  });

  it("keeps unrecognized lines instead of guessing them into rows", () => {
    const r = parseConfigList("just a header\n\n==== section ====");
    expect(r.rows).toEqual([]);
    expect(r.other).toEqual(["just a header", "==== section ===="]);
  });

  it("strips terminal color sequences before parsing", () => {
    const r = parseConfigList("\x1b[1mchipset\x1b[0m: \x1b[32mX Elite\x1b[0m");
    expect(r.rows).toEqual([{ key: "chipset", value: "X Elite" }]);
  });
});

describe("geniex model set-type guard", () => {
  it("refuses an empty model name without touching the CLI", async () => {
    const r = await setModelType("geniex", "", "vlm");
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/model reference/i);
  });
});
