import { describe, expect, it } from "vitest";
import { fuseSearchContext, sourcesBlock } from "../src/sidecar/humain";

/**
 * Fuse's hosted web search exists only on its Responses and Messages APIs; the app's pipeline speaks Chat
 * Completions, so the "Web search" / "Cited research" setting did nothing once Fuse chat ran through it.
 * The search is now asked first, over Responses; its findings ride the turn as context, and the app itself
 * lists the links at the end of the answer (a model asked to do it, seen live, did not).
 */
const final = {
  output: [
    { type: "web_search_call", status: "completed" },
    { type: "message", content: [{ type: "output_text", text: "Riyadh had 30 C today.", annotations: [
      { type: "url_citation", url: "https://example.com/weather", title: "Weather" },
      { type: "url_citation", url: "javascript:alert(1)", title: "bad" },
    ] }] },
  ],
};

describe("Fuse web search before a pipeline turn", () => {
  it("asks Responses with the hosted web_search tool and returns the findings and their links", async () => {
    let sent: any = null;
    const fetcher = (async (_url: string, init: RequestInit) => { sent = JSON.parse(String(init.body)); return new Response(JSON.stringify(final), { status: 200 }); }) as unknown as typeof fetch;
    const found = await fuseSearchContext({ key: "k", model: "m", query: "weather in Riyadh", mode: "search", fetcher });
    expect(sent.tools).toEqual([{ type: "web_search" }]);
    expect(sent.model).toBe("m");
    expect(found!.context).toContain("Riyadh had 30 C today.");
    expect(found!.context).toContain("[1] Weather https://example.com/weather");
    // seen live: without this the model narrated browsing ("We will open. We will request the page.")
    expect(found!.context).toMatch(/cannot open pages or search again/);
    expect(found!.links).toEqual([["https://example.com/weather", "Weather"]]);
    expect(JSON.stringify(found)).not.toContain("javascript:");
  });
  it("asks nothing when the setting is off", async () => {
    const fetcher = (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
    expect(await fuseSearchContext({ key: "k", model: "m", query: "q", mode: "off", fetcher })).toBeNull();
  });
  it("the app lists the sources itself, as the direct path did", () => {
    expect(sourcesBlock([["https://example.com/weather", "Weather"], ["https://nodejs.org/x", ""]]))
      .toBe("\n\n**Sources**\n- [Weather](https://example.com/weather)\n- [nodejs.org](https://nodejs.org/x)");
    expect(sourcesBlock([])).toBe("");
  });
});

describe("what a live Fuse search answer holds", () => {
  // the reasoning item came first and its text was taken as findings; the links were only in the text
  const live = { output: [
    { type: "web_search_call", status: "completed", action: { type: "search", query: "q" } },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "As of November 2026, Node.js 26 is likely LTS." }] },
    { type: "message", content: [{ type: "output_text", annotations: [], text: "Node 24 is the active LTS line. See https://nodejs.org/en/about/previous-releases and (https://github.com/nodejs/release)." }] },
  ] };
  it("takes findings from the answer only, and links from its text", async () => {
    const fetcher = (async () => new Response(JSON.stringify(live), { status: 200 })) as unknown as typeof fetch;
    const found = await fuseSearchContext({ key: "k", model: "m", query: "q", mode: "search", fetcher });
    expect(found!.context).not.toContain("likely LTS");
    expect(found!.context).toContain("Node 24 is the active LTS line.");
    expect(found!.links.map(([u]) => u)).toEqual(["https://nodejs.org/en/about/previous-releases", "https://github.com/nodejs/release"]);
  });
});
