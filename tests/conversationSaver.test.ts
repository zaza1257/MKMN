import { describe, it, expect, vi, beforeEach } from "vitest";
import { createConversationSaver, SAVE_MIN_INTERVAL_MS, type ConversationSaver } from "../src/renderer/conversationSaver";
import { persistableConversations, type Conversation } from "../src/renderer/store";

/**
 * Contract tests of the debounced chat saver (src/renderer/conversationSaver.ts):
 * streamed tokens write at most once every SAVE_MIN_INTERVAL_MS, a turn end / a hidden
 * window / an orderly exit write at once, and what lands in storage is exactly what the
 * eager saver used to write (one persistable copy, handed to both writers).
 * Clock, timers and storage are faked.
 */

let clock = 0;
interface FakeTimer { fn: () => void; at: number }
let timers: FakeTimer[] = [];
let storage: Map<string, string> | null = null;
let writes = 0;
const hostCopies: Conversation[][] = [];

function tick(ms: number) {
  clock += ms;
  for (;;) {
    const due = timers.filter((t) => t.at <= clock).sort((a, b) => a.at - b.at)[0];
    if (!due) break;
    timers.splice(timers.indexOf(due), 1);
    due.fn();
  }
}

function makeConv(id: string, content: string): Conversation {
  return { id, title: `Chat ${id}`, updated: 1000, turns: [{ role: "user", content: `hello ${id}` }, { role: "assistant", content, pending: false }] };
}

function makeSaver(): ConversationSaver {
  writes = 0;
  hostCopies.length = 0;
  return createConversationSaver({
    now: () => clock,
    write: (clean) => {
      writes++;
      try { localStorage.setItem("opennpu.conversations", JSON.stringify(clean)); return { ok: true }; }
      catch { return { ok: false, error: "storage refused" }; }
    },
    writeHost: (clean) => { hostCopies.push(clean); },
    onResult: () => undefined,
    setTimer: (fn, ms) => { const t: FakeTimer = { fn, at: clock + ms }; timers.push(t); return t; },
    clearTimer: (t) => { const i = timers.indexOf(t as FakeTimer); if (i >= 0) timers.splice(i, 1); }
  });
}

beforeEach(() => {
  clock = 0;
  timers = [];
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storage!.get(k) ?? null,
    setItem: (k: string, v: string) => { storage!.set(k, v); },
    removeItem: (k: string) => { storage!.delete(k); },
    clear: () => storage!.clear()
  });
});

describe("conversation saver — throttling while a turn streams", () => {
  it("100 token events within 1 s give at most 1 write", () => {
    const saver = makeSaver();
    const c0 = [makeConv("c1", "a")];
    saver.touch(c0, 1); // the turn starts (pending 0 -> 1): one write at once
    expect(writes).toBe(1);
    tick(100);
    // 100 streamed tokens in one second: the pending count never changes, so the
    // saver may write at most once per SAVE_MIN_INTERVAL_MS
    for (let i = 0; i < 100; i++) {
      saver.touch([makeConv("c1", "a".repeat(i + 1))], 1);
      tick(10);
    }
    expect(writes).toBeLessThanOrEqual(2); // at most the burst's one throttled write since the turn start
    expect(clock).toBeLessThan(SAVE_MIN_INTERVAL_MS);
  });

  it("the throttled write lands when the interval elapsed, not before", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 1); // turn start: write at once
    tick(200);
    saver.touch([makeConv("c1", "ab")], 1); // token: too soon, a timer is scheduled
    expect(writes).toBe(1);
    tick(SAVE_MIN_INTERVAL_MS);
    expect(writes).toBe(2); // the throttled write fired
    expect(storage!.get("opennpu.conversations")).toBe(JSON.stringify(persistableConversations([makeConv("c1", "ab")])));
  });

  it("a second token burst does not stack timers: at most one pending write", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 1);
    tick(200);
    saver.touch([makeConv("c1", "ab")], 1);
    const pendingBefore = timers.length;
    saver.touch([makeConv("c1", "abc")], 1);
    expect(timers.length).toBe(pendingBefore);
  });
});

