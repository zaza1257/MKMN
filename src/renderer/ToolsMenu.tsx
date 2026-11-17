import { useEffect, useRef } from "react";
import type { CatalogItem } from "../shared/api";
import type { Effort, Settings } from "../shared/types";
import { readBool, readSetting } from "../shared/settingsSchema";
import { Seg } from "./Seg";
import { useExit } from "./usePresence";
import { TOOL_COMMANDS } from "../core/toolCommands";
import { EFFORTS, effectiveEffort, effortsFor, thinkingSupport } from "../core/effort";
import { AgentsIcon, GearIcon, LayersIcon, ThinkingIcon, ToolsIcon } from "./Icons";

/** One switch row: icon, a short label, ONE line saying what it does, the switch.
 *  The longer detail is the row's tooltip; nothing opens under a switch, so the
 *  menu never changes height while it is used. */
function Row({ icon, label, hint, detail, warn, on, onToggle }: { icon: React.ReactNode; label: string; hint: string; detail?: string; warn?: string; on: boolean; onToggle: () => void }) {
  return (
    <button className="menu-row tool-row" role="menuitemcheckbox" aria-checked={on} onClick={onToggle} title={detail ?? hint}>
      <span className="tool-icon">{icon}</span>
      <span className="menu-label">{label}<span className={`small tool-hint ${warn ? "warn" : "muted"}`}>{warn ?? hint}</span></span>
      <span className={`switch ${on ? "on" : ""}`} aria-hidden />
    </button>
  );
}

/**
 * The chat's own quick controls ("This chat"): only everyday choices whose scope is
 * this chat or this message — thinking (per message), tools
 * only on command, sub-agents, keeping long chats going. Advanced chat settings
 * (the turn budget) and every app-wide control live in the Settings page; the last
 * row opens it on the Chats & answers group. Every control reads and writes through
 * the settings schema, so the menu can never show one default while the app acts on
 * another.
 */
export function ToolsMenu({ settings, selected, onSave, onOpenSettings, onClose: onCloseProp }: { settings: Settings; selected: CatalogItem | null; onSave: (p: Partial<Settings>) => void; onOpenSettings: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const { leaving, close: onClose } = useExit(onCloseProp);
  useEffect(() => {
    const down = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("mousedown", down); document.removeEventListener("keydown", key); };
  }, [onClose]);

  const support = selected ? thinkingSupport(selected.entry) : "none";
  const levels = effortsFor(support);
  const level = effectiveEffort(readSetting(settings, "effort"), support);
  const commands = TOOL_COMMANDS.map((c) => `/${c.word}`).join(" ");

  return (
    <div className="menu tools-menu" ref={ref} role="menu" data-state={leaving ? "closed" : "open"}>
      <div className="menu-title">This chat<span className="muted small tool-hint">Applies to your next messages, in every chat</span></div>
      {levels.length > 0 && (
        <div className="tool-think" role="group" aria-label="Thinking">
          <div className="tool-think-head">
            <span className="tool-icon"><ThinkingIcon /></span>
            <span className="menu-label">Thinking<span className="muted small tool-hint">How long it thinks before answering</span></span>
          </div>
          <Seg className="small tool-think-seg">
            {EFFORTS.filter((e) => levels.includes(e.id)).map((e) => <button key={e.id} className={e.id === level ? "on" : ""} onClick={() => onSave({ effort: e.id as Effort })} title={e.hint}>{e.label}</button>)}
          </Seg>
        </div>
      )}
      <Row icon={<ToolsIcon />} label="Tools only on /command" hint="A tool runs only when you type its / word"
        detail={`${commands} — for example “/build make a dashboard”. Without a command it is a plain chat: no tool, no router, no file-building steps, no automatic fixes.`}
        on={readBool(settings, "toolsOnCommand")} onToggle={() => onSave({ toolsOnCommand: !readBool(settings, "toolsOnCommand") })} />
      <Row icon={<AgentsIcon />} label="Sub-agents" hint="Splits a big job into parts"
        detail="Offered only when the request asks for it or splits into independent parts; the parts run one after another."
        on={readBool(settings, "subagents")} onToggle={() => onSave({ subagents: !readBool(settings, "subagents") })} />
      <Row icon={<LayersIcon />} label="Keep long chats going" hint="Summarizes the oldest messages"
        detail="After an answer, the oldest part of a long conversation is summarized and kept with the chat; a later question about those turns reads them back."
        on={readBool(settings, "autoCompact")} onToggle={() => onSave({ autoCompact: !readBool(settings, "autoCompact") })} />
      <div className="menu-sep" role="separator" />
      <button className="menu-row tool-row" role="menuitem" onClick={() => { onClose(); onOpenSettings(); }}>
        <span className="tool-icon"><GearIcon /></span>
        <span className="menu-label">More settings<span className="muted small tool-hint">Turn budget, code check, files beside the chat</span></span>
      </button>
    </div>
  );
}
