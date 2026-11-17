import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { judgeScenes, PASS_MARK } from "../src/core/construct/scene";
import { checkPageWithoutWindow } from "../src/core/construct/pagecheck";
import { readMark } from "../src/core/construct/marks";
import type { Scenario } from "../src/core/construct/scenarios";
import type { FileLike } from "../src/core/bundle";

const fx = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const page = (content: string): FileLike => ({ title: "fixture.html", kind: "html", language: "", content });

const fixtureScenarios = (html: string): Scenario[] => (readMark(html, "x-construct") as { scenarios?: Scenario[] } | null)?.scenarios ?? [];

describe("the headless scenario judge (construct/scene.ts)", () => {
  const html = fx("snake-fail.html");
  const scenarios = fixtureScenarios(html);

  it("pins a failing page: every scene fails, one failure below the pass mark is enough", async () => {
    const r = await judgeScenes(html, scenarios);
    expect(r.total).toBe(scenarios.length);
    expect(scenarios.length).toBeGreaterThan(0);
    for (const s of r.results) expect(s.ok).toBe(false);
    expect(r.held).toBeLessThan(PASS_MARK);
    expect(r.belowMark).toBe(true);
  });

  it("pins a passing page: every scene holds, at or above the pass mark", async () => {
    const good = fx("snake-pass.html");
    const goodScenarios = fixtureScenarios(good);
    const r = await judgeScenes(good, goodScenarios);
    for (const s of r.results) expect(s.ok, s.detail).toBe(true);
    expect(r.held).toBe(r.total);
    expect(r.belowMark).toBe(false);
  });

  it("the in-app path (checkPageWithoutWindow) reports the same verdicts as the headless judge, below the pass mark on the failing fixture", async () => {
    const r = await checkPageWithoutWindow(page(html), [], scenarios);
    expect(r.scenarios).toBeDefined();
    expect(r.scenarios!.map((s) => s.ok)).toEqual((await judgeScenes(html, scenarios)).results.map((s) => s.ok));
    expect(r.scenarios!.every((s) => !s.ok)).toBe(true);
  });

  it("the in-app path reports the same verdicts as the headless judge on the passing fixture", async () => {
    const good = fx("snake-pass.html");
    const goodScenarios = fixtureScenarios(good);
    const r = await checkPageWithoutWindow(page(good), [], goodScenarios);
    expect(r.scenarios).toBeDefined();
    expect(r.scenarios!.every((s) => s.ok)).toBe(true);
  });

  it("a page without scenarios reports no verdicts (unverified, never passed)", async () => {
    const r = await checkPageWithoutWindow(page(fx("snake-pass.html")), []);
    expect(r.scenarios).toBeUndefined();
  });

  it("reads a value the page draws on a canvas from the state key of the same name, and says so", async () => {
    // the recorded 8b-A shape: #score is a canvas, the value lives in S.score — the element's text is always empty
    const canvasPage = `<!doctype html><html><body>
<canvas id="score" width="100" height="40"></canvas>
<script>
var S = { score: 0, food: { x: 10, y: 10 } };
function onTick() { if (S.snake.x === S.food.x) S.score = S.score + 1; }
setInterval(function () { __run(onTick); __go(); }, 16);
</script></body></html>`;
    const scenes: Scenario[] = [{ req: "A1", steps: [{ do: "press", key: "ArrowRight", times: 1 }, { do: "wait", ms: 500 }], expect: { kind: "up", id: "score" }, text: "play → #score goes up" }];
    const r = await judgeScenes(canvasPage, scenes);
    expect(r.results[0].ok).toBe(false); // the snake never eats here: the value is read, the scene still fails on its merits
    expect(r.results[0].detail).toContain("went 0 → 0");
    expect(r.results[0].detail).toContain("state S");
    // a page whose state value does move is judged by it
    const eating = canvasPage.replace("S.snake.x === S.food.x", "true");
    const r2 = await judgeScenes(eating, scenes);
    expect(r2.results[0].ok).toBe(true);
    expect(r2.results[0].detail).toContain("state S");
  });

  it("a key press reaches the page's key handler (only the key moves the value)", async () => {
    // the event was built with eval() in a context that forbids it: every press threw and was swallowed
    const keyPage = `<!doctype html><html><body>
<canvas id="score" width="100" height="40"></canvas>
<script>
var S = { score: 0 };
function onRight(e) { if (e.key === "ArrowRight") S.score = S.score + 1; }
document.addEventListener("keydown", function (e) { if (e.key === "ArrowRight") { e.preventDefault(); __run(onRight, e); } });
</script></body></html>`;
    const scenes: Scenario[] = [{ req: "A1", steps: [{ do: "press", key: "ArrowRight", times: 3 }], expect: { kind: "up", id: "score" }, text: "press ArrowRight 3 times → #score goes up" }];
    const r = await judgeScenes(keyPage, scenes);
    expect(r.results[0].ok, r.results[0].detail).toBe(true);
  });
});
