import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * On a narrow window the file panel (at least 320 px) squeezed the chat beside it.
 * Below 900 px the chat and the file now take turns behind a Chat / Preview switch:
 * a file that opens is shown, the switch goes back to the chat, and the Preview tab
 * says when the file is still being written. Wide windows keep both side by side.
 */

const chat = readFileSync("src/renderer/Chat.tsx", "utf8");
const css = readFileSync("src/renderer/styles.css", "utf8");

describe("Chat / Preview on a narrow window", () => {
  it("the split carries the view, and the switch is drawn only with a panel", () => {
    expect(chat).toContain('className={`chat-split ${panel ? `has-panel show-${narrowView}` : ""}`}');
    expect(chat).toMatch(/\{panel && \(\s*<div className="seg narrow-switch" role="tablist"/);
    expect(chat).toContain('Preview{busy ? " · writing" : ""}');
  });

  it("a file that opens is shown, and closing it goes back to the chat", () => {
    expect(chat).toContain('setNarrowView(viewing ? "preview" : "chat")');
  });

  it("the state sits with the other hooks, before the component draws anything", () => {
    expect(chat.indexOf("const [narrowView, setNarrowView]")).toBeLessThan(chat.indexOf('<div className={`chat-split'));
    expect(chat.indexOf("const [narrowView, setNarrowView]")).toBeGreaterThan(chat.indexOf("const [viewing, setViewing]"));
  });

  it("only a narrow window hides one of the two", () => {
    expect(css).toContain(".narrow-switch { display: none; }");
    const narrow = css.slice(css.indexOf("/* Chat / Preview on a narrow window"));
    expect(narrow).toContain("@media (max-width: 900px) {");
    expect(narrow).toContain(".chat-split.show-preview > .chat { display: none; }");
    expect(narrow).toContain(".chat-split.show-chat > .artifact-panel { display: none; }");
  });
});