describe("conversation saver — flushes at once", () => {
  it("a done event (pending count drops) writes at once", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 1);
    tick(100);
    saver.touch([makeConv("c1", "ab")], 1); // token: throttled
    expect(writes).toBe(1);
    const done = [makeConv("c1", "ab done")];
    saver.touch(done, 0); // done: pending 1 -> 0, flush now
    expect(writes).toBe(2);
    expect(storage!.get("opennpu.conversations")).toBe(JSON.stringify(persistableConversations(done)));
    expect(timers.length).toBe(0); // the pending throttled write was replaced
  });

  it("an error event (pending count drops) writes at once too", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 2); // two turns streaming
    tick(50);
    const afterError = [makeConv("c1", "x")];
    saver.touch(afterError, 1); // one turn errored: 2 -> 1, flush now
    expect(writes).toBe(2);
  });

  it("a change while nothing streams (created, deleted, renamed) writes at once", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 0);
    expect(writes).toBe(1);
    tick(10);
    saver.touch([makeConv("c1", "a"), makeConv("c2", "b")], 0); // a conversation was created
    expect(writes).toBe(2);
    tick(10);
    saver.touch([makeConv("c1-renamed", "a")], 0); // renamed or deleted
    expect(writes).toBe(3);
  });

  it("flushNow (window hidden, page hidden or closed, host shutdown) writes at once", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 1);
    tick(50);
    saver.touch([makeConv("c1", "ab")], 1); // token: throttled, nothing written
    expect(writes).toBe(1);
    const latest = [makeConv("c1", "ab c")];
    saver.flushNow(latest);
    expect(writes).toBe(2);
    expect(storage!.get("opennpu.conversations")).toBe(JSON.stringify(persistableConversations(latest)));
  });

  it("flushNow without a pending change writes nothing new", () => {
    const saver = makeSaver();
    saver.touch([makeConv("c1", "a")], 0);
    saver.flushNow(); // the host shutdown with nothing new since the last write
    expect(writes).toBe(1);
  });
});

describe("conversation saver — what is saved", () => {
  it("the saved content equals what the eager saver would have saved", () => {
    const saver = makeSaver();
    const convs = [
      { ...makeConv("c1", "answer"), turns: [{ role: "user" as const, content: "hi" }, { role: "assistant" as const, content: "answer", pending: true }] },
      { ...makeConv("c2", "b"), turns: [{ role: "user" as const, content: "q", attachments: [{ kind: "image" as const, dataUrl: "data:image/png;base64,AAAA", mediaId: "m1" }] }] }
    ];
    saver.touch(convs as Conversation[], 0);
    const saved = JSON.parse(storage!.get("opennpu.conversations")!) as Conversation[];
    expect(saved).toEqual(persistableConversations(convs as Conversation[]));
  });

  it("both writers get the ONE persistable copy, computed once per save", () => {
    const saver = makeSaver();
    const convs = [makeConv("c1", "a")];
    saver.touch(convs, 0);
    expect(hostCopies.length).toBe(1);
    expect(hostCopies[0]).toEqual(persistableConversations(convs));
    saver.flushNow(convs); // an explicit flush (the exit paths pass the chats themselves)
    expect(hostCopies.length).toBe(2);
    expect(hostCopies[1]).toEqual(persistableConversations(convs));
  });
});

// ---- The Tauri bridge: one stored key, the old key read-only, the shutdown flush ----

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: () => true,
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

/** The host events the bridge subscribed to, by name (captured from the listen mock). */
const hostEvents = new Map<string, (e: unknown) => void>();

beforeEach(async () => {
  const ev = await import("@tauri-apps/api/event");
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockReset();
  (ev.listen as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (name: string, handler: (e: unknown) => void) => {
    hostEvents.set(name, handler);
    return () => {};
  });
});

async function bridgeApi() {
  vi.resetModules();
  const { createTauriApi } = await import("../src/renderer/tauriBridge");
  const a = createTauriApi();
  await new Promise((r) => setTimeout(r, 0)); // let the listen() promises settle
  return a;
}

