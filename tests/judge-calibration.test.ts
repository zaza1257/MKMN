/**
 * The acceptance judge is pinned here before any acceptance run: the judge lives in
 * tests/fixtures/acceptance-judge.mjs (outside src/, independent of the app's own scene judge)
 * and these fixtures decide whether its scenes can tell a working page from a broken one.
 * A working page takes full marks; the snake page that ignores the keys must fail the
 * turning scene and so must not pass; the judge's verdicts may not change while the
 * acceptance runs happen.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { judge } from "./fixtures/acceptance-judge.mjs";

const fix = (name: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("the independent acceptance judge", () => {
  it("gives the working snake page full marks", async () => {
    const r = await judge(fix("judge-snake-good.html"), "a snake game in html");
    expect(r.kind).toBe("snake");
    expect(r.total).toBe(4);
    expect(r.held).toBe(4);
    expect(r.pass).toBe(true);
  });

  it("does not pass the snake page whose keys do nothing, while the rest of its scenes still hold", async () => {
    const r = await judge(fix("judge-snake-ignores-keys.html"), "a snake game in html");
    expect(r.kind).toBe("snake");
    expect(r.total).toBe(4);
    const turn = r.results.find((x: { req: string }) => x.req === "A1");
    expect(turn?.ok).toBe(false);
    expect(turn?.detail).toContain("kept moving");
    expect(r.held).toBe(3);
    expect(r.pass).toBe(false);
  });

  it("gives the working tip page full marks on every fixed number pair", async () => {
    const r = await judge(fix("judge-tip-good.html"), "a tip calculator");
    expect(r.kind).toBe("tip");
    expect(r.total).toBe(3);
    expect(r.held).toBe(3);
    expect(r.pass).toBe(true);
    for (const x of r.results) expect(x.detail).toContain("the total at");
  });

  it("has no scenes for a request it was not written for and does not pretend to pass it", async () => {
    const r = await judge(fix("judge-tip-good.html"), "a weather dashboard");
    expect(r.total).toBe(0);
    expect(r.pass).toBe(false);
  });
});
