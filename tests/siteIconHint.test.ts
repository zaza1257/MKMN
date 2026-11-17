import { describe, expect, it, vi } from "vitest";
import type { ChatEvent } from "../src/shared/types";

// The Lucide table loads out of the startup bundle, after the modules that name icons are already
// in. A page writer must read it when the prompt is written, never freeze the empty table it saw as
// the module loaded. The test owns the table here, so the two can be told apart: it is empty while
// the modules load and full by the time the prompt is written.
const table = vi.hoisted(() => ({ paths: {} as Record<string, string> }));
vi.mock("../src/core/page/iconTable", () => ({
  iconPaths: () => table.paths,
  iconTags: () => ({}),
  loadIcons: async () => { /* the table is filled by the test, not by a chunk */ }
}));

import { makeFromTemplate } from "../src/core/templates/build";

describe("the website prompt reads the icon table when it is written", () => {
  const stats = { ttftSec: 0.1, tokPerSec: 20, tokens: 10, totalSec: 0.5 };
  const siteJson = JSON.stringify({ language: "en", title: "Dupain Bakery", sections: [
    { type: "hero", title: "Bread, the old way", subtitle: "Stone-baked" },
    { type: "features", title: "Why us", items: [{ icon: "rocket", title: "Fast", text: "Every dawn" }] },
    { type: "text", title: "Visit us" }] });
  it("lists the names the table holds then, not the empty table seen as the module loaded", async () => {
    // the table was empty while the modules above loaded; it is full when the prompt is written
    table.paths = { activity: "<path/>", rocket: "<path/>", shield: "<path/>" };
    let fillSystem = "";
    const stream = async function* (sid: string, messages: { role?: string; content?: unknown }[]): AsyncGenerator<ChatEvent> {
      if (sid.includes(":fill")) {
        fillSystem = String(messages.find((m) => m.role === "system")?.content ?? "");
        yield { id: sid, type: "answer", text: siteJson } as ChatEvent;
      } else yield { id: sid, type: "answer", text: "Done." } as ChatEvent;
      yield { id: sid, type: "done", stats } as ChatEvent;
    };
    const g = makeFromTemplate({ id: "t", messages: [{ role: "user", content: "make a landing page for a bakery" }], stream: stream as never, drawEveryMs: 0 });
    let r = await g.next();
    while (!r.done) r = await g.next();
    expect(r.value).toMatchObject({ handled: true });
    expect(fillSystem).toContain("Names: ");
    const names = fillSystem.split("Names: ")[1] ?? "";
    expect(names).toContain("rocket");
    expect(names.split(", ").length).toBe(3);
  });
});
