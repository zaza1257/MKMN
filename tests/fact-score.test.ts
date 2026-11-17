import { describe, expect, it } from "vitest";
import { factKeys, factHeld } from "./fixtures/fact-score.mjs";

/**
 * The scorer the real-run records are scored by. A table
 * fact — a raw pipe row lifted from a sheet ("Projector | Main hall | 2 | 2022 |
 * good") — was scored as prose: every number in the row (2, 2022) had to come back
 * in the answer's own words, so know-xls-01's correct answer "2 projector units"
 * was scored not-held and the case failed although the app did its job. A table
 * fact is now scored on the ASKED CELL: the row's value (the first numeric cell
 * after the label cells) plus the label's distinctive words, with a digit
 * boundary — the row's "2" must not be read inside "12", which is exactly the
 * wrong answer the 4b gave ("12 projector units") and it must stay not-held.
 */
describe("a table fact (a pipe row) is scored on the asked cell, with a digit boundary", () => {
  const ROW = "Projector | Main hall | 2 | 2022 | good";
  const keys = factKeys(ROW);

  it("the table row parses to the asked value and the label's words (not every number in the row)", () => {
    expect(keys.table).toBe(true);
    expect(keys.value).toBe("2");
    expect(keys.numbers).toBeUndefined(); // prose scoring's every-number list is not used
    expect(keys.words).toEqual(["projector", "main", "hall"]);
  });

  it("the correct answer '2 projector units' is HELD (the bug: it scored not-held)", () => {
    const held = factHeld("There are 2 projector units in the main hall [source 1].", keys);
    expect(held.numbersOk).toBe(true);
    expect(held.held).toBe(true);
  });

  it("the recorded wrong answer '12 projector units' stays NOT held (the digit boundary: the row's 2 is not inside 12)", () => {
    const held = factHeld("The main hall has 12 projector units. ", keys);
    expect(held.numbersOk).toBe(false);
    expect(held.held).toBe(false);
  });

  it("a number that merely shares digits with the value ('21', '23') does not match the row's 2", () => {
    expect(factHeld("There are 21 projector units in the main hall.", keys).held).toBe(false);
    expect(factHeld("There are 23 projector units in the main hall.", keys).held).toBe(false);
  });

  it("the wrong value with the label right is still not held; the right value with the label wrong is not held either", () => {
    expect(factHeld("There are 3 projector units in the main hall.", keys).held).toBe(false);
    expect(factHeld("There are 2 projector units in the annex.", keys).held).toBe(false);
  });

  it("a prose fact keeps its old scoring (every number, the distinctive words)", () => {
    const prose = factKeys("The reading room on the first floor seats 86 people.");
    expect(prose.table).toBeUndefined();
    expect(prose.numbers).toEqual(["86"]);
    expect(factHeld("The reading room on the first floor seats 86 people.", prose).held).toBe(true);
    expect(factHeld("The reading room seats 96 people.", prose).held).toBe(false);
  });

  it("a decimal value in a row keeps its point (0.25 is not read inside 0.251)", () => {
    const fine = factKeys("Overdue fine | per book per day | 0.25 | dinars |");
    expect(factHeld("The overdue fine is 0.25 dinars per day per book.", fine).held).toBe(true);
    expect(factHeld("The overdue fine is 0.251 dinars per day.", fine).held).toBe(false);
  });
});
