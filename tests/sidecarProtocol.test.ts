import { describe, expect, it } from "vitest";
import { SidecarDispatcher, decodeLine, encodeMessage } from "../src/sidecar/protocol";

describe("sidecar protocol framing", () => {
  it("round-trips every message kind", () => {
    const messages = [
      { t: "req", id: "c-1", method: "hfSearch", args: ["qwen"] },
      { t: "res", id: "c-1", ok: true, result: [{ repo: "x" }] },
      { t: "res", id: "c-2", ok: false, error: "No network" },
      { t: "event", name: "install", payload: { ref: "a", step: 1 } }
    ] as const;
    for (const m of messages) {
      // one line per message: JSON.stringify escapes the line breaks inside strings
      const line = encodeMessage(m as any);
      expect(line).not.toContain("\n");
      expect(decodeLine(line)).toEqual(m);
    }
  });

  it("returns null for junk instead of throwing", () => {
    expect(decodeLine("")).toBeNull();
    expect(decodeLine("not json")).toBeNull();
    expect(decodeLine('{"broken":')).toBeNull();
    expect(decodeLine('{"noType":1}')).toBeNull();
  });
});

describe("SidecarDispatcher", () => {
  it("answers a known method with its result", async () => {
    const d = new SidecarDispatcher();
    d.register("add", (a: number, b: number) => a + b);
    const res = await d.respond({ t: "req", id: "1", method: "add", args: [2, 3] });
    expect(res).toEqual({ t: "res", id: "1", ok: true, result: 5 });
  });

  it("reports an unknown method without throwing", async () => {
    const d = new SidecarDispatcher();
    const res = await d.respond({ t: "req", id: "2", method: "missing", args: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("missing");
  });

  it("turns a handler failure into an error response", async () => {
    const d = new SidecarDispatcher();
    d.register("boom", () => { throw new Error("no disk"); });
    const res = await d.respond({ t: "req", id: "3", method: "boom", args: [] });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("no disk");
  });

  it("round-trips a call to the host through the same dispatcher", async () => {
    const d = new SidecarDispatcher();
    let sent: any = null;
    d.register("pickFolder", () => d.callHost((m: any) => { sent = m; }, "pickFolder"));
    const work = d.respond({ t: "req", id: "4", method: "pickFolder", args: [] });
    await Promise.resolve();
    expect(sent?.t).toBe("req");
    // the host answers; the sidecar's own response to the original request resolves with it
    d.resolveHostResponse({ t: "res", id: sent.id, ok: true, result: "C:\\projects" });
    await expect(work).resolves.toMatchObject({ ok: true, result: "C:\\projects" });
  });

  it("rejects a host call when the host answers with an error", async () => {
    const d = new SidecarDispatcher();
    let sent: any = null;
    d.register("pickFolder", () => d.callHost((m: any) => { sent = m; }, "pickFolder"));
    const work = d.respond({ t: "req", id: "5", method: "pickFolder", args: [] });
    await Promise.resolve();
    d.resolveHostResponse({ t: "res", id: sent.id, ok: false, error: "refused" });
    await expect(work).resolves.toMatchObject({ ok: false, error: "refused" });
  });

  it("ignores a host response nobody waits for", () => {
    const d = new SidecarDispatcher();
    expect(d.resolveHostResponse({ t: "res", id: "ghost", ok: true, result: 1 })).toBe(false);
  });
});
