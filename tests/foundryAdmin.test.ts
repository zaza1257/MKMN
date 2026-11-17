import { describe, expect, it } from "vitest";
import {
  FoundryHost,
  parseCacheLocationJson,
  parseCacheLocationText,
  parseConfigJson,
  parseConfigText,
  parseDiagnosticsJson,
  parseModelInfoJson,
  parseModelInfoText,
  parseServerStatusJson,
  parseServerStatusText,
  type FoundryRunner
} from "../src/core/foundryHost";

/**
 * Foundry Local's management surface: its persistent settings, cache location,
 * daemon state, model details (including execution providers) and one-shot
 * transcription. Every command is read in JSON first, with the text table as
 * the fallback older versions print.
 */

describe("Foundry Local management output", () => {
  it("reads config show as JSON and as its table", () => {
    expect(parseConfigJson({
      settings: [
        { key: "port", value: "auto", userSet: false },
        { key: "log-level", value: "debug", userSet: true }
      ]
    })).toEqual([
      { key: "port", value: "auto", userSet: false },
      { key: "log-level", value: "debug", userSet: true }
    ]);
    expect(parseConfigJson({ nothing: true })).toBeNull();

    const table = parseConfigText(`
+---------------------------------------------------------------------------+
| Key                  | Value                                    | Source  |
|----------------------+------------------------------------------+---------|
| port                 | auto                                     | default |
| cache-directory      | C:\\Users\\me\\.foundry\\cache\\models     | user    |
+---------------------------------------------------------------------------+`);
    expect(table).toEqual([
      { key: "port", value: "auto", userSet: false },
      { key: "cache-directory", value: "C:\\Users\\me\\.foundry\\cache\\models", userSet: true }
    ]);
  });

  it("reads cache location from JSON and its note line", () => {
    expect(parseCacheLocationJson({ path: "C:\\cache", userSet: true })).toEqual({ path: "C:\\cache", userSet: true });
    expect(parseCacheLocationJson({ userSet: true })).toBeNull();
    expect(parseCacheLocationText("■ note: C:\\Users\\me\\.foundry\\cache\\models")).toEqual({
      path: "C:\\Users\\me\\.foundry\\cache\\models",
      userSet: false
    });
  });

  it("reads the daemon state from JSON and the text table", () => {
    expect(parseServerStatusJson({
      running: true,
      state: "ready",
      pid: 13412,
      webUrls: ["http://127.0.0.1:50798"],
      startedAt: "2026-11-04T21:22:07Z",
      uptime: "8d 11h",
      logFile: "C:\\log.txt"
    })).toEqual({
      running: true,
      state: "ready",
      pid: 13412,
      webUrls: ["http://127.0.0.1:50798"],
      startedAt: "2026-11-04T21:22:07Z",
      uptime: "8d 11h",
      logFile: "C:\\log.txt"
    });
    expect(parseServerStatusJson({ nothing: true })).toBeNull();

    expect(parseServerStatusText(`State    Ready
PID      13412
Started  2026-11-04 21:22:07Z
Uptime   8d 11h
Web URLs http://127.0.0.1:50798`)).toMatchObject({
      running: true,
      state: "Ready",
      pid: 13412,
      webUrls: ["http://127.0.0.1:50798"]
    });
  });

  it("reads the full diagnostics report", () => {
    const report = parseDiagnosticsJson({
      system: {
        operatingSystem: "Windows 10.0.28000",
        architecture: "Arm64",
        cpu: "Snapdragon X2 Elite",
        logicalCores: 18,
        physicalCores: 18,
        totalMemoryBytes: 33954689024,
        availableMemoryBytes: 12670935040,
        diskPath: "C:\\",
        diskTotalBytes: 1023719501824,
        diskFreeBytes: 84982521856,
        gpus: [{ name: "Adreno X2-90", vendor: null, videoMemoryBytes: 134217728 }],
        npus: [{ name: "Hexagon NPU", vendor: "Qualcomm Technologies, Inc." }]
      },
      service: {
        state: "ready",
        ready: true,
        webUrls: ["http://127.0.0.1:50798"],
        cliVersion: "0.12.1",
        daemonVersion: "0.12.1",
        protocolVersion: 2
      },
      models: { available: 109, loaded: 0, cached: 3 },
      connectivity: { localServiceReachable: true, modelRegistryReachable: true },
      warnings: ["A GPU warning"]
    });
    expect(report?.system?.cpu).toBe("Snapdragon X2 Elite");
    expect(report?.system?.gpus[0]).toEqual({ name: "Adreno X2-90", vendor: null, videoMemoryBytes: 134217728 });
    expect(report?.service?.versions).toEqual({ cliVersion: "0.12.1", daemonVersion: "0.12.1", protocolVersion: "2" });
    expect(report?.models).toEqual({ available: 109, loaded: 0, cached: 3 });
    expect(report?.connectivity).toEqual({ localServiceReachable: true, modelRegistryReachable: true });
    expect(report?.warnings).toEqual(["A GPU warning"]);
    expect(parseDiagnosticsJson({ nothing: true })).toBeNull();
  });

  it("reads model details and every variant's execution provider", () => {
    const info = parseModelInfoJson({
      model: {
        alias: "qwen3-0.6b",
        id: "qwen3-0.6b-generic-cpu:4",
        displayName: "qwen3-0.6b-generic-cpu",
        source: "Public",
        type: "Chat",
        device: "Cpu",
        publisher: "Microsoft",
        license: "apache-2.0",
        fileSizeMb: 593,
        cached: true,
        supportsToolCalling: true,
        variants: [
          { id: "qwen3-0.6b-generic-gpu:2", displayName: "GPU build", device: "Gpu", executionProvider: "WebGPUExecutionProvider", fileSizeMb: 529, cached: false },
          { id: "qwen3-0.6b-generic-cpu:4", displayName: "CPU build", device: "Cpu", executionProvider: "CPUExecutionProvider", fileSizeMb: 593, cached: true }
        ]
      }
    });
    expect(info).toMatchObject({
      alias: "qwen3-0.6b",
      task: "Chat",
      device: "CPU",
      sizeGB: 0.58,
      cached: true,
      supportsToolCalling: true
    });
    expect(info?.variants.map((v) => `${v.device}/${v.executionProvider}`)).toEqual([
      "GPU/WebGPUExecutionProvider",
      "CPU/CPUExecutionProvider"
    ]);
    expect(parseModelInfoText(`+------------------------+
| Field     | Value      |
|-----------+------------|
| Alias     | qwen3-0.6b |
| Type      | Chat       |
| Publisher | Microsoft  |
| License   | apache-2.0 |
| Tools     | Yes        |
+------------------------+`)).toMatchObject({ alias: "qwen3-0.6b", task: "Chat", publisher: "Microsoft", supportsToolCalling: true });
  });
});

