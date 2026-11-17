import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { approvalBody } from "../src/core/approval";

/**
 * An approval prompt authorizes what it shows. The old prompts cut the text at
 * 3,000 characters without saying so, and approving ran the hidden rest.
 */

describe("the approval prompt shows what it authorizes", () => {
  it("shows a short command or code whole", () => {
    expect(approvalBody("command", "dir")).toEqual({ ok: true, text: "dir" });
    expect(approvalBody("code", "print(1)")).toEqual({ ok: true, text: "print(1)" });
  });

  it("refuses a command too long to show whole", () => {
    const r = approvalBody("command", "x".repeat(3001));
    expect(r.ok).toBe(false);
  });

  it("says plainly when long code is shown in part, and that approving runs all of it", () => {
    const r = approvalBody("code", "y".repeat(5000));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.text).toMatch(/first 3,000 of 5,000 characters\. Approving runs ALL of it/);
  });

  it("the sidecar builds both prompts from approvalBody, never a silent slice (source pin)", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).not.toMatch(/String\((code|command)\)\.slice\(0, 3000\)/);
    expect(src.match(/approvalBody\("(code|command)"/g)?.length).toBe(2);
  });
});
