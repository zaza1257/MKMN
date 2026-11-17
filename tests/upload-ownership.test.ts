/**
 * Upload ownership (Round 3, problem 2): every addFiles run has an identity and a conversation
 * it belongs to. Overlapping runs, chat switches, Cancel, unmount, and an older run finishing
 * after a newer one started — a dead run must never append to the composer, never write a
 * notice over a newer run's, and never take the newer run's Cancel button down. The reads are
 * fakes with deferred promises, so each scenario controls the exact interleaving.
 */
import { describe, expect, it } from "vitest";
import { UploadManager, type UploadEnv, type UploadIo } from "../src/renderer/uploads";
import type { Attachment } from "../src/shared/types";

const file = (name: string, type = "text/plain") => new File(["body"], name, { type });

/** A manual promise: the test decides when a read resolves, and an abort rejects it. */
function deferred() {
  let res!: (v: string) => void;
  let rej!: (e: unknown) => void;
  const p = new Promise<string>((r, j) => { res = r; rej = j; });
  return { p, res, rej };
}

/** A world to test in: the fake reads record every call and hand the test the deferred promises. */
function world() {
  const env = {
    conv: "c1",
    currentConv: () => env.conv,
    appended: [] as Attachment[],
    appendFiles: (fs: Attachment[]) => { env.appended.push(...fs); },
    notice: undefined as string | null | undefined,
    setNotice: (n: string | null) => { env.notice = n; },
    reading: false,
    setReading: (on: boolean) => { env.reading = on; },
    canSee: () => true,
  };
  const reads: { name: string; d: ReturnType<typeof deferred>; signal: AbortSignal | null }[] = [];
  const io: UploadIo = {
    readPdf: (f, o) => { const d = deferred(); reads.push({ name: f.name, d, signal: o.signal }); o.signal.addEventListener("abort", () => d.rej(new DOMException("PDF reading was stopped", "AbortError"))); return d.p; },
    readDocument: (f) => { const d = deferred(); reads.push({ name: f.name, d, signal: null }); return d.p; },
    saveMedia: async () => ({ mediaId: "m" }),
    readImage: (f) => { const d = deferred(); reads.push({ name: f.name, d, signal: null }); return d.p; },
    readText: (f) => { const d = deferred(); reads.push({ name: f.name, d, signal: null }); return d.p; },
  };
  const full: UploadEnv = env;
  const mgr = new UploadManager(io, full);
  const read = (name: string) => reads.filter((r) => r.name === name);
  return { mgr, env, io, reads, read };
}

