import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_PROPOSE_PROMPT, irreversibleControl, validateAgainstSnapshot } from "../src/sidecar/computerUse";
import { consequentialReason, consequentialWord } from "../src/shared/consequential";
import type { NodeInfo } from "../src/shared/agent";

/**
 * The window agent prepares drafts and never sends them. The closed action set had no
 * Enter, but a click on a "Send" button passed validation, and the prompt's own example
 * element was a Send button. A press that cannot be taken back is now refused.
 *
 * 2026-11-17 review: the refusal was a word list on clicks only. "OK", "Confirm", "Yes",
 * "Approve", an icon button with no name, and a select of a "Delete" menu item all passed.
 * The rule now reads ONE list (src/shared/consequentialControls.json) here and in the
 * native driver at the moment of the action, and refuses unnamed controls.
 */

const node = (over: Partial<NodeInfo>): NodeInfo => ({
  ref: "e1.0", role: "Button", name: "Bold", enabled: true, offscreen: false, patterns: ["click", "toggle", "select"], ...over,
});

describe("the window agent never presses a control that cannot be taken back", () => {
  it("refuses send, post, delete and pay buttons, in English and Arabic", () => {
    for (const name of ["Send", "Send now", "Submit", "Post", "Publish", "Delete", "Pay $20", "Place order", "Reply all", "إرسال", "حذف"]) {
      expect(irreversibleControl({ name }), name).toBe(true);
    }
  });

  it("refuses confirmation buttons the old list let through", () => {
    for (const name of ["OK", "Confirm", "Yes", "Approve", "Accept", "Continue", "Apply", "Empty Trash", "Sign out", "Install", "تأكيد", "موافق", "نعم"]) {
      expect(irreversibleControl({ name }), name).toBe(true);
    }
  });

  it("leaves ordinary controls alone", () => {
    for (const name of ["Bold", "Save draft", "Insert", "Sender", "Postpone", "Bookmark", "Okapi", "Cancel", "New message", "Reply"]) {
      expect(irreversibleControl({ name }), String(name)).toBe(false);
    }
  });

  it("refuses a press on a control with no name", () => {
    expect(validateAgainstSnapshot(node({ name: undefined }), { kind: "click", ref: "e1.0" })).toMatch(/no name/);
    expect(validateAgainstSnapshot(node({ name: "  " }), { kind: "toggle", ref: "e1.0" })).toMatch(/no name/);
  });

  it("refuses choosing a consequential item through select, not only through click", () => {
    expect(validateAgainstSnapshot(node({ name: "Actions" }), { kind: "select", ref: "e1.0", value: "Delete" })).toMatch(/never does/);
    expect(validateAgainstSnapshot(node({ name: "Font" }), { kind: "select", ref: "e1.0", value: "Arial" })).toBeNull();
  });

  it("refuses a toggle on a consequential switch", () => {
    expect(validateAgainstSnapshot(node({ name: "Send read receipt" }), { kind: "toggle", ref: "e1.0" })).toMatch(/never does/);
  });

  it("matches whole words, so a word inside another word is not a hit", () => {
    expect(consequentialWord("Sender")).toBeNull();
    expect(consequentialWord("Okapi")).toBeNull();
    expect(consequentialWord("Place  ORDER now")).toBe("place order");
    expect(consequentialReason("expand", "Send")).toBeNull();
    expect(consequentialReason("setValue", undefined)).toBeNull();
  });

  it("the native driver reads the same list at the moment of the action", () => {
    const wire = readFileSync("src-tauri/src/agent_wire.rs", "utf8");
    expect(wire).toContain('include_str!("../../src/shared/consequentialControls.json")');
    const driver = readFileSync("src-tauri/src/bin/agent-desktop.rs", "utf8");
    expect(driver).toMatch(/consequential_reason\(/);
  });

  it("the prompt no longer shows a Send button as its example and says such a press is refused", () => {
    expect(AGENT_PROPOSE_PROMPT).not.toContain('Button "Send"');
    expect(AGENT_PROPOSE_PROMPT).toMatch(/Never press Send/);
    expect(AGENT_PROPOSE_PROMPT).toMatch(/OK, Confirm/);
  });
});
