/**
 * What MKMN needs on the PC: each runtime, whether the app cannot work without it, how its presence is read, and how a
 * missing one is put in place from the internet. A package is installed only from the fixed list below (never a name
 * built from input), with winget, which asks Windows for permission when the package needs it.
 */

import type { GeniexGateStatus } from "./geniexGate";

export type RequirementId = "webview2" | "geniex" | "npuDriver" | "models" | "voiceRuntime" | "foundry" | "python" | "libreoffice";

export interface Requirement {
  id: RequirementId;
  name: string;
  need: "required" | "optional";
  /** What uses it, in a sentence. */
  what: string;
  install: {
    /** A winget package id: the Install button runs winget with it. */
    winget?: string;
    /** Other winget ids that are the same thing installed another way (Python 3.11 when 3.12 is the one we install):
     * an update is offered for these too, and only for these. */
    wingetAlso?: RegExp;
    /** The app's own first-run setup installs it. */
    setup?: boolean;
    /** A Windows Settings page that provides it (drivers come through Windows Update). */
    settingsUri?: string;
    /** It ships inside the MKMN installer. */
    bundled?: boolean;
    /** It is downloaded from the app's Models library. */
    library?: boolean;
    /** Where to get it by hand when the automatic way is not there. */
    url: string;
  };
}

export const REQUIREMENTS: readonly Requirement[] = [
  { id: "webview2", name: "Microsoft Edge WebView2 Runtime", need: "required", what: "Draws the whole MKMN window.",
    install: { winget: "Microsoft.EdgeWebView2Runtime", url: "https://developer.microsoft.com/microsoft-edge/webview2/" } },
  { id: "geniex", name: "Qualcomm GenieX v0.11.0 or newer", need: "required", what: "Runs every local model on the NPU, and the router. An older GenieX, or one that reports no valid version, is not used.",
    install: { setup: true, url: "https://geniex.aihub.qualcomm.com/" } },
  { id: "npuDriver", name: "Qualcomm NPU driver", need: "required", what: "Lets GenieX and Foundry Local use the NPU.",
    install: { settingsUri: "ms-settings:windowsupdate", url: "https://www.qualcomm.com/support/software-tools/drivers" } },
  { id: "models", name: "A chat model", need: "required", what: "Answering on this PC. Not needed for cloud chat (HUMAIN Fuse or Node).",
    install: { library: true, url: "https://aihub.qualcomm.com/" } },
  { id: "voiceRuntime", name: "Speech runtime", need: "optional", what: "Dictation and reading answers aloud.",
    install: { bundled: true, url: "https://github.com/k2-fsa/sherpa-onnx" } },
  { id: "foundry", name: "Microsoft Foundry Local", need: "optional", what: "A second engine and its models.",
    install: { winget: "Microsoft.FoundryLocal", url: "https://learn.microsoft.com/azure/foundry-local/" } },
  { id: "python", name: "Python", need: "optional", what: "Running Python programs, the terminal and the benchmark's code checks.",
    install: { winget: "Python.Python.3.12", wingetAlso: /^Python\.Python\.3\.\d+$/, url: "https://www.python.org/downloads/windows/" } },
  { id: "libreoffice", name: "LibreOffice", need: "optional", what: "Opening old .doc, .xls and .ppt files and saving as OpenDocument or PDF.",
    install: { winget: "TheDocumentFoundation.LibreOffice", url: "https://www.libreoffice.org/download/" } }
];

export interface RequirementStatus { id: RequirementId; present: boolean; detail: string | null }

