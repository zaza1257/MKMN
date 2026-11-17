import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { loadIcons } from "../core/page/iconTable";
import { siteFiles, siteEntry, siteOpenRefusal } from "../core/site";

export interface LaunchFile { title: string; kind: string; language: string; content: string }

/** How the sidecar asks its host to open something (dispatcher.callHost, with the writer bound). */
export type CallHost = (method: string, args: unknown[], timeoutMs?: number) => Promise<unknown>;

/** The files of a site are written into a fresh temp folder and the host is asked to open the
 * entry page with the system's default program. Only a page (.html/.htm) of the folder just
 * written may be opened: an entry with another extension would be run as a program, so it is
 * refused here, before the host ever hears of it. */
export async function launchSite(files: LaunchFile[] | null, entry: LaunchFile, callHost: CallHost): Promise<{ path?: string; error?: string }> {
  try {
    // the pages of a site carry their icons through withEngine: the table has to have
    // landed before they are written, else the opened pages draw no icon
    await loadIcons();
    const root = path.join(os.tmpdir(), "open-npu-site");
    fs.mkdirSync(root, { recursive: true });
    for (const d of fs.readdirSync(root)) { try { if (Date.now() - fs.statSync(path.join(root, d)).mtimeMs > 24 * 3600_000) fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch { /* in use */ } }
    const dir = fs.mkdtempSync(path.join(root, "site-"));
    for (const f of siteFiles(files ?? [])) fs.writeFileSync(path.join(dir, f.name), f.content);
    const start = siteEntry(entry, files ?? []);
    const refusal = siteOpenRefusal(start, dir);
    if (refusal) return { error: refusal };
    const target = path.resolve(dir, start);
    if (!fs.existsSync(target)) return { error: "There is no page to open yet." };
    await callHost("openPath", [target], 60_000);
    return { path: target };
  } catch (e) { return { error: (e as Error).message }; }
}