describe("upload runs own their conversation", () => {
  it("a newer addFiles run supersedes the older one: its in-flight read is aborted and it appends nothing more", async () => {
    const w = world();
    const a = w.mgr.add([file("a.pdf", "application/pdf"), file("a2.txt")]);
    const ra = w.read("a.pdf")[0];
    expect(w.env.reading).toBe(true);
    // the newer run starts while the older one is mid-read
    const b = w.mgr.add([file("b.txt")]);
    expect(ra.signal!.aborted).toBe(true); // the older read is signalled to stop
    await expect(ra.d.p).rejects.toMatchObject({ name: "AbortError" });
    // the older run's finally must not take the Cancel button down: the newer run is still reading
    expect(w.env.reading).toBe(true);
    w.read("b.txt")[0].d.res("b text");
    await Promise.allSettled([a, b.catch(() => {})]);
    // only the newer run's file is in the composer; the older run's second file was never read
    expect(w.env.appended.map((f) => f.name)).toEqual(["b.txt"]);
    expect(w.read("a2.txt")).toHaveLength(0);
    // the older run took nothing down: the Cancel button state belongs to the newest run until it finishes
    expect(w.env.reading).toBe(false); // the newest run finished; the older one's finally may not have kept it on
    expect(w.env.notice).toBeNull(); // the newer run's clean notice stands; the older one wrote nothing over it
  });

  it("switching chats mid-read stops the run: nothing lands in the new chat", async () => {
    const w = world();
    const run = w.mgr.add([file("a.pdf", "application/pdf"), file("a2.txt")]);
    const ra = w.read("a.pdf")[0];
    // the Chat effect for a conversation change: cancel the run and take the Cancel button down
    w.env.conv = "c2";
    w.mgr.cancel();
    w.env.setReading(false);
    // the read itself resolves late (it was already in flight)
    ra.d.res("a text");
    await run;
    expect(w.env.appended).toEqual([]); // nothing was appended, not even the fully read file
    expect(w.read("a2.txt")).toHaveLength(0); // the second file was never read
    expect(w.env.reading).toBe(false);
  });

  it("Cancel after one file of a batch: the read file is kept, the rest are not read, and the notice explains the partial batch", async () => {
    const w = world();
    const tick = () => new Promise((r) => setTimeout(r, 0));
    const run = w.mgr.add([file("1.txt"), file("2.txt"), file("3.txt")]);
    w.read("1.txt")[0].d.res("one");
    await tick(); await tick(); // let the append of the first file land and the loop reach the second file
    expect(w.env.appended.map((f) => f.name)).toEqual(["1.txt"]);
    w.mgr.cancel(); // the person pressed Cancel
    await run;
    expect(w.env.appended.map((f) => f.name)).toEqual(["1.txt"]); // what was read stays
    expect(w.env.appended).toHaveLength(1); // the rest are never appended, whatever read had already started
    expect(w.env.reading).toBe(false); // the Cancel button goes down
    expect(w.env.notice).toContain("1 of 3"); // the interface explains the partial batch
    expect(w.env.notice).toContain("not read");
  });

  it("closing the chat (unmount) stops the run and nothing arrives afterwards", async () => {
    const w = world();
    const run = w.mgr.add([file("a.pdf", "application/pdf"), file("a2.txt")]);
    const ra = w.read("a.pdf")[0];
    // the Chat unmount effect: cancel + take the Cancel button down
    w.mgr.cancel();
    w.env.setReading(false);
    ra.d.res("late text"); // the read resolves after the unmount
    await run;
    expect(w.env.appended).toEqual([]);
    expect(w.read("a2.txt")).toHaveLength(0);
    expect(w.env.reading).toBe(false);
  });

  it("an older run finishing after a newer one started appends nothing and does not touch the newer run's state", async () => {
    const w = world();
    // the older run reads a document (not cancellable mid-read)
    const older = w.mgr.add([file("old.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")]);
    const ro = w.read("old.docx")[0];
    ro.d.res("old text"); // the read completes, but the older run has not resumed from it yet
    // a newer run starts (superseding the older one) and finishes completely
    const newer = w.mgr.add([file("new.txt")]);
    w.read("new.txt")[0].d.res("new text");
    await newer;
    expect(w.env.appended.map((f) => f.name)).toEqual(["new.txt"]);
    expect(w.env.reading).toBe(false);
    w.env.setNotice("the newer run's notice");
    // only NOW the older run resumes from its completed read
    await older;
    expect(w.env.appended.map((f) => f.name)).toEqual(["new.txt"]); // the stale document is discarded
    expect(w.env.notice).toBe("the newer run's notice"); // the stale run wrote nothing over it
    expect(w.env.reading).toBe(false); // and did not toggle the reading state back on
  });

  it("a conversation change alone (no cancel) stops the run: the guard is the conversation itself", async () => {
    const w = world();
    const run = w.mgr.add([file("a.txt"), file("b.txt")]);
    w.read("a.txt")[0].d.res("a text");
    await new Promise((r) => setTimeout(r, 0));
    expect(w.env.appended.map((f) => f.name)).toEqual(["a.txt"]); // read while the run still owned the chat
    // the conversation changes WITHOUT anyone cancelling: the run no longer owns a chat
    w.env.conv = "c9";
    w.read("b.txt")[0].d.res("b text");
    await run;
    expect(w.env.appended.map((f) => f.name)).toEqual(["a.txt"]); // nothing of the run lands in the new chat
    expect(w.env.reading).toBe(false);
  });

  it("a run that fails one file keeps going through the batch and names the reason", async () => {
    const w = world();
    const run = w.mgr.add([file("bad.pdf", "application/pdf"), file("good.txt")]);
    const rb = w.read("bad.pdf")[0];
    rb.d.rej(new Error("Invalid PDF structure"));
    await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0));
    w.read("good.txt")[0].d.res("good text");
    await run;
    expect(w.env.appended.map((f) => f.name)).toEqual(["good.txt"]); // the batch continues past a failure
    expect(w.env.notice).toContain("bad.pdf");
    expect(w.env.notice).not.toContain("Invalid PDF structure"); // a parser message stays out: the sanitized category only
  });
});
