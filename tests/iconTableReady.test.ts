// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { loadIcons, isLoaded } from "../src/core/page/iconTable";
import { gamePage, healGame, type GameSpec } from "../src/core/engine";
import { pageToHtml } from "../src/core/page/html";
import type { PageSpec } from "../src/core/page/catalog";

/**
 * The icon table lands on its own, out of the startup bundle: isLoaded() says when it
 * has, and every path that draws or writes icons has the real table by then.
 */
describe("the icon table is loaded before any lookup is trusted", () => {
  const game: GameSpec = {
    title: "Stars", things: [{ name: "player", shape: "icon", icon: "rocket", w: 36, h: 36, control: "horizontal" }, { name: "star", shape: "icon", icon: "star", vy: 120, edges: "remove" }],
    rules: [{ when: { hit: ["player", "star"] }, do: [{ op: "score", by: 1 }, { op: "remove", who: "b" }] }, { when: { every: 1 }, do: [{ op: "spawn", name: "star", at: "top" }] }, { when: { score: 10 }, do: [{ op: "win", text: "You win" }] }]
  };

  it("isLoaded() says the table has not landed, then that it has", async () => {
    // a fresh module: nothing loaded yet in this session of it
    vi.resetModules();
    const t = await import("../src/core/page/iconTable");
    expect(t.isLoaded()).toBe(false);
    await t.loadIcons();
    expect(t.isLoaded()).toBe(true);
  });

  it("a game page built after the table landed carries the icons it uses", async () => {
    await loadIcons();
    expect(isLoaded()).toBe(true);
    const page = gamePage(game);
    expect(page).toContain('<script id="icons">window.__icons=');
    expect(page).toContain('"rocket"');
  });

  it("a page built from blocks after the table landed draws the icon's svg", async () => {
    await loadIcons();
    const spec = { title: "S", sections: [{ type: "features", title: "F", items: [{ title: "Fast", icon: "rocket" }] }] } as unknown as PageSpec;
    const html = pageToHtml(spec);
    expect(html).toContain('<svg viewBox="0 0 24 24"'); // the icon is drawn as an inline drawing
  });

  it("a mended description keeps a real icon once the table has landed", async () => {
    await loadIcons();
    const { spec } = healGame(game);
    expect(spec.things.find((t) => t.name === "player")?.shape).toBe("icon");
  });
});
