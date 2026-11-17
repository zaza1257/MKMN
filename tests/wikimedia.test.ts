import { describe, expect, it } from "vitest";
import { MAX_IMAGES_SHOWN, fileOfRef, IMAGE_INSTRUCTIONS } from "../src/core/wikimedia";
import { parseImageQueries, stripSubagents } from "../src/core/agents";
import { parseMarkdown } from "../src/core/markdown";
import { orchestrate } from "../src/core/orchestrate";
import type { ChatEvent } from "../src/shared/types";

describe("Wikimedia Commons", () => {
  it("reads legacy picture references without resolving them over the network", () => {
    expect(fileOfRef("wikimedia:Lake_Louise.jpg")).toBe("Lake Louise.jpg");
    expect(fileOfRef("wikimedia:Lake%20Louise.jpg")).toBe("Lake Louise.jpg");
    expect(fileOfRef("wikimedia:File:A.jpg")).toBe("A.jpg");
    expect(fileOfRef("https://x.com/a.jpg")).toBeNull();
    expect(fileOfRef("wikimedia:<script>")).toBeNull();
  });
  it("the model is told to use pictures sparingly, and never for code or maths", () => {
    expect(IMAGE_INSTRUCTIONS).toMatch(/Most answers have none/);
    expect(IMAGE_INSTRUCTIONS).toMatch(/Never for code, maths/);
    expect(MAX_IMAGES_SHOWN).toBe(3);
  });
});

describe("pictures in an answer", () => {
  it("asks for a picture with a block that is read, capped, and hidden while it streams", () => {
    expect(parseImageQueries("Sure. <wikiimage>lake louise</wikiimage> and <wikiimage>glacier</wikiimage><wikiimage>third</wikiimage>")).toEqual(["lake louise", "glacier"]);
    expect(parseImageQueries("<wikiimage>cut off")).toEqual([]);
    expect(stripSubagents("Here. <wikiimage>lake lou")).toBe("Here.");
    expect(stripSubagents("Here <wikiimage>x</wikiimage> done")).toMatch(/^Here\s+done$/);
    expect(stripSubagents("Here <wiki")).toBe("Here");
  });
  it("a picture on a line of its own is a block of the answer; anything else stays text", () => {
    const blocks = parseMarkdown("Look:\n\n![The lake](wikimedia:Lake_Louise.jpg)\n\nBeautiful. ![inline](wikimedia:x.jpg) here\n\n![web](https://x.com/a.png)");
    expect(blocks.filter((b) => b.t === "image")).toEqual([{ t: "image", alt: "The lake", file: "Lake Louise.jpg" }]);
    expect(blocks.filter((b) => b.t === "p")).toHaveLength(3);
  });
  it("the turn looks the pictures up, gives the candidates back, and the answer can place one", async () => {
    const seenByModel: string[] = [];
    let round = 0;
    const stream = async function* (id: string, messages: any[]): AsyncGenerator<ChatEvent> {
      seenByModel.push(typeof messages.at(-1).content === "string" ? messages.at(-1).content : "");
      const text = round++ === 0 ? "I will look. <wikiimage>lake louise</wikiimage>" : "Here it is:\n![Lake](wikimedia:Lake Louise.jpg)";
      yield { id, type: "answer", text };
      yield { id, type: "done", stats: { ttftSec: 0, tokPerSec: 1, tokens: 1, totalSec: 0 } };
    };
    const events: ChatEvent[] = [];
    for await (const e of orchestrate({ id: "p", messages: [{ role: "user", content: "show me lake louise" }], subagents: false, stream, images: async (q) => ({ text: `<image_results query="${q}">Mountain.png</image_results>`, display: "Mountain.png", files: ["Mountain.png", "Lake Louise.jpg"] }) })) events.push(e);
    expect(round).toBe(2);
    expect(seenByModel[1]).toContain("<image_results");
    expect(seenByModel[1]).toContain("Mountain.png");
    const card = events.filter((e) => e.type === "agent").at(-1) as Extract<ChatEvent, { type: "agent" }>;
    expect(card.agent).toMatchObject({ name: "Picture: lake louise", status: "done" });
    expect(events.filter((e) => e.type === "answer").map((e) => (e as any).text).join("")).toContain("![Lake](wikimedia:Lake Louise.jpg)");
  });
  it("a picture file the model made up without searching is discarded and searched for with its caption", async () => {
    const seen: string[] = [];
    const asked: string[] = [];
    let round = 0;
    const stream = async function* (id: string, messages: any[]): AsyncGenerator<ChatEvent> {
      seen.push(String(messages.at(-1).content));
      yield { id, type: "answer", text: round++ === 0 ? "![Lake at dawn](wikimedia:Invented.jpg)\nThis picture shows a lake." : "Here:\n![Lake](wikimedia:Lake Louise.jpg)" };
      yield { id, type: "done", stats: { ttftSec: 0, tokPerSec: 1, tokens: 1, totalSec: 0 } };
    };
    const events: ChatEvent[] = [];
    for await (const e of orchestrate({ id: "r", messages: [{ role: "user", content: "show a lake" }], subagents: false, stream, images: async (q) => { asked.push(q); return { text: `<image_results query="${q}">Mountain.png</image_results>`, display: "", files: ["Mountain.png", "Lake Louise.jpg"] }; } })) events.push(e);
    expect(asked).toEqual(["Lake at dawn"]);
    expect(events).toContainEqual({ id: "r", type: "retract", keep: 0 });
    expect(seen[1]).toContain('"Invented.jpg" that is not on any list');
    expect(round).toBe(2);
  });
  it("a search that fails is told to the model, which answers without a picture", async () => {
    const seen: string[] = [];
    let round = 0;
    const stream = async function* (id: string, messages: any[]): AsyncGenerator<ChatEvent> {
      seen.push(String(messages.at(-1).content));
      yield { id, type: "answer", text: round++ === 0 ? "<wikiimage>x</wikiimage>" : "No picture, sorry." };
      yield { id, type: "done", stats: { ttftSec: 0, tokPerSec: 1, tokens: 1, totalSec: 0 } };
    };
    for await (const _ of orchestrate({ id: "q", messages: [{ role: "user", content: "a picture" }], subagents: false, stream, images: async () => { throw new Error("Wikimedia answered 429"); } })) { /* drain */ }
    expect(seen[1]).toMatch(/search failed: Wikimedia answered 429[\s\S]*without a picture/);
  });
});
