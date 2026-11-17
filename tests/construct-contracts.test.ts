/**
 * The contract faults the program is read for, without knowing a kind of program: a key of S that no unit sets, a name that stands for
 * nothing, a field read on a thing that holds no such field, a correction that changes the keys of S without being asked, the same function
 * called with different kinds of values. Each is named with the names that exist, so a correction can be exact; each test here pins one of
 * those faults, found the moment the code is read.
 */
import { describe, expect, it } from "vitest";
import { unwrittenKeyProblems, stateReads, stateShapeProblem } from "../src/core/construct/stateUse";
import { unplannedNames, argKindProblems } from "../src/core/construct/fixes";

describe("the contract faults of a program as written", () => {
  it("names a key of S whose value is an empty list and that no unit ever sets", () => {
    const state = { walls: [], snake: [{ x: 1, y: 1 }], score: 0 };
    const units = [
      { name: "drawFood", kind: "view", code: `function drawFood() { return S.walls.length; }` },
      { name: "tick1", kind: "handler", code: `function tick1() { return S.snake.length; }`, on: "tick 16" }
    ];
    const by = unwrittenKeyProblems(units, state);
    const problems = by.get("drawFood") ?? [];
    expect(problems.some((m) => m.includes("S.walls"))).toBe(true);
    expect(problems.some((m) => /no unit sets it/.test(m))).toBe(true);
    // a unit that sets the key clears it
    const withWriter = unwrittenKeyProblems([
      ...units,
      { name: "buildWalls", kind: "fn", code: `function buildWalls() { S.walls = [{ x: 0, y: 0 }]; return S.walls; }` }
    ], state);
    expect(withWriter.size).toBe(0);
  });

  it("names a free name that stands for nothing: not planned, not declared, not a global, not the page's own", () => {
    const code = `function draw() {
  const el = document.getElementById("score");
  if (keys && keys[LEFT_ARROW]) el.textContent = "\u2190";
}`;
    const out = unplannedNames(code, ["draw"]);
    expect(out).toContain("LEFT_ARROW");
    // a local that declares it stands for itself
    const declared = unplannedNames(`function draw() {
  const LEFT_ARROW = "ArrowLeft";
  const keys = {};
  if (keys[LEFT_ARROW]) return;
}`, ["draw"]);
    expect(declared).toEqual([]);
    // planned names, the browser's names, and the page's own names are not faults
    expect(unplannedNames(`function draw() { return Math.floor(S.score / 2); }`, ["draw"])).toEqual([]);
    expect(unplannedNames(`function draw() { return JSON.stringify(S); }`, ["draw"])).toEqual([]);
    expect(unplannedNames(`function draw() { return state.score; }`, ["draw"])).toEqual([]);
    // a call to an unplanned name is a gap in the plan, filled by adding the missing unit — not here
    expect(unplannedNames(`function draw() { return drawScore(S.score); }`, ["draw"])).toEqual([]);
  });

  it("names a field read on a thing that holds no such field: a number where an object or undefined is meant", () => {
    const problems = stateReads(`function f() {\n  return S.score.score;\n}`, { score: 5 });
    expect(problems.some((m) => m.includes('"score"'))).toBe(true);
    expect(problems.some((m) => m.includes("S.score"))).toBe(true);
    // the name exists downstream of a key the state does not hold
    const dl = stateReads(`function f() {\n  const d = S.boss;\n  return d.left;\n}`, { score: 0 });
    expect(dl.some((m) => m.includes('"left"'))).toBe(true);
    expect(dl.some((m) => m.includes("undefined"))).toBe(true);
    // the list's own methods are its own, never flagged
    const ok = stateReads(`function f() {\n  return S.snake.map(function (p) { return p.x; });\n}`, { snake: [{ x: 1 }] });
    expect(ok).toEqual([]);
  });

  it("refuses a correction of S that drops a key the work serves, or invents one the plan never asked for", () => {
    expect(stateShapeProblem(`{"snake": [], "score": 0}`, `{"snake": []}`)).toMatch(/drops score/);
    expect(stateShapeProblem(`{"snake": []}`, `{"snake": [], "walls": []}`)).toMatch(/adds walls/);
    expect(stateShapeProblem(`{"snake": [], "score": 0}`, `{"snake": [{"x": 1, "y": 1}], "score": 3}`)).toBeNull();
    expect(stateShapeProblem(`not json`, `{"snake": []}`)).toBeNull();
    expect(stateShapeProblem(`{"snake": []}`, `nope`)).toBeNull();
  });

  it("names a function called with different kinds of values by different units", () => {
    const units = [
      { name: "tick1", code: `function tick1() {\n  move(1, 2);\n}` },
      { name: "tick2", code: `function tick2() {\n  move("right", true);\n}` },
      { name: "draw", code: `function draw() {\n  move(S.x, S.y);\n}` }
    ];
    const by = argKindProblems(units, ["move"]);
    const problems = by.get("tick2") ?? [];
    expect(problems.some((m) => m.includes("move"))).toBe(true);
    expect(problems.some((m) => m.includes("tick1"))).toBe(true);
    // what a value holds is not judged: identifiers are values either way
    const sameKind = argKindProblems([
      { name: "tick1", code: `function tick1() {\n  move(S.x, S.y);\n}` },
      { name: "tick2", code: `function tick2() {\n  move(S.next, S.head);\n}` }
    ], ["move"]);
    expect(sameKind.size).toBe(0);
    // identical kinds are not a fault
    const bothRight = argKindProblems([
      { name: "tick1", code: `function tick1() {\n  move(1, 2);\n}` },
      { name: "tick2", code: `function tick2() {\n  move(3, 4);\n}` }
    ], ["move"]);
    expect(bothRight.size).toBe(0);
  });

  it("names a caller that passes a plain value where the function's own body reads a property off the argument", () => {
    // the recorded 8b-B shape: updateScore(score, food) reads score.x in its body; the caller passes S.score, a number
    const state = { score: 0, food: { x: 1, y: 1 } };
    const units = [
      { name: "updateScore", code: `function updateScore(score, food) {\n  if (score.x === food.x && score.y === food.y) return score + 1;\n  return score;\n}` },
      { name: "tick", code: `function tick() {\n  S.score = updateScore(S.score, S.food);\n}` }
    ];
    const by = argKindProblems(units, ["updateScore"], state);
    const problems = by.get("tick") ?? [];
    expect(problems.some((m) => m.includes("updateScore"))).toBe(true);
    expect(problems.some((m) => m.includes("a number"))).toBe(true);
    expect(problems.some((m) => m.includes("reads a property"))).toBe(true);
    // an object argument satisfies the body's use
    const withObject = argKindProblems([
      { name: "updateScore", code: `function updateScore(score, food) {\n  return score.x + food.x;\n}` },
      { name: "tick", code: `function tick() {\n  return updateScore(S.head, S.food);\n}` }
    ], ["updateScore"], { head: { x: 1 }, food: { x: 2 } });
    expect(withObject.size).toBe(0);
    // a body that never reads the parameter as an object is not a fault
    const plainUse = argKindProblems([
      { name: "grow", code: `function grow(n) {\n  return n + 1;\n}` },
      { name: "tick", code: `function tick() {\n  S.score = grow(S.score);\n}` }
    ], ["grow"], { score: 0 });
    expect(plainUse.size).toBe(0);
    // without the state the S.kind of the argument is unknown, so nothing is claimed
    const noState = argKindProblems([
      { name: "updateScore", code: `function updateScore(score) {\n  return score.x;\n}` },
      { name: "tick", code: `function tick() {\n  return updateScore(S.score);\n}` }
    ], ["updateScore"]);
    expect(noState.size).toBe(0);
  });
});
