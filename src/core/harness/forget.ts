// Deleting a chat deletes what the harness kept of it.
//
// Every run a chat starts journals its prompts' sections and its replies in
// Workspace\harness (and long payloads in Workspace\harness\offload). Before the
// 2026-11-17 review nothing removed them: a chat the person deleted lived on in
// those files. A run's header now names the chat it served (`conversationId`), and
// this removes every journal whose header names the deleted chat, the payloads
// those runs offloaded, and the chat's folded-history payload. Journals written
// before the header carried the chat are not matched (they never named it).

import * as fs from "node:fs";
import * as path from "node:path";
import { foldOffloadName } from "./offload";

export type ForgetResult = { journals: number; payloads: number };

/** The run header's chat, read from the journal's first line only. */
function conversationOf(file: string): { runId: string; conversationId?: string } | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString("utf8").split("\n")[0];
    const head = JSON.parse(first);
    return head && head.type === "run" && typeof head.runId === "string" ? head : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function forgetConversation(convId: string, dir: string): ForgetResult {
  const out: ForgetResult = { journals: 0, payloads: 0 };
  if (!convId || !fs.existsSync(dir)) return out;
  const runIds: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(dir, name);
    const head = conversationOf(file);
    if (head?.conversationId !== convId) continue;
    try { fs.rmSync(file, { force: true }); out.journals++; runIds.push(head.runId); } catch { /* kept: logged by the caller's count */ }
  }
  const offload = path.join(dir, "offload");
  if (fs.existsSync(offload)) {
    const fold = foldOffloadName(convId).replace(/\.txt$/, "");
    for (const name of fs.readdirSync(offload)) {
      const mine = name === fold || name.startsWith(`${fold}.`) || runIds.some((r) => name.startsWith(`${r}-`));
      if (!mine) continue;
      try { fs.rmSync(path.join(offload, name), { force: true }); out.payloads++; } catch { /* kept */ }
    }
  }
  return out;
}
