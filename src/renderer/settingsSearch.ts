// The settings map: the eight groups of the 2.10 Settings page, the search index
// that makes every preference findable by the words people actually use, and the
// redirects that keep the pre-2.10 deep links working. Deep links name a section
// id so a search result opens the exact control. Every stored key's entry is
// generated from the schema (src/shared/settingsSchema.ts); only rows that are
// not stored keys (buttons, pages, destinations) are written here.
import { schemaSearchEntries, SETTING_GROUPS } from "../shared/settingsSchema";
import type { SettingGroup } from "../shared/settingsSchema";

export type SettingsTab = SettingGroup;

export interface TabMeta { id: SettingsTab; label: string; hint: string }

const TAB_HINTS: Record<SettingsTab, string> = {
  general: "Appearance and window behavior",
  library: "Install and choose models to run on this PC",
  models: "Manage on-device compute, memory and power",
  chats: "Where chat runs, thinking and tools",
  files: "Writing, code checks and project defaults",
  web: "Capabilities, cost estimates and the HUMAIN API console",
  fuse: "API key, chat model, hosted search and thinking",
  node: "API key, chat model and realtime",
  about: "App information, version, updates and help",
  voice: "Microphone, on-device dictation, read-aloud and voice chat",
  developer: "Local runtime, model routing and diagnostics",
};

export const PRIMARY_TABS: TabMeta[] = SETTING_GROUPS.map((tab) => ({ ...tab, hint: TAB_HINTS[tab.id] }));

export const SETTINGS_SECTIONS: ReadonlyArray<{ label: string; tabs: readonly SettingsTab[] }> = [
  { label: "General", tabs: ["general", "chats", "files"] },
  { label: "Local Intelligence", tabs: ["library", "models", "voice", "developer"] },
  { label: "Cloud Intelligence", tabs: ["fuse", "node", "web"] },
  { label: "About", tabs: ["about"] },
];

export const TAB_META: SettingsTab[] = PRIMARY_TABS.map((t) => t.id);

/** Sections inside Developer that only exist when the developer tools are on
 *  (the "Developer tools" switch in the same group). A search result naming one
 *  is hidden while the tools are off, so a result can never open onto nothing. */
export const DEV_SECTIONS: ReadonlySet<string> = new Set([
  "sec-route-dynamic",
  "sec-diag-bench", "sec-diag-suite", "sec-diag-npu", "sec-diag-engines",
  "sec-diag-foundry", "sec-diag-providers", "sec-diag-battery", "sec-diag-lab",
]);

/** The pre-2.10 tab ids: a saved location or an old deep link that names one
 *  lands on the group that inherited its controls. */
export const LEGACY_TAB_REDIRECT: Record<string, SettingsTab> = {
  general: "general",
  models: "models",
  voice: "voice",
  build: "files",
  search: "web",
  behavior: "chats",
  "adv-system": "developer",
  "adv-runtime": "developer",
  "adv-routing": "developer",
  "adv-diag": "developer",
};

/** Resolve any tab id — a group id or a pre-2.10 id — to a group. Unknown ids
 *  land on General (the first group), never on a blank page. */
export function redirectTab(id: string | null | undefined): SettingsTab {
  if (id && TAB_META.includes(id as SettingsTab)) return id as SettingsTab;
  return (id && LEGACY_TAB_REDIRECT[id]) || "general";
}

/** The one shared source for a group's name: links, buttons and breadcrumbs
 *  that lead to a settings group all say the same words, so they cannot drift apart. */
export const tabLabel = (id: SettingsTab): string =>
  PRIMARY_TABS.find((t) => t.id === id)?.label ?? id;

function settingsPath(tab: SettingsTab | undefined): string {
  if (!tab) return "";
  const label = tabLabel(tab);
  const section = SETTINGS_SECTIONS.find(({ tabs }) => tabs.includes(tab));
  return section && section.label !== label ? `${section.label} › ${label}` : label;
}

/** Sections that hold real controls: deep links scroll to them. A `dest` entry leaves
 * the settings dialog for another page (the Customize editors) instead of a section. */
export interface SettingsEntry {
  label: string;
  tab?: SettingsTab;
  section?: string;
  /** Another page to open instead of a settings tab: "customize" = the Customize page. */
  dest?: "customize";
  /** Words the search also matches, including the task words people type. */
  aliases?: string[];
  /** "conversation" marks the rare preferences a chat can also change contextually. */
  scope?: "global" | "conversation";
}

