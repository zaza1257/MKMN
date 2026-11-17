import { beforeEach, describe, expect, it } from "vitest";
import { loadConversations, persistableConversations } from "../src/renderer/store";

const saved = new Map<string, string>();
beforeEach(() => {
  saved.clear();
  (globalThis as any).localStorage = {
    getItem: (k: string) => saved.get(k) ?? null,
    setItem: (k: string, v: string) => { saved.set(k, v); },
    removeItem: (k: string) => { saved.delete(k); }
  };
});

const conversation = (status: "done" | "unresolved" | "running") => [{
  id: "c1", title: "chat", updated: 1,
  turns: [{ role: "assistant" as const, content: "", build: { status, steps: [] } }]
}] as any;

describe("what a saved build remembers", () => {
  it("keeps an unresolved build unresolved when it is saved and read back", () => {
    const out = persistableConversations(conversation("unresolved"));
    expect(out[0].turns[0].build.status).toBe("unresolved");
    saved.set("opennpu.conversations", JSON.stringify(out));
    expect(loadConversations()[0].turns[0].build!.status).toBe("unresolved");
  });

  it("still reads a clean build back as done, and never leaves a live run", () => {
    saved.set("opennpu.conversations", JSON.stringify([{ id: "c1", title: "chat", updated: 1, turns: [{ role: "assistant", content: "", build: { status: "done", steps: [] } }] }]));
    expect(loadConversations()[0].turns[0].build!.status).toBe("done");
    expect(persistableConversations(conversation("running"))[0].turns[0].build!.status).toBe("done");
  });
});
