import { describe, expect, it } from "vitest";
import { friendly } from "../src/core/errors";

describe("a chat sent with no usable model", () => {
  // The model tournament's every turn came back "Something went wrong" while the cause was this sentence.
  it("is named, not reported as an unknown problem", () => {
    const e = friendly("Pick a model first.");
    expect(e?.id).toBe("no-model");
    expect(e?.title).not.toMatch(/something went wrong/i);
  });
  it("names the missing Dynamic models the same way", () => {
    expect(friendly("Install the models of this Dynamic size first (Models, Dynamic).")?.id).toBe("no-model");
  });
});
