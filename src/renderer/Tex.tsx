import { useEffect, useMemo, useState } from "react";
import { texToText } from "../core/math";

/** KaTeX is one of the largest pieces of the app and is needed only by answers with a formula in them: it loads on the first formula. */
type Katex = typeof import("katex").default;
let engine: Promise<Katex> | null = null;
/**
 * The engine once it has landed. A formula mounted after that typesets on its very first
 * render instead of showing plain text and then flipping to the typeset form, so only the
 * first formula of a session waits.
 */
let loaded: Katex | null = null;
const katex = () => (engine ??= Promise.all([import("katex"), import("katex/dist/katex.min.css")]).then(([m]) => (loaded = m.default)));

/** A formula typeset by KaTeX. Anything KaTeX cannot read is shown as plain text, never as an error. */
export function Tex({ v, display }: { v: string; display?: boolean }) {
  // The already-loaded engine seeds the state, so a later formula is typeset at once.
  const [k, setK] = useState<Katex | null>(loaded);
  useEffect(() => { let off = false; void katex().then((m) => { if (!off) setK(m); }); return () => { off = true; }; }, []);
  const html = useMemo(() => {
    if (!k) return null;
    try { return k.renderToString(v, { displayMode: !!display, throwOnError: true, strict: "ignore", trust: false, output: "html", maxExpand: 200 }); } catch { return null; }
  }, [k, v, display]);
  if (html === null) return display ? <div className="math-block">{texToText(v)}</div> : <span className="math">{texToText(v)}</span>;
  return display ? <div className="math-block tex" dangerouslySetInnerHTML={{ __html: html }} /> : <span className="tex" dangerouslySetInnerHTML={{ __html: html }} />;
}
