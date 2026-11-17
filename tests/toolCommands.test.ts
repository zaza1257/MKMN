import { describe, expect, it } from "vitest";
import { takeToolCommands } from "../src/core/toolCommands";

describe("takeToolCommands", () => {
  it("reads the leading commands and removes them", () => {
    const r = takeToolCommands("/agents /check cherche la tour Eiffel");
    expect([...r.used].sort()).toEqual(["agents", "check"]);
    expect(r.text).toBe("cherche la tour Eiffel");
  });
  it("leaves a message without a command as typed", () => {
    expect(takeToolCommands("  hello /web").used.size).toBe(0);
    expect(takeToolCommands("/web /images test").text).toBe("/web /images test");
    expect(takeToolCommands("/unknown hi").text).toBe("/unknown hi");
  });
});