describe("tauri bridge — the chats live under ONE key", () => {
  it("saveConversations no longer writes the second key", async () => {
    const a = await bridgeApi();
    await a.saveConversations([{ id: "c1", title: "Chat", updated: 1, turns: [] }]);
    expect(storage!.has("mkmn.conversations")).toBe(false);
  });

  it("conversations() reads the old key's content when the kept key is missing (migration)", async () => {
    const old = JSON.stringify([{ id: "old", title: "Old copy", updated: 1, turns: [] }]);
    storage!.set("mkmn.conversations", old);
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "old", title: "Old copy", updated: 1, turns: [] }]);
  });

  it("conversations() falls back to the kept key when the old key is absent", async () => {
    const kept = JSON.stringify([{ id: "kept", title: "Kept copy", updated: 2, turns: [] }]);
    storage!.set("opennpu.conversations", kept);
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "kept", title: "Kept copy", updated: 2, turns: [] }]);
  });

  it("a chat deleted under the kept key does not come back from the stale old key", async () => {
    // The kept key is authoritative: the old second key still holds a chat that was deleted
    // after the migration, and it must not be served again.
    const kept = JSON.stringify([{ id: "c1", title: "Kept c1", updated: 2, turns: [] }]);
    const old = JSON.stringify([
      { id: "c1", title: "Old c1", updated: 1, turns: [] },
      { id: "c2", title: "Deleted c2", updated: 1, turns: [] },
    ]);
    storage!.set("opennpu.conversations", kept);
    storage!.set("mkmn.conversations", old);
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "c1", title: "Kept c1", updated: 2, turns: [] }]);
  });

  it("an old-key-only profile keeps its chats (migration once)", async () => {
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]));
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]);
  });

  it("the old key is gone after the first start, whether or not it held chats", async () => {
    storage!.set("opennpu.conversations", JSON.stringify([{ id: "k", title: "Kept", updated: 1, turns: [] }]));
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "stale", title: "Stale", updated: 9, turns: [] }]));
    const a = await bridgeApi();
    await a.conversations();
    expect(storage!.has("mkmn.conversations")).toBe(false);
  });

  // ---- the old copy is only forgotten once a save has landed under the kept key ----

  it("an old-key-only profile KEEPS its copy in storage: the migration read does not delete the only copy", async () => {
    // On the old code the key was removed on the very first read — before any save had
    // landed under the kept key — so a window that died before its first save lost its
    // chats for good.
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]));
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]);
    expect(storage!.has("mkmn.conversations")).toBe(true);
  });

  it("the old key is read at most once per session, even while it is kept in place", async () => {
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]));
    const a = await bridgeApi();
    expect(await a.conversations()).toEqual([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]);
    // a second (older-build) write lands under the old key meanwhile: it is not read again
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "later", title: "Later", updated: 4, turns: [] }]));
    expect(await a.conversations()).toEqual([]);
  });

  it("markLegacyMigrated removes the old copy (the saver calls it once its write reported ok)", async () => {
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]));
    const a = await bridgeApi();
    await a.conversations(); // migrated in memory, the copy stays on disk
    expect(storage!.has("mkmn.conversations")).toBe(true);
    a.markLegacyMigrated();
    expect(storage!.has("mkmn.conversations")).toBe(false);
  });

  it("wired as the app does: a save that reports ok forgets the old copy, a failed save keeps it", async () => {
    storage!.set("mkmn.conversations", JSON.stringify([{ id: "legacy", title: "Legacy", updated: 3, turns: [] }]));
    const a = await bridgeApi();
    await a.conversations();
    // the saver, wired exactly as App.tsx wires it
    let fail = true;
    const saver = createConversationSaver({
      now: () => clock,
      write: (clean) => {
        try { localStorage.setItem("opennpu.conversations", JSON.stringify(clean)); return fail ? { ok: false, error: "storage refused" } : { ok: true }; }
        catch { return { ok: false, error: "storage refused" }; }
      },
      onResult: (saved) => { if (saved.ok) a.markLegacyMigrated(); }
    });
    saver.flushNow([{ id: "n1", title: "New", updated: 5, turns: [] }]);
    // the write failed: the old copy is still the only copy — it stays
    expect(storage!.has("mkmn.conversations")).toBe(true);
    fail = false;
    saver.flushNow([{ id: "n1", title: "New", updated: 5, turns: [] }]);
    // the write landed under the kept key: the old copy can go
    expect(storage!.has("mkmn.conversations")).toBe(false);
    expect(storage!.has("opennpu.conversations")).toBe(true);
  });

  it("the host's app-shutdown event reaches the registered flush callbacks", async () => {
    const a = await bridgeApi();
    const flushed = vi.fn();
    const off = a.onAppShutdown(flushed);
    const handler = hostEvents.get("app-shutdown");
    expect(handler).toBeTruthy();
    handler!({});
    expect(flushed).toHaveBeenCalledTimes(1);
    handler!({});
    expect(flushed).toHaveBeenCalledTimes(2);
    off();
    handler!({});
    expect(flushed).toHaveBeenCalledTimes(2);
  });
});
