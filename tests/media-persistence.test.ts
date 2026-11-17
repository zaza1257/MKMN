import { describe, expect, it, vi, beforeEach } from "vitest";
import { adoptInlineMedia, hydrateConversations, loadConversations, mergeConversations, persistableConversations, resetConversations, saveConversations, type Conversation } from "../src/renderer/store";
import { userContent } from "../src/core/attachments";
import { documentText } from "../src/core/officeRead";
import { toBytes, writeZip } from "../src/core/zip";
import type { Attachment } from "../src/shared/types";

const DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const storeMap = new Map<string, string>();
let failNextWrites = 0;
beforeEach(() => {
  storeMap.clear();
  failNextWrites = 0;
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => storeMap.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failNextWrites > 0) { failNextWrites--; throw new Error("QuotaExceededError"); }
      storeMap.set(k, String(v));
    },
    removeItem: (k: string) => storeMap.delete(k),
    clear: () => storeMap.clear()
  });
});

const image = (over: Partial<Attachment> = {}): Attachment => ({ name: "p.png", kind: "image", size: 68, dataUrl: DATA_URL, ...over });

describe("media persistence and storage durability", () => {
  it("P1: a saved chat keeps the media id, not the picture bytes", () => {
    const conv: Conversation = {
      id: "c1", title: "c", updated: 1,
      turns: [{ role: "user", content: "look", attachments: [image({ mediaId: "11111111-1111-1111-1111-111111111111" })] }]
    };
    const saved = persistableConversations([conv]);
    expect(saved[0].turns[0].attachments![0].dataUrl).toBeUndefined();
    expect(saved[0].turns[0].attachments![0].mediaId).toBe("11111111-1111-1111-1111-111111111111");
    // the live conversation still has the bytes for the thumbnail and the next request
    expect(conv.turns[0].attachments![0].dataUrl).toBe(DATA_URL);
  });

  it("P2: a legacy inline picture is kept until it has a media id", () => {
    const conv: Conversation = { id: "c1", title: "c", updated: 1, turns: [{ role: "user", content: "x", attachments: [image()] }] };
    expect(persistableConversations([conv])[0].turns[0].attachments![0].dataUrl).toBe(DATA_URL);
  });

  it("P3: hydration loads saved pictures back and marks a deleted one as unavailable", async () => {
    const conv: Conversation = {
      id: "c1", title: "c", updated: 1,
      turns: [{ role: "user", content: "x", attachments: [image({ mediaId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", dataUrl: undefined }), image({ name: "gone.png", mediaId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", dataUrl: undefined })] }]
    };
    const out = await hydrateConversations([conv], async (id) => (id.startsWith("a") ? { dataUrl: DATA_URL } : null));
    const [ok, gone] = out[0].turns[0].attachments!;
    expect(ok.dataUrl).toBe(DATA_URL);
    expect(ok.unavailable).toBe(false);
    expect(gone.dataUrl).toBeUndefined();
    expect(gone.unavailable).toBe(true);
  });

  it("P4: hydration does nothing (same object) when there is nothing to load", async () => {
    const conv: Conversation = { id: "c1", title: "c", updated: 1, turns: [{ role: "user", content: "x", attachments: [image()] }] };
    const list = [conv];
    expect(await hydrateConversations(list, async () => ({ dataUrl: DATA_URL }))).toBe(list);
  });

  it("P5: a full quota keeps every chat and drops only the unsaved picture bytes", () => {
    resetConversations();
    const convs: Conversation[] = [
      { id: "c1", title: "one", updated: 2, turns: [{ role: "user", content: "keep me", attachments: [image()] }] },
      { id: "c2", title: "two", updated: 1, turns: [{ role: "user", content: "me too" }] }
    ];
    failNextWrites = 1; // the first write hits the quota; the retry without bytes succeeds
    const r = saveConversations(convs);
    expect(r).toMatchObject({ ok: true, droppedMedia: true });
    const back = loadConversations();
    expect(back.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(back[0].turns[0].content).toBe("keep me");
    const att = back[0].turns[0].attachments![0];
    expect(att.dataUrl).toBeUndefined();
    expect(att.unavailable).toBe(true);
  });

  it("P6: a picture that cannot be read is named to the model, not silently skipped", () => {
    const text = userContent("what is this?", [image({ dataUrl: undefined, unavailable: true })], 1000);
    expect(typeof text).toBe("string");
    expect(text as string).toContain('image "p.png" is not available');
  });

  it("P8: a chat saved by an older version moves its inline pictures into the media store once", async () => {
    const conv: Conversation = { id: "c1", title: "c", updated: 1, turns: [{ role: "user", content: "x", attachments: [image()] }] };
    const saved: string[] = [];
    const out = await adoptInlineMedia([conv], async (dataUrl) => { saved.push(dataUrl); return { mediaId: "cccccccc-cccc-cccc-cccc-cccccccccccc" }; });
    expect(saved).toEqual([DATA_URL]);
    expect(out[0].turns[0].attachments![0].mediaId).toBe("cccccccc-cccc-cccc-cccc-cccccccccccc");
    // once adopted, the saved copy carries only the id
    expect(persistableConversations(out)[0].turns[0].attachments![0].dataUrl).toBeUndefined();
  });

  it("P9: loading the main-process copy never drops a chat and takes the newest version", () => {
    const memory: Conversation[] = [
      { id: "x", title: "from window", updated: 5, turns: [{ role: "user", content: "newer" }] },
      { id: "only-window", title: "w", updated: 1, turns: [] }
    ];
    const stored: Conversation[] = [
      { id: "x", title: "from store", updated: 2, turns: [{ role: "user", content: "older" }] },
      { id: "only-store", title: "s", updated: 1, turns: [] }
    ];
    const merged = mergeConversations(memory, stored);
    expect(merged.map((c) => c.id).sort()).toEqual(["only-store", "only-window", "x"]);
    expect(merged.find((c) => c.id === "x")!.turns[0].content).toBe("newer");
  });

  it("P7: a readable picture still becomes an image part", () => {
    const content = userContent("what is this?", [image()], 1000);
    expect(Array.isArray(content)).toBe(true);
    if (Array.isArray(content)) expect(content[0]).toMatchObject({ type: "image_url", image_url: { url: DATA_URL } });
  });
});

describe("OpenDocument repeated rows are bounded without losing coordinates", () => {
  const ods = (rowsXml: string) => writeZip({
    mimetype: toBytes("application/vnd.oasis.opendocument.spreadsheet"),
    "content.xml": toBytes(`<?xml version="1.0"?>
<office:document-content xmlns:office="urn:o" xmlns:text="urn:t" xmlns:table="urn:tb">
 <office:body><office:spreadsheet>
  <table:table table:name="S">${rowsXml}</table:table>
 </office:spreadsheet></office:body>
</office:document-content>`)
  });
  const row = (value: string, extra = "") => `<table:table-row${extra}><table:table-cell office:value-type="string" office:string-value="${value}"><text:p>${value}</text:p></table:table-cell></table:table-row>`;

  it("a huge trailing blank-row filler adds no rows", async () => {
    const doc = await documentText("tail.ods", await ods(row("a") + `<table:table-row table:number-rows-repeated="1048576"><table:table-cell/></table:table-row>`));
    const rows = doc.text.split("\n").filter((l) => l.startsWith("| "));
    expect(rows).toEqual(["| a |"]); // one data row; the separator is |---|
  });

  it("a small internal gap keeps the rows below in place", async () => {
    const doc = await documentText("gap.ods", await ods(row("a") + `<table:table-row table:number-rows-repeated="2"><table:table-cell/></table:table-row>` + row("b")));
    const lines = doc.text.split("\n");
    expect(lines.filter((l) => l === "|  |").length).toBe(2);
    expect(lines[lines.length - 1]).toBe("| b |");
  });

  it("content past the bounded sheet is not moved up to a false row", async () => {
    const doc = await documentText("far.ods", await ods(row("a") + `<table:table-row table:number-rows-repeated="10000"><table:table-cell/></table:table-row>` + row("b")));
    expect(doc.text).toContain("| a |");
    expect(doc.text).not.toContain("| b |");
  });

  it("repeated nonblank rows are still kept", async () => {
    const doc = await documentText("rep.ods", await ods(row("x", ' table:number-rows-repeated="3"')));
    expect(doc.text.split("\n").filter((l) => l === "| x |").length).toBe(3);
  });
});