export type Runner = (exe: string, args: string[], timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** `winget install` for one package, exact id, no prompt of its own (Windows still asks for permission when needed). */
export function wingetArgs(id: string): string[] {
  return ["install", "--id", id, "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"];
}

/** Whether a winget package id is this requirement's (its own id, or one of the same thing installed another way). */
export function isPackageOf(req: Requirement, pkg: string): boolean {
  return !!req.install.winget && (pkg === req.install.winget || !!req.install.wingetAlso?.test(pkg));
}

export interface RequirementUpdate { id: RequirementId; pkg: string; current: string; available: string }

/**
 * The updates `winget upgrade` lists for MKMN's own requirements, and nothing else on the PC. Read by the package id
 * column, whatever the language of the headers: the id is a token of its own, then the installed and the newer version.
 */
export function parseUpgrades(out: string): RequirementUpdate[] {
  const found: RequirementUpdate[] = [];
  for (const line of out.split(/\r?\n/)) {
    const toks = line.trim().split(/\s+/);
    for (let i = 0; i + 2 < toks.length; i++) {
      const req = REQUIREMENTS.find((r) => isPackageOf(r, toks[i]));
      if (!req || !/\d/.test(toks[i + 1]) || !/\d/.test(toks[i + 2])) continue;
      if (!found.some((f) => f.pkg === toks[i])) found.push({ id: req.id, pkg: toks[i], current: toks[i + 1], available: toks[i + 2] });
      break;
    }
  }
  return found;
}

/** `winget upgrade` for one package that is already installed, exact id, no prompt of its own. */
export function wingetUpgradeArgs(pkg: string): string[] {
  return ["upgrade", "--id", pkg, "--exact", "--silent", "--accept-source-agreements", "--accept-package-agreements", "--disable-interactivity"];
}

const wingetMissing = (out: string) => /ENOENT|not recognized|cannot find/i.test(out);

/** Which of MKMN's requirements installed with winget have a newer version. */
export async function checkUpdates(d: { run: Runner }): Promise<{ ok: boolean; updates: RequirementUpdate[]; message: string }> {
  const r = await d.run("winget", ["upgrade", "--accept-source-agreements", "--disable-interactivity"], 3 * 60_000).catch((e) => ({ code: -1, out: String((e as Error).message) }));
  if (wingetMissing(r.out)) return { ok: false, updates: [], message: 'winget is not available on this PC (install "App Installer" from the Microsoft Store).' };
  const updates = parseUpgrades(r.out);
  // winget ends this listing with a non-zero code even when it worked; a listing with no table at all is a failure
  if (!updates.length && !/-{10,}/.test(r.out) && !/no (installed package|available upgrade)/i.test(r.out)) {
    return { ok: false, updates: [], message: `winget could not list updates: ${r.out.trim().split(/\r?\n/).slice(-1)[0] || `exit ${r.code}`}` };
  }
  return { ok: true, updates, message: updates.length ? `${updates.length} update${updates.length > 1 ? "s" : ""} available.` : "Everything installed with winget is up to date." };
}

/** Updates one requirement to its newest version. The package must be the requirement's own: never a name taken from input alone. */
export async function updateRequirement(id: string, pkg: string, d: { run: Runner }): Promise<{ ok: boolean; message: string }> {
  const req = REQUIREMENTS.find((r) => r.id === id);
  if (!req || !isPackageOf(req, pkg)) return { ok: false, message: `"${pkg}" is not a package MKMN updates.` };
  const r = await d.run("winget", wingetUpgradeArgs(pkg), 30 * 60_000).catch((e) => ({ code: -1, out: String((e as Error).message) }));
  if (r.code === 0) return { ok: true, message: `${req.name} is up to date.` };
  if (wingetMissing(r.out)) return { ok: false, message: 'winget is not available on this PC (install "App Installer" from the Microsoft Store).' };
  const said = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/ █▒]+$/.test(l)).slice(-3).join(" ");
  return { ok: false, message: `${req.name} was not updated: ${said || `winget exit ${r.code}`}. A program that is running (Foundry Local's service, LibreOffice) may need to be closed first.` };
}

/**
 * Whether the GenieX installer on the download server is newer than the GenieX installed here. GenieX has no
 * version feed and its own `geniex update` would skip MKMN's signature check, so this compares the date the server
 * gives the installer with the date geniex.exe was installed; an update goes through MKMN's own install (signed).
 */
export function geniexInstallerNewer(lastModified: string | null, installedAt: Date | null): boolean | null {
  const published = lastModified ? Date.parse(lastModified) : NaN;
  if (!Number.isFinite(published) || !installedAt) return null;
  return published > installedAt.getTime() + 24 * 3600_000;
}

/** The WebView2 version Windows records under its client key; null when the key is missing or holds the empty version. */
export function parseWebView2Version(out: string): string | null {
  const v = out.match(/\bpv\s+REG_SZ\s+([\d.]+)/i)?.[1];
  return v && !/^0(\.0)*$/.test(v) ? v : null;
}

/** The first NPU device of `Status|FriendlyName` lines; null when Windows lists none. */
export function parseNpuDevices(out: string): { ok: boolean; name: string } | null {
  const line = out.split(/\r?\n/).map((l) => l.trim()).find((l) => l.includes("|"));
  if (!line) return null;
  const [status, ...name] = line.split("|");
  return { ok: status.trim().toUpperCase() === "OK", name: name.join("|").trim() };
}

const WEBVIEW2_KEYS = [
  "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}",
  "HKCU\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
];
/** Neural processors Windows lists, by class or by name (the Snapdragon NPU is a ComputeAccelerator). */
const NPU_QUERY = "Get-PnpDevice -PresentOnly | Where-Object { $_.Class -eq 'ComputeAccelerator' -or $_.FriendlyName -cmatch '\\bNPU\\b' } | ForEach-Object { $_.Status + '|' + $_.FriendlyName }";

export interface CheckDeps {
  run: Runner;
  geniex: () => string | null;
  /** The minimum-version verdict (geniexGate.ts): when given, an older or unreadable GenieX is reported missing with why. */
  geniexGate?: () => Promise<GeniexGateStatus>;
  /** How many chat models GenieX or Foundry Local holds (null when it could not be read). */
  chatModels?: () => Promise<number | null>;
  voiceRuntime: () => boolean;
  python: () => string | null;
  office: () => string | null;
  platform: string;
}

