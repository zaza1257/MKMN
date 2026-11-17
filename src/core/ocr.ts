/**
 * Scanned pages, read on the device. A PDF page with no text
 * (a scan or a photo) is rendered to a picture by pdf.js in the renderer and
 * recognized by the Windows recognizer through the host's command
 * (src-tauri/src/ocr.rs). The pieces that are pure text work live here so the
 * renderer and the index share them:
 *
 *  - `SCANNED_MARK`: the one mark under a page's `[page N]` mark that says
 *    "these words were recognized from the picture, not typed in the file".
 *  - `ocrHintOf`: the recognizer's language hint, from the document's own
 *    readable words. An empty hint (nothing readable to sample) means the
 *    recognizer tries the person's own languages.
 *
 * The installed recognizer languages are used as they are; a missing language
 * is reported (the pack to add, named) and never "fixed" by the app — the
 * PC's language settings are the person's, not ours.
 */

/** The mark line under a `[page N]` mark: the page's words were recognized from its picture. */
export const SCANNED_MARK = "scanned text";

export const SCANNED_LINE = `[${SCANNED_MARK}]`;

const HAS_ARABIC = /[\u0600-\u06FF]/;

/** The recognizer's language hint for a document, from its readable words: "ar" when Arabic characters are there, "en" otherwise, "" when there is nothing readable to sample (a pure scan). */
export function ocrHintOf(sample: string): string {
  if (!sample.trim()) return "";
  return HAS_ARABIC.test(sample) ? "ar" : "en";
}
