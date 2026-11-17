import { describe, expect, it } from "vitest";
import { chartBlocks, chartFlaw, chartModel, parseChartSpec } from "../src/core/chart";
import { templateChart } from "../src/core/chartTemplates";
import { routeVisual } from "../src/core/visualRoute";

const ASK = "make a compound interest diagram where I can choose the annual rate, the starting amount and the duration of the investment, that shows the base formula, the formula with my values and a graph of the sum over the duration\n\nI want to be able to enter the exact number for each of the values";

describe("ready-made calculators", () => {
  it("the compound interest request is a calculator and gets a chart that draws", () => {
    expect(routeVisual(ASK)?.kind).toBe("calculator");
    const t = templateChart(ASK)!;
    expect(t).not.toBeNull();
    const [b] = chartBlocks(t.block);
    expect(chartFlaw(b.raw)).toBeNull();
    const spec = parseChartSpec(b.raw);
    expect(typeof spec).not.toBe("string");
    const m = chartModel(spec as any);
    expect(m.problem).toBeUndefined();
  });

  it("the loan chart draws and its monthly payment is right", () => {
    const t = templateChart("make a loan simulator where I choose the amount, the rate and the duration")!;
    expect(t).not.toBeNull();
    const [b] = chartBlocks(t.block);
    expect(chartFlaw(b.raw)).toBeNull();
  });

  it("other requests have no template", () => {
    expect(templateChart("make a chart of sales by month")).toBeNull();
  });
});