export const SETTINGS_SEARCH: SettingsEntry[] = [
  // Every stored key comes from the schema (src/shared/settingsSchema.ts): its
  // label, its group, and the old words the search keeps.
  // Below, only the rows that are not stored keys: buttons, pages and the
  // destinations that leave the dialog.
  ...schemaSearchEntries().map((e) => ({ ...e, tab: e.tab as SettingsTab })),
  // The model library, a page of the Models group, not a stored key.
  { label: "Models library (install, remove, choose)", tab: "library", section: "sec-library", aliases: ["install model", "download model", "remove model", "choose model", "catalog", "recommended", "foundry local", "hugging face"] },
  // The HUMAIN connection controls use the Windows credential store.
  { label: "HUMAIN connections", tab: "web", section: "sec-humain-routing" },
  { label: "HUMAIN Fuse connection", tab: "fuse", section: "sec-humain-fuse", aliases: ["test connection", "check key", "API key", "cloud setup"] },
  { label: "HUMAIN Node connection", tab: "node", section: "sec-humain-node", aliases: ["test connection", "check key", "API key", "cloud setup"] },
  { label: "HUMAIN API console", tab: "web", section: "sec-humain-api", aliases: ["API request", "API explorer"] },
  // Preferences whose editors live on the Customize page: findable from settings,
  // opened there (dest entries leave the dialog instead of scrolling).
  { label: "Personal instructions (about me, tone, language)", dest: "customize", aliases: ["personalization", "custom instructions", "persona", "identity", "tone of voice", "write like me"] },
  { label: "Skills (step-by-step recipes)", dest: "customize", aliases: ["skills", "recipes", "routines", "workflows", "automation"] },
  { label: "Version and updates", tab: "about", section: "sec-about-update", aliases: ["installer", "upgrade", "version"] },
  { label: "Bug report (copy diagnostics)", tab: "about", section: "sec-about-help", aliases: ["support", "diagnostics", "copy log"] },
  { label: "About MKMN AI and privacy", tab: "about", section: "sec-about-mkmn", aliases: ["licence", "attribution", "confidential"] },
  // Developer-group screens and tools, which are not stored keys
  { label: "This PC (chip, RAM, NPU, driver)", tab: "developer", section: "sec-sys-hardware", aliases: ["hardware", "chip", "driver", "machine"] },
  { label: "Execution verification (NPU evidence)", tab: "developer", section: "sec-sys-execution", aliases: ["telemetry", "htp counters", "verified"] },
  { label: "Last error and server log", tab: "developer", section: "sec-sys-errors", aliases: ["error", "log", "crash"] },
  { label: "Local endpoint (OpenAI-compatible)", tab: "developer", section: "sec-rt-endpoint", aliases: ["api", "cherry studio", "vs code", "127.0.0.1"] },
  { label: "Model routing (the Dynamic model)", tab: "developer", section: "sec-route-dynamic", aliases: ["dynamic", "pack", "router", "roles"] },
  { label: "Single-model benchmark", tab: "developer", section: "sec-diag-bench", aliases: ["benchmark", "tok/s", "ttft", "speed test"] },
  { label: "Benchmark suite (all models)", tab: "developer", section: "sec-diag-suite", aliases: ["benchmark", "launch check", "suite"] },
  { label: "Reset the NPU (recovery)", tab: "developer", section: "sec-sys-recovery", aliases: ["npu stuck", "reset", "driver", "recover"] },
  { label: "NPU load test", tab: "developer", section: "sec-diag-npu", aliases: ["load test", "what the npu accepts"] },
  { label: "Engine comparison (runtime vs Foundry Local)", tab: "developer", section: "sec-diag-engines", aliases: ["engines", "foundry", "compare"] },
  { label: "Foundry Local settings (server, cache, models)", tab: "developer", section: "sec-diag-foundry", aliases: ["foundry", "port", "idle timeout", "log level", "cache folder", "server logs", "register model", "unregister", "transcribe", "execution provider", "diagnostics"] },
  { label: "Providers and artifact sources", tab: "developer", section: "sec-diag-providers", aliases: ["sources", "hugging face", "docker"] },
  { label: "Battery draw", tab: "developer", section: "sec-diag-battery", aliases: ["battery", "power draw"] },
  { label: "Prompt lab", tab: "developer", section: "sec-diag-lab", aliases: ["prompts", "test prompts"] },
];

export interface SearchHit extends SettingsEntry { tabLabel: string }

/** Case-insensitive match on the label, the aliases and the destination's name. */
export function searchSettings(query: string): SearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const words = q.split(/\s+/);
  const hits: { e: SettingsEntry; score: number }[] = [];
  for (const e of SETTINGS_SEARCH) {
    const hay = [e.label, ...(e.aliases ?? []), settingsPath(e.tab)].join(" ").toLowerCase();
    if (!words.every((w) => hay.includes(w))) continue;
    // exact label phrase first, then a label word hit, then alias-only matches
    const score = e.label.toLowerCase().includes(q) ? 0 : e.label.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) ? 1 : 2;
    hits.push({ e, score });
  }
  return hits
    .sort((a, b) => a.score - b.score || a.e.label.localeCompare(b.e.label))
    .slice(0, 8)
    .map(({ e }) => ({ ...e, tabLabel: e.dest === "customize" ? "Customize" : settingsPath(e.tab) }));
}
