// The window agent's refusal rule for consequential controls. ONE word list
// (consequentialControls.json), read here by the sidecar before an action is
// sent and by the native driver (src-tauri/src/agent_wire.rs) at the moment of
// the action, against the element's live name. tests/computerUse-irreversible.test.ts
// runs the same cases as the driver's own Rust tests.

import list from "./consequentialControls.json";

/** Lowercase runs of ASCII letters and digits: the words an English entry is compared with. */
function words(s: string): string[] {
  return s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

const PHRASES: string[][] = list.english.map(words).filter((p) => p.length > 0);

/** The longest list entry the name matches, or null. */
export function consequentialWord(name: string): string | null {
  const w = words(name);
  let best: string | null = null;
  for (const p of PHRASES) {
    for (let i = 0; i + p.length <= w.length; i++) {
      if (p.every((x, j) => w[i + j] === x)) {
        const hit = p.join(" ");
        if (!best || hit.length > best.length) best = hit;
        break;
      }
    }
  }
  if (best) return best;
  for (const a of list.arabic) if (name.includes(a) && (!best || a.length > (best as string).length)) best = a;
  return best;
}

/** Why the action is refused as consequential, or null when it may run.
 *  click and toggle are judged on the element's name, select on the chosen
 *  item's name; a press on a control with no name is refused too. setValue,
 *  expand and collapse change nothing that cannot be undone. */
export function consequentialReason(kind: string, name: string | undefined, value?: string): string | null {
  if (kind === "click" || kind === "toggle") {
    const n = (name ?? "").trim();
    if (!n) return "the control has no name, so what it does cannot be judged; the person presses it";
    const hit = consequentialWord(n);
    return hit ? `"${n}" may send, confirm, delete or pay ("${hit}"), which this agent never does; the person presses it` : null;
  }
  if (kind === "select") {
    const v = (value ?? "").trim();
    const hit = v ? consequentialWord(v) : null;
    return hit ? `choosing "${v}" may send, confirm, delete or pay ("${hit}"), which this agent never does; the person chooses it` : null;
  }
  return null;
}
