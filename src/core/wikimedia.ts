/**
 * Pictures from Wikimedia Commons for an answer. The model asks with <wikiimage>keywords</wikiimage>, the app looks them up and
 * gives it a short list (name, what it shows, author, licence); the model then places the ones it picks in its answer as
 * ![caption](wikimedia:File name.jpg). The window loads each through the app (it has no network of its own), with its author and
 * licence written under it, as Commons asks. Nothing here talks to the network: main does, with the shapes below.
 */

/** Pictures in one answer, at most: past it a picture is shown as a link. The model is told fewer. */
export const MAX_IMAGES_SHOWN = 3;
export const MAX_IMAGE_SEARCHES_PER_ROUND = 2;

export const IMAGE_INSTRUCTIONS = [
  "You can add pictures from Wikimedia Commons, but only when a picture really helps: the user asks to see something, or a real thing (a place, an animal, a plant, a person, an object, an artwork, a map) is explained and seeing it beats words. Never for code, maths, abstract ideas, lists, advice or chat. Most answers have none.",
  "To look for one, write <wikiimage>2 to 5 keywords</wikiimage> (the English name of the thing works best) and stop; at most 2 searches. The candidates come back in the next message.",
  "Then put the best one (two at most, three never) where it belongs in your answer, as ![short caption](wikimedia:File name.jpg) on a line of its own, copying the file name exactly as listed. Never invent a file name, and do not describe a picture you have not been given."
].join("\n");

/** The file name inside a wikimedia: link (spaces may arrive as %20 or _). */
export const fileOfRef = (href: string): string | null => {
  const m = /^wikimedia:(.+)$/i.exec(href.trim());
  if (!m) return null;
  let f = m[1];
  try { f = decodeURIComponent(f); } catch { /* as written */ }
  f = f.replace(/^File:/i, "").replace(/_/g, " ").trim();
  return f && f.length < 200 && !/[<>|\\]/.test(f) ? f : null;
};
