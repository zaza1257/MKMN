import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Small design points from the reviews, each a statement the screen made
 * that was not quite true, or a state it did not show:
 * - Export did not say it leaves out the credential and this PC's own values;
 * - the chat's quick menu is titled "This chat", yet its switches are stored for
 *   the whole app: it must say they apply to the next messages in every chat;
 * - with Pictures on, the composer showed no sign of it (Web search had one);
 * - the sidebar's search button said "Search chats and projects" but opened the
 *   search of everything.
 */

const settings = readFileSync("src/renderer/SettingsView.tsx", "utf8");
const menu = readFileSync("src/renderer/ToolsMenu.tsx", "utf8");
const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
const app = readFileSync("src/renderer/App.tsx", "utf8");

describe("the screen says what is true", () => {
  it("Export says what it leaves out", () => {
    expect(settings).toMatch(/Leaves out the search key and this PC's own paths/);
  });

  it("the This chat menu says its choices apply to the next messages in every chat", () => {
    expect(menu).toMatch(/Applies to your next messages, in every chat/);
  });

  it("retired web search and picture switches are absent from chat", () => {
    expect(chat).not.toMatch(/settings\.(?:webSearch|wikimediaImages)/);
  });

  it("the sidebar search button names what it searches", () => {
    expect(app).not.toMatch(/title="Search chats and projects"/);
    expect(app).toMatch(/Search chats, projects, files and tasks/);
  });

  it("the rail toggle says it shows the labels", () => {
    expect(app).toMatch(/"Show the rail labels"/);
    expect(app).not.toMatch(/Expand the navigation rail/);
  });

  it("a narrow window keeps only the NPU meter in the title bar", () => {
    const hud = readFileSync("src/renderer/TitlebarMetrics.tsx", "utf8");
    const css = readFileSync("src/renderer/polish.css", "utf8");
    expect(hud.match(/hud-pill hud-secondary/g)?.length).toBe(4);
    expect(hud).toContain("className={`hud-pill ${pills.npuActive");
    expect(css).toContain("@media (max-width: 760px) { .titlebar-hud .hud-secondary { display: none; } }");
  });
});
