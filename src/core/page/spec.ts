import type { PageSpec } from "./catalog";

/** The description found back in a page made by `pageToHtml`; null for any other page. Kept in its own small module so the renderer can read a page's spec without carrying the page writer (and its bundled libraries) in the startup bundle. */
export function pageSpecOf(html: string): PageSpec | null {
  const m = /<script type="application\/json" id="site-spec">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  try { const v = JSON.parse(m[1]); return v && Array.isArray(v.sections) ? (v as PageSpec) : null; } catch { return null; }
}
