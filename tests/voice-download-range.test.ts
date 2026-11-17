import { describe, expect, it } from "vitest";
import { rangeComplete } from "../src/core/voiceService";

/**
 * A resumed voice-model download that got HTTP 416 was taken as complete whatever was on
 * disk, so a bad partial file was extracted and never downloaded again. It is complete only
 * when the server's total is the size already on disk.
 */

describe("a 416 answer means complete only when the sizes match", () => {
  it("accepts the server's total equal to the file on disk", () => {
    expect(rangeComplete("bytes */1048576", 1048576)).toBe(true);
  });
  it("refuses a different total, a missing header or an empty file", () => {
    expect(rangeComplete("bytes */1048576", 524288)).toBe(false);
    expect(rangeComplete("", 1048576)).toBe(false);
    expect(rangeComplete("bytes */0", 0)).toBe(false);
  });
});
