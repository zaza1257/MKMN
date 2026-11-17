import type { KeyboardEvent } from "react";

/**
 * A row whose main action is a click, made a keyboard target too: it takes focus,
 * it is announced as a button, and Enter or Space opens it. A key pressed on a
 * button INSIDE the row (Delete, a chevron) stays that button's own.
 */
export function rowAction(fn: () => void, role: "button" | "listitem" = "button") {
  return {
    role,
    tabIndex: 0,
    onClick: fn,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); }
    },
  };
}
