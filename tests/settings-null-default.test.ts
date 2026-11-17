import { describe, expect, it } from "vitest";
import { SETTINGS_SCHEMA as SETTINGS, valueProblem } from "../src/shared/settingsSchema";

describe("a null stored for a setting whose default is null", () => {
  // the installed app rejected these on every read and logged them as damaged
  it("is valid: null is that setting's stored 'not set'", () => {
    for (const key of ["npuBudgetOverrideGB", "geniexPath"]) {
      const d = (SETTINGS as any[]).find((s) => s.key === key);
      expect(valueProblem(d, null)).toBeNull();
    }
  });
  it("is still refused where the default is a real value", () => {
    expect(valueProblem((SETTINGS as any[]).find((s) => s.key === "closeAction"), null)).not.toBeNull();
  });
});
