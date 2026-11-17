import { useRef, type KeyboardEvent } from "react";
import { Seg } from "./Seg";
import { RADIO_NAV_KEYS, radioMove, radioTabStop } from "../core/settingsUi";

/**
 * A radio group drawn with the segmented control, with complete radio-group keyboard
 * behavior: ONE tab stop (the checked choice when enabled, otherwise the first enabled
 * choice — the group never becomes Tab-unreachable because the saved selection is
 * unavailable), arrow keys move the selection and wrap (skipping disabled choices, like
 * a native radio group), Home and End jump, and the checked state is exposed through
 * role="radio"/aria-checked. Only navigation keys are intercepted: Tab, Shift+Tab,
 * Space, Enter and anything else keep their normal behavior.
 */
export function RadioSeg<T extends string>({ value, options, onChange, ariaLabel, className }: {
  value: T; ariaLabel: string;
  options: { id: T; label: string; disabled?: boolean; why?: string }[];
  onChange: (v: T) => void;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stop = radioTabStop(options, value);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!RADIO_NAV_KEYS.has(e.key)) return; // not ours: never preventDefault, never steal focus
    const el = ref.current;
    if (!el) return;
    // the buttons live inside the Seg wrapper (a grandchild of this div)
    const all = Array.from(el.querySelectorAll<HTMLButtonElement>("button[role='radio']"));
    const enabled = all.map((b, i) => (b.disabled ? -1 : i)).filter((i) => i >= 0);
    if (enabled.length === 0) return;
    const focusIdx = all.indexOf(document.activeElement as HTMLButtonElement);
    // the roving anchor: the focused choice, else the checked one, else the first enabled
    const anchor = focusIdx >= 0 && !all[focusIdx].disabled
      ? enabled.indexOf(focusIdx)
      : Math.max(0, enabled.indexOf(all.findIndex((b) => b.getAttribute("aria-checked") === "true")));
    const nextPos = radioMove(enabled.length, anchor === -1 ? 0 : anchor, e.key);
    const opt = options[enabled[nextPos]];
    if (!opt || opt.disabled) return;
    e.preventDefault();
    all[enabled[nextPos]].focus();
    if (opt.id !== value) onChange(opt.id); // native radio semantics: the selection follows the arrow
  };

  return (
    <div ref={ref} onKeyDown={onKeyDown}>
      <Seg role="radiogroup" aria-label={ariaLabel} className={className}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={value === o.id}
            tabIndex={stop === o.id ? 0 : -1}
            className={value === o.id ? "on" : ""}
            disabled={o.disabled}
            title={o.why}
            onClick={() => onChange(o.id)}
          >{o.label}</button>
        ))}
      </Seg>
    </div>
  );
}
