import { describe, expect, it } from "vitest";
import { assemblePage } from "../src/core/construct/assemble";
import { checkArtifactWithoutWindow, checkPageWithoutWindow, derivePlayEvents } from "../src/core/construct/pagecheck";
import { playPage, playPageRun } from "../src/core/construct/sandbox";
import { parseRequirements } from "../src/core/construct/tasklist";
import type { FileLike } from "../src/core/bundle";

const page = (content: string, title = "page.html"): FileLike => ({ title, kind: "html", language: "", content });
const code = (title: string, language: string, content: string): FileLike => ({ title, kind: "code", language, content });

describe("the page check without a window", () => {
  it("plays a page the construction engine assembled: its button and its key are found from the page's own wiring", async () => {
    const parsed = parseRequirements(JSON.stringify({ title: "Counter", requirements: [{ text: "a button adds one" }, { text: "the arrow key moves" }] }))!;
    const us = [
      { kind: "state", name: "S", does: "the state", serves: ["R1"] },
      { kind: "layout", name: "layout", does: "the page", serves: ["R1"] },
      { kind: "fn", name: "addOne", does: "adds one", serves: ["R1"] },
      { kind: "handler", name: "onGo", does: "adds one on click", serves: ["R1"], on: "click #go" },
      { kind: "handler", name: "onLeft", does: "moves left", serves: ["R2"], on: "keydown ArrowLeft" }
    ];
    const html = assemblePage({ title: "Counter", language: "English", requirements: parsed.requirements, units: us }, new Map([
      ["S", { code: '{"n":0,"x":0}', verified: true, problems: [] }],
      ["addOne", { code: "function addOne() { S.n = S.n + 1; }", verified: true, problems: [] }],
      ["onGo", { code: "function onGo() { addOne(); }", verified: true, problems: [] }],
      ["onLeft", { code: "function onLeft(e) { S.x = S.x - 1; }", verified: true, problems: [] }],
      ["layout", { code: '<button id="go">Add</button>', verified: true, problems: [] }]
    ]), true, []);
    const r = await checkPageWithoutWindow(page(html), []);
    expect(r.ran).toBe("page");
    expect(r.errors).toEqual([]);
    expect(r.notes).toEqual([]);
    const events = derivePlayEvents(html, html);
    expect(events.clicks).toContain("onGo");
    expect(events.down).toContainEqual({ name: "onLeft", key: "ArrowLeft" });
  });

  it("shows what a control does to the state: a button that adds and a key that move", async () => {
    const script = `var S = { n: 0, x: 0 };
function addOne() { S.n = S.n + 1; }
function onGo() { addOne(); }
function onLeft(e) { S.x = S.x - 1; }
function render() {}
function __run(f, e) { try { return f(e); } catch (err) { console.error(err); } }`;
    const run = await playPageRun({ script, ticks: [], down: [{ name: "onLeft", key: "ArrowLeft" }], up: [], clicks: ["onGo"] }, ["addOne", "onGo", "onLeft"]);
    expect(run.errors).toEqual([]);
    expect(run.clicksChanged).toBe(true);
    expect(run.keysChanged).toBe(true);
  });

  it("a click or input event carries a target, so a handler that reads e.target is exercised, not crashed", async () => {
    // the recorded tip-A shape: onBillInput(e) reads e.target.value — in a browser the event always has a target, and a click that
    // changes the state is measured against the state as it stood before the click, not against the end state the ticks keep moving
    const script = `var S = { bill: -1 };
function onBillInput(e) { if (e.target.value !== undefined) { S.bill = parseFloat(e.target.value) || 0; } }
function render() {}
function __run(f, e) { try { return f(e); } catch (err) { console.error(err); } }`;
    const run = await playPageRun({ script, ticks: [], down: [], up: [], clicks: ["onBillInput"] }, ["onBillInput"]);
    expect(run.errors).toEqual([]);
    // the empty value the stand-in holds is parsed with its guard: the state takes 0, not a crash
    expect(run.clicksChanged).toBe(true);
  });

  it("names the unit a runtime error happened in, and a state number that went NaN with its path", async () => {
    const errs = await playPage({ script: "var S = { n: 0 };\nfunction tickMove() { S.n = S.n + ghost.x; }\nfunction render() {}", ticks: ["tickMove"], down: [], up: [], clicks: [] }, ["tickMove"]);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0].unit).toBe("tickMove");
    expect(errs[0].message).toMatch(/ghost is not defined/i);

    const nan = (await playPage({ script: "var S = { speed: 10 };\nfunction tickFall() { S.speed = S.speed / (S.missing - S.missing); }\nfunction render() {}", ticks: ["tickFall"], down: [], up: [], clicks: [] }, ["tickFall"])).find((e) => e.nan);
    expect(nan).toBeTruthy();
    expect(nan!.nan).toMatch(/^S\.speed/);
  });

  it("tells a syntax error from a running page: the parse failure says 'syntax', the runtime failure says 'page'", async () => {
    const broken = await checkPageWithoutWindow(page('<!doctype html><html><body><script>function f( { }</script></body></html>'), []);
    expect(broken.ran).toBe("syntax");
    expect(broken.errors.join(" ")).toMatch(/SyntaxError/i);

    const throws = await checkPageWithoutWindow(page('<!doctype html><html><body><script>var S = {}; function boom() { S.n = missing.x; } boom();</script></body></html>'), []);
    expect(throws.ran).toBe("page");
    expect(throws.errors.join(" ")).toMatch(/missing/i);
  });

  it("says 'none' for a page with no script, and names the files the page links that nobody wrote", async () => {
    const none = await checkPageWithoutWindow(page('<!doctype html><html><body><p>hello</p></body></html>'), []);
    expect(none.ran).toBe("none");
    expect(none.errors).toEqual([]);

    const missing = await checkPageWithoutWindow(page('<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><script src="game.js"></script></body></html>'), []);
    expect(missing.errors).toContain("page.html links style.css, but no file with that name was written.");
    expect(missing.errors).toContain("page.html links game.js, but no file with that name was written.");
  });

  it("runs the page's own clock after each control, so a start button's playing is really run", async () => {
    // A start control puts the page into play; a second control (restart/end) puts it back
    // to a terminal state. Clicking both before ticking left the page stopped, so the one
    // tick that throws was never run and the breakage was never seen. This page plays only
    // after the start control; the clock run that follows it must raise the error.
    const script = `var S = { mode: "menu", snake: null };
function onStart() { S.mode = "play"; S.snake = { x: 0, w: 2, segments: [{ x: 0 }] }; }
function onEnd() { S.mode = "end"; }
function moveThing(t) { return { x: t.x + 1, w: t.w }; }
function tick() { if (S.mode === "play") { S.snake = moveThing(S.snake); if (S.snake.segments.length === 0) S.mode = "over"; } }
function render() {}
function __run(f, e) { try { return f(e); } catch (err) { console.error(err); } }`;
    const run = await playPageRun({ script, ticks: ["tick"], down: [], up: [], clicks: ["onStart", "onEnd"] }, ["tick", "moveThing"]);
    expect(run.errors.length).toBeGreaterThan(0);
    expect(run.errors[0].unit).toBe("tick");
  });

  it("runs a bare script through the page that links it, and a stylesheet the same way", async () => {
    const html = page('<!doctype html><html><body><button id="go" onclick="onGo()">go</button><script src="game.js"></script><link rel="stylesheet" href="style.css"></body></html>', "index.html");
    const js = code("game.js", "js", "var S = { n: 0 };\nfunction onGo() { S.n = S.n + 1; }");
    const css = code("style.css", "css", "body { color: red }");
    const r = await checkArtifactWithoutWindow({ ...js }, [html, js, css]);
    expect(r.ran).toBe("page");
    expect(r.errors).toEqual([]);

    const rc = await checkArtifactWithoutWindow(css, [html, js, css]);
    // the stylesheet is checked by playing the page that links it (this page has a script: it plays)
    expect(rc.ran).toBe("page");
  });

  it("names a control that ran and changed nothing in the state, and never claims what a window would see", async () => {
    const html = page('<!doctype html><html><body><button id="go" onclick="onGo()">go</button><script>var S = { n: 0 };\nfunction onGo() { var t = S.n + 1; }</script></body></html>');
    const r = await checkPageWithoutWindow(html, []);
    expect(r.ran).toBe("page");
    expect(r.errors).toEqual([]);
    expect(r.notes.join(" ")).toMatch(/changed nothing in the state/i);
  });

  it("reads this engine's wiring exactly: ticks, keys with their key, and a hand-written button", () => {
    const wiring = `setInterval(function () { __run(tickFall); __go(); }, 500);
Array.prototype.forEach.call(document.querySelectorAll('[id=' + JSON.stringify("go") + ']'), function (el) { el.addEventListener("click", function (e) { __run(onGo, e); __go(); }); });
document.addEventListener("keydown", function (e) { if (e.key === "ArrowLeft") { e.preventDefault(); __run(onLeft, e); __go(); } });
document.addEventListener("keydown", function (e) { if (e.key === " " || e.code === "Space") { e.preventDefault(); __run(onDrop, e); __go(); } });`;
    const ev = derivePlayEvents('<button id="go" onclick="start()">go</button>', wiring);
    expect(ev.ticks).toEqual(["tickFall"]);
    expect(ev.clicks).toEqual(["onGo", "start"]);
    expect(ev.down).toContainEqual({ name: "onLeft", key: "ArrowLeft" });
    expect(ev.down).toContainEqual({ name: "onDrop", key: "Space" });
  });
});
