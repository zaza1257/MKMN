import { describe, expect, it } from "vitest";
import { AGENT_PROPOSE_PROMPT, irreversibleControl } from "../src/sidecar/computerUse";

/**
 * The window agent prepares drafts and never sends them. The closed action set had no
 * Enter, but a click on a "Send" button passed validation, and the prompt's own example
 * element was a Send button. A press that cannot be taken back is now refused.
 */

describe("the window agent never presses a control that cannot be taken back", () => {
  it("refuses send, post, delete and pay buttons, in English and Arabic", () => {
    for (const name of ["Send", "Send now", "Submit", "Post", "Publish", "Delete", "Pay $20", "Place order", "Reply all", "إرسال", "حذف"]) {
      expect(irreversibleControl({ name }), name).toBe(true);
    }
  });

  it("leaves ordinary controls alone", () => {
    for (const name of ["Bold", "Save draft", "Insert", "Sender", "Postpone", undefined]) {
      expect(irreversibleControl({ name }), String(name)).toBe(false);
    }
  });

  it("the prompt no longer shows a Send button as its example and says such a press is refused", () => {
    expect(AGENT_PROPOSE_PROMPT).not.toContain('Button "Send"');
    expect(AGENT_PROPOSE_PROMPT).toMatch(/Never press Send/);
  });
});
