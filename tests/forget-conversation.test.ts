import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forgetConversation } from "../src/core/harness/forget";
import { createLiveRun } from "../src/core/harness/run";
import { foldOffloadName } from "../src/core/harness/offload";
import { sString } from "../src/core/harness/schema";

/**
 * 2026-11-17 review: chats live in the window's storage and every run a chat starts journals
 * its sections and replies in Workspace\harness, with no retention and no deletion. A chat the
 * person deleted lived on in those files. A run's header now names the chat it served, and
 * deleting the chat (once its Undo is gone) removes those journals, their offloaded payloads
 * and the chat's folded history — and nothing of another chat.
 */

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "mkmn-forget-")); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

async function journal(runId: string, conversationId?: string): Promise<string> {
  const file = path.join(dir, `${runId}.jsonl`);
  const run = createLiveRun({ pipeline: "chat", runId, journalFile: file, ...(conversationId ? { conversationId } : {}) });
  await run.step({ id: "s", kind: "answer", schema: sString(), exec: () => ({ output: "secret answer", reply: "secret answer" }) });
  run.finish();
  return file;
}

describe("deleting a chat deletes its run journals", () => {
  it("writes the chat into the run header", async () => {
    const file = await journal("chat-a-1", "conv-a");
    expect(JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0])).toMatchObject({ type: "run", runId: "chat-a-1", conversationId: "conv-a" });
  });

  it("removes the deleted chat's journals, payloads and folded history, and nothing else", async () => {
    const a1 = await journal("chat-a-1", "conv-a");
    const a2 = await journal("build-a-2", "conv-a");
    const b = await journal("chat-b-1", "conv-b");
    const old = await journal("chat-old-1"); // written before runs named their chat
    const off = path.join(dir, "offload");
    fs.mkdirSync(off);
    for (const n of ["chat-a-1-3-s.txt", "build-a-2-1-w.txt", "chat-b-1-1-s.txt", foldOffloadName("conv-a"), foldOffloadName("conv-ab"), "knowledge-p1.txt"]) fs.writeFileSync(path.join(off, n), "x");

    const r = forgetConversation("conv-a", dir);
    expect(r).toEqual({ journals: 2, payloads: 3 });
    expect([a1, a2].map(fs.existsSync)).toEqual([false, false]);
    expect([b, old].map(fs.existsSync)).toEqual([true, true]);
    expect(fs.readdirSync(off).sort()).toEqual(["chat-b-1-1-s.txt", foldOffloadName("conv-ab"), "knowledge-p1.txt"].sort());
  });

  it("does nothing for an empty id or a missing folder", () => {
    expect(forgetConversation("", dir)).toEqual({ journals: 0, payloads: 0 });
    expect(forgetConversation("x", path.join(dir, "none"))).toEqual({ journals: 0, payloads: 0 });
  });

  it("every run a chat turn starts names the chat, and the chat list forgets after its undo", () => {
    const orch = fs.readFileSync("src/core/chatOrchestrator.ts", "utf8");
    expect((orch.match(/conversationId: String\(opts\.convId\)/g) ?? []).length).toBe(3); // the turn, its build runs, its sub-agents
    expect(orch).toMatch(/pipeline: "compaction",\s*conversationId: convId/);
    const app = fs.readFileSync("src/renderer/App.tsx", "utf8");
    expect(app).toMatch(/setTimeout\(\(\) => \{ setUndoChat\(null\); forget\(gone\.id\); \}, 8000\)/);
  });
});