/** What is on this PC now, for every requirement of the list. */
/**
 * How many chat models this PC holds: the GenieX cache's count plus Foundry Local's installed chat builds (its entries
 * in the Models list, which leave out speech and embedding models). Null when neither engine could be read.
 */
export function installedChatModels(geniex: number | null, foundry: readonly { foundryInstalled?: boolean }[] | null): number | null {
  if (geniex === null && foundry === null) return null;
  return (geniex ?? 0) + (foundry ?? []).filter((e) => e.foundryInstalled).length;
}

export async function checkRequirements(d: CheckDeps): Promise<RequirementStatus[]> {
  const win = d.platform === "win32";
  const webview2 = async (): Promise<RequirementStatus> => {
    if (!win) return { id: "webview2", present: false, detail: "Windows only" };
    for (const key of WEBVIEW2_KEYS) {
      const r = await d.run("reg", ["query", key, "/v", "pv"], 10_000).catch(() => ({ code: 1, out: "" }));
      const v = r.code === 0 ? parseWebView2Version(r.out) : null;
      if (v) return { id: "webview2", present: true, detail: v };
    }
    return { id: "webview2", present: false, detail: null };
  };
  const npu = async (): Promise<RequirementStatus> => {
    if (!win) return { id: "npuDriver", present: false, detail: "Windows only" };
    const r = await d.run("powershell", ["-NoProfile", "-NonInteractive", "-Command", NPU_QUERY], 30_000).catch(() => ({ code: 1, out: "" }));
    const dev = parseNpuDevices(r.out);
    if (!dev) return { id: "npuDriver", present: false, detail: "Windows lists no NPU device" };
    return { id: "npuDriver", present: dev.ok, detail: dev.ok ? dev.name : `${dev.name}: Windows reports a problem with its driver` };
  };
  const foundry = async (): Promise<RequirementStatus> => {
    const r = await d.run("foundry", ["--version"], 15_000).catch(() => ({ code: 1, out: "" }));
    const v = r.code === 0 ? r.out.trim().split(/\r?\n/)[0] : "";
    return { id: "foundry", present: !!v, detail: v || null };
  };
  const g = d.geniex(), py = d.python(), office = d.office();
  const geniex = async (): Promise<RequirementStatus> => {
    if (!d.geniexGate) return { id: "geniex", present: !!g, detail: g };
    const s = await d.geniexGate().catch(() => null);
    if (!s) return { id: "geniex", present: false, detail: "its version could not be checked" };
    return { id: "geniex", present: s.state === "ok", detail: s.state === "ok" ? `v${s.detected} · ${s.path}` : s.message };
  };
  const models = async (): Promise<RequirementStatus> => {
    const n = d.chatModels ? await d.chatModels().catch(() => null) : null;
    if (n === null) return { id: "models", present: false, detail: "the installed models could not be read (GenieX missing or not usable)" };
    return { id: "models", present: n > 0, detail: n > 0 ? `${n} installed` : "none installed: download one from Settings → Models" };
  };
  return [
    await webview2(),
    await geniex(),
    await npu(),
    await models(),
    { id: "voiceRuntime", present: d.voiceRuntime(), detail: null },
    await foundry(),
    { id: "python", present: !!py, detail: py },
    { id: "libreoffice", present: !!office, detail: office }
  ];
}

/** Installs one requirement of the list with winget; the message says what happened, with winget's own words when it failed. */
export async function installRequirement(id: string, d: { run: Runner }): Promise<{ ok: boolean; message: string }> {
  const req = REQUIREMENTS.find((r) => r.id === id);
  if (!req) return { ok: false, message: `"${id}" is not a requirement of MKMN.` };
  const pkg = req.install.winget;
  if (!pkg) {
    const how = req.install.setup ? "MKMN's setup installs it (Settings → Developer → Runtime)." : req.install.settingsUri ? "It comes through Windows Update." : "It ships with MKMN: reinstall MKMN to restore it.";
    return { ok: false, message: `${req.name} is not installed with a package. ${how}` };
  }
  const r = await d.run("winget", wingetArgs(pkg), 30 * 60_000).catch((e) => ({ code: -1, out: String((e as Error).message) }));
  if (r.code === 0) return { ok: true, message: `${req.name} is installed.` };
  const said = r.out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[-\\|/ █▒]+$/.test(l)).slice(-3).join(" ");
  if (/ENOENT|not recognized|cannot find/i.test(r.out)) {
    return { ok: false, message: `winget is not available on this PC (install "App Installer" from the Microsoft Store), or get ${req.name} from ${req.install.url}` };
  }
  return { ok: false, message: `${req.name} was not installed: ${said || `winget exit ${r.code}`}. You can also get it from ${req.install.url}` };
}
