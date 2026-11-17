import { describe, expect, it } from "vitest";
import { clearLoadFailure, failuresOfThisGeniex, withLoadFailure } from "../src/core/loadFailures";

describe("the record of models that did not load here", () => {
  it("keeps the reason and the GenieX version of a failed load", () => {
    const r = withLoadFailure({}, "qualcomm/Phi-3.5-Mini-Instruct", "cannot read metadata.json", "v0.11.0", "2026-11-15T12:00:00Z");
    expect(r["qualcomm/Phi-3.5-Mini-Instruct"]).toEqual({ reason: "cannot read metadata.json", geniex: "v0.11.0", at: "2026-11-15T12:00:00Z" });
  });
  it("forgets it once the model loads", () => {
    const r = withLoadFailure({}, "m", "x", "v0.11.0", "t");
    expect(clearLoadFailure(r, "m")).toEqual({});
    expect(clearLoadFailure(r, "other")).toBe(r);
  });
  it("drops records of another GenieX version: a newer runtime may load the model, so it is tried again", () => {
    const r = { a: { reason: "x", geniex: "v0.10.0", at: "t" }, b: { reason: "y", geniex: "v0.11.0", at: "t" } };
    expect(Object.keys(failuresOfThisGeniex(r, "v0.11.0"))).toEqual(["b"]);
    expect(failuresOfThisGeniex(r, null)).toEqual(r); // version unknown: nothing is dropped on a guess
  });
});

import { checkOutcome, verdictOf } from "../src/core/loadFailures";
import { nextState } from "../src/shared/stateMachines";

// the registered machine modelVerdict: one reading of the two records, and the check's result as its event
describe("a model's verdict on this PC", () => {
  it("is read from the records: a placement means it loads, a failure that it does not, else not checked", () => {
    expect(verdictOf("m", { placements: { m: "npu" } })).toBe("loads");
    expect(verdictOf("m", { loadFailures: { m: { reason: "x", geniex: "v", at: "t" } } })).toBe("fails");
    expect(verdictOf("m", {})).toBe("unknown");
    // a placement wins: a later load that worked clears the doubt
    expect(verdictOf("m", { placements: { m: "npu" }, loadFailures: { m: { reason: "x", geniex: "v", at: "t" } } })).toBe("loads");
  });
  it("ends a check with the machine's own event, and a check GenieX never tried records nothing", () => {
    expect(nextState("modelVerdict", "checking", checkOutcome({ placed: true, nameError: null }))).toBe("loads");
    expect(nextState("modelVerdict", "checking", checkOutcome({ placed: false, nameError: null }))).toBe("fails");
    expect(nextState("modelVerdict", "checking", checkOutcome({ placed: false, nameError: "cannot name it" }))).toBe("unknown");
  });
  it("never jumps from not checked to a verdict without a check", () => {
    expect(nextState("modelVerdict", "unknown", "no_setting")).toBeUndefined();
    expect(nextState("modelVerdict", "unknown", "loaded")).toBeUndefined();
  });
});
