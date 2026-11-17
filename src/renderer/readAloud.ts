/**
 * Whether a reply is spoken as it arrives. A typed chat shows it silently: speech starts there only from the
 * reply's own Read aloud button. A reply is spoken by itself only in a voice chat the person started.
 * The voice state is never asked: a reading that was stopped could leave it set and make every typed reply speak.
 */
export function speaksReply(o: { fromVoice: boolean; voiceChatOn: boolean; ttsReady: boolean }): boolean {
  return o.ttsReady && (o.fromVoice || o.voiceChatOn);
}