describe("FoundryHost management commands", () => {
  it("reads and writes settings with --force, and resets one or all", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "config show -o json") {
        return { code: 0, out: JSON.stringify({ settings: [{ key: "port", value: "auto", userSet: false }] }) };
      }
      if (cmd.startsWith("config set ") || cmd.startsWith("config reset")) return { code: 0, out: "saved" };
      return { code: 1, out: "unexpected" };
    };
    const host = new FoundryHost(run);
    expect(await host.config()).toEqual([{ key: "port", value: "auto", userSet: false }]);
    expect(await host.configSet("port", "0")).toMatchObject({ ok: true });
    expect(await host.configReset("port")).toMatchObject({ ok: true });
    expect(await host.configReset()).toMatchObject({ ok: true });
    expect(calls).toEqual([
      "config show -o json",
      "config set port 0 --force",
      "config reset port --force",
      "config reset --force"
    ]);
    expect(await host.configSet("not-a-setting", "x")).toMatchObject({ ok: false });
  });

  it("reads the cache location and changes or clears the cache", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "cache location -o json") return { code: 0, out: '{"path":"C:\\\\cache","userSet":true}' };
      if (cmd === "cache list -o json") return { code: 0, out: '{"models":[]}' };
      if (cmd === "cache cd D:\\models --force") return { code: 0, out: "cache moved" };
      if (cmd === "cache remove --force") return { code: 0, out: "all removed" };
      return { code: 1, out: "unexpected" };
    };
    const host = new FoundryHost(run);
    expect(await host.cacheLocation()).toEqual({ path: "C:\\cache", userSet: true });
    expect(await host.cacheSet("D:\\models")).toMatchObject({ ok: true });
    expect(await host.cacheRemove()).toMatchObject({ ok: true });
    expect(calls).toContain("cache cd D:\\models --force");
    expect(calls).toContain("cache remove --force");
  });

  it("starts the daemon with an explicit port and reads the address back", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "server start --port 0 --idle-timeout 0") return { code: 0, out: "started" };
      if (cmd === "server status -o json") {
        return { code: 0, out: '{"running":true,"state":"ready","pid":7,"webUrls":["http://127.0.0.1:5001"]}' };
      }
      return { code: 1, out: "unexpected" };
    };
    const host = new FoundryHost(run);
    const r = await host.serverAction("start", { port: 0, idleTimeoutMinutes: 0 });
    expect(r.ok).toBe(true);
    expect(r.server).toMatchObject({ running: true, webUrls: ["http://127.0.0.1:5001"], pid: 7 });
    expect(calls).toEqual(["server start --port 0 --idle-timeout 0", "server status -o json"]);
    expect(await host.serverAction("start", { port: 70000 })).toMatchObject({ ok: false });
  });

  it("registers, unregisters, and transcribes with the documented options", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd.startsWith("model register ")) return { code: 0, out: "registered" };
      if (cmd.startsWith("model unregister ")) return { code: 0, out: "unregistered" };
      if (cmd.startsWith("transcribe ")) return { code: 0, out: '{"text":"hello there"}' };
      return { code: 1, out: "unexpected" };
    };
    const host = new FoundryHost(run);
    expect(await host.registerModel({
      path: "C:\\models\\mine",
      modelId: "mine:1",
      task: "chat-completion",
      displayName: "Mine",
      device: "cpu",
      executionProvider: "CPUExecutionProvider",
      contextLength: 4096
    })).toMatchObject({ ok: true });
    expect(calls[0]).toBe("model register C:\\models\\mine mine:1 --task chat-completion --display-name Mine --device cpu --execution-provider CPUExecutionProvider --context-length 4096");
    expect(await host.unregisterModel("mine:1")).toMatchObject({ ok: true });
    expect(await host.transcribe({ file: "C:\\audio\\note.wav", model: "whisper-tiny", language: "en" })).toEqual({ ok: true, text: "hello there" });
    expect(calls).toContain("transcribe -f C:\\audio\\note.wav -m whisper-tiny -l en -o json");
    expect(await host.registerModel({ path: "C:\\models\\mine", modelId: "mine", task: "chat-completion" })).toMatchObject({ ok: false });
  });

  it("loads and unloads one cached model by name", async () => {
    const calls: string[] = [];
    const run: FoundryRunner = async (args) => {
      const cmd = args.join(" ");
      calls.push(cmd);
      if (cmd === "cache list -o json") {
        return { code: 0, out: JSON.stringify({ models: [{ alias: "qwen3-0.6b", device: "Cpu", fileSizeMB: 593, cached: true }] }) };
      }
      if (cmd === "server status") return { code: 0, out: "State Ready\nWeb URLs http://127.0.0.1:5001" };
      if (cmd === "model load qwen3-0.6b") return { code: 0, out: "Loaded 'qwen3-0.6b' (CPU variant 'qwen3-0.6b-generic-cpu:4') into memory" };
      if (cmd === "model unload qwen3-0.6b") return { code: 0, out: "unloaded" };
      return { code: 0, out: "{}" };
    };
    const fetchFn = (async (url: string) => {
      if (String(url).endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "qwen3-0.6b-generic-cpu:4" }] }), { status: 200 });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const host = new FoundryHost(run, () => undefined, fetchFn);
    expect(await host.loadModel("qwen3-0.6b", "CPU")).toMatchObject({ ok: true });
    expect(calls).toContain("model load qwen3-0.6b");
    expect(await host.unloadModel("qwen3-0.6b")).toMatchObject({ ok: true });
    expect(calls).toContain("model unload qwen3-0.6b");
  });
});
