import { describe, expect, it } from "vitest";
import { SKELETONS } from "../src/core/skeletons";

describe("the snake skeleton", () => {
  it("placeFood ends with a win when the board is full, instead of spinning for ever", async () => {
    const snake = SKELETONS.find((s) => s.id === "snake") ?? SKELETONS[0];
    const src = /function placeFood\(\) \{[\s\S]*?\n\}/.exec(snake.html)?.[0];
    expect(src).toBeTruthy();
    const CELLS = 4;
    const full = Array.from({ length: CELLS * CELLS }, (_, i) => ({ x: i % CELLS, y: Math.floor(i / CELLS) }));
    const run = (cells: typeof full) =>
      new Function("CELLS", "snake", `${src}
        var won = false;
        function win() { won = true; }
        var food = null;
        placeFood();
        return { won: won, food: food };`)(CELLS, cells) as { won: boolean; food: { x: number; y: number } | null };
    // a full board: the win is declared, no food is placed
    expect(run(full)).toEqual({ won: true, food: null });
    // one cell free: the scan finds it (the random tries almost surely miss it)
    const almost = full.slice(0, -1);   // {x:3, y:3} is the only free cell
    expect(run(almost)).toEqual({ won: false, food: { x: 3, y: 3 } });
  });
});
