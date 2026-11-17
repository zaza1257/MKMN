import { describe, expect, it } from "vitest";
import { speaksReply } from "../src/renderer/readAloud";

// A typed reply is shown silently; it is spoken only in a voice chat the person started (or on its Read aloud button,
// which does not go through this rule). New, regenerated and reopened replies follow the same rule.
describe("when a reply is spoken by itself", () => {
  it("never in a typed chat, whatever the voice state was left at", () => {
    expect(speaksReply({ fromVoice: false, voiceChatOn: false, ttsReady: true })).toBe(false);
  });
  it("in a voice chat the person started", () => {
    expect(speaksReply({ fromVoice: true, voiceChatOn: true, ttsReady: true })).toBe(true);
    expect(speaksReply({ fromVoice: false, voiceChatOn: true, ttsReady: true })).toBe(true); // typed while the voice chat is on
  });
  it("never without a voice to speak with", () => {
    expect(speaksReply({ fromVoice: true, voiceChatOn: true, ttsReady: false })).toBe(false);
  });
});
