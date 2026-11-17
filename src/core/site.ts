import { withEngine } from "./engineRuntime";
import { ArtifactKind } from "../shared/types";
import { fileExtension } from "./artifacts";
import { FileLike, pageLinking } from "./bundle";
import * as path from "path";

/** A project written by the chat, put on disk as the real files of a site, so a browser can open it with its links working. */
export interface SiteFile { name: string; content: string }

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "");

/** The extensions a non-page file may keep when its title carries one: web assets a browser reads
 * by itself. Any other extension would make the system run the file as a program when it is
 * opened (.hta, .cmd, .vbs, .lnk...), so those files get the extension their kind gives. */
const ASSET_EXTENSIONS = new Set(["css", "js", "mjs", "json", "svg", "png", "jpg", "jpeg", "gif", "webp", "ico", "txt", "md", "csv", "woff", "woff2", "ttf", "wasm"]);

/** The file name of an artifact: its title when that already is one ("style.css"), else a name made from the title.
 * An HTML page is ALWAYS written with .html (or .htm when its title says so): a title like "app.hta" or "run.cmd"
 * is never kept, the system would run the file as a program instead of showing it. A non-page file keeps its
 * extension only when it is a web asset (ASSET_EXTENSIONS), else the extension its kind gives is used. */
export function siteFileName(f: FileLike): string {
  const base = f.title.trim().split(/[\\/]/).pop() ?? "";
  const name = safe(base);
  const fallback = `page.${fileExtension(f.kind as ArtifactKind, f.language)}`;
  if (!name) return fallback;
  const ext = /\.([A-Za-z0-9]{1,5})$/.exec(base);
  const extension = (() => {
    if (!ext) return fileExtension(f.kind as ArtifactKind, f.language);
    const e = ext[1].toLowerCase();
    if (f.kind === "html") return e === "htm" ? "htm" : "html";
    if (ASSET_EXTENSIONS.has(e)) return e;
    return fileExtension(f.kind as ArtifactKind, f.language);
  })();
  const stem = ext ? name.slice(0, name.length - ext[0].length) || "page" : name.toLowerCase();
  return `${stem}.${extension}`;
}

const HREF = /(\s(?:href|src)\s*=\s*)("([^"]*)"|'([^']*)')/gi;

/** The links of a page keep working: an attribute that names a file written under another name is written with the new one. */
function rewriteLinks(html: string, renamed: Map<string, string>): string {
  if (!renamed.size) return html;
  return html.replace(HREF, (m, pre: string, _quote: string, dq: string | undefined, sq: string | undefined) => {
    const raw = dq ?? sq ?? "";
    const file = raw.split(/[?#]/)[0].split(/[\\/]/).pop() ?? "";
    const next = file ? renamed.get(file.toLowerCase()) : undefined;
    return next ? `${pre}"${raw.replace(file, next)}"` : m;
  });
}

/** Every file of the project with a distinct, safe name (never a path out of the folder). */
export function siteFiles(files: FileLike[]): SiteFile[] {
  const used = new Set<string>();
  const named = files.filter((f) => f.content.trim()).map((f) => {
    let name = siteFileName(f);
    for (let n = 2; used.has(name.toLowerCase()); n++) name = name.replace(/(\.[^.]*)?$/, `-${n}$1`);
    used.add(name.toLowerCase());
    return { file: f, name };
  });
  // A file whose name changed (a page titled "about.hta" is written as "about.html") is linked
  // under the name it is written with, so the pages of a site keep pointing at each other.
  const renamed = new Map<string, string>();
  for (const { file, name } of named) {
    const base = file.title.trim().split(/[\\/]/).pop() ?? "";
    for (const old of new Set([base, safe(base)].map((x) => x.toLowerCase()))) {
      if (old && old !== name.toLowerCase() && !renamed.has(old)) renamed.set(old, name);
    }
  }
  return named.map(({ file, name }) => {
    const content = file.kind === "html" ? withEngine(rewriteLinks(file.content, renamed)) : file.content;
    return { name, content: content.endsWith("\n") ? content : `${content}\n` };
  });
}

/** The page a browser should open for `file`: itself when it is a page, else the page that links it, else the home page. */
export function siteEntry(file: FileLike, files: FileLike[]): string {
  const page = file.kind === "html" ? file : pageLinking(file, files) ?? files.find((f) => f.kind === "html" && /^index\.html?$/i.test(f.title.trim())) ?? files.find((f) => f.kind === "html");
  return page ? siteFiles([page])[0]?.name ?? "index.html" : "index.html";
}

/** The reason `entry` may not be opened in the browser, or null when it may: only a name ending
 * in .html/.htm that stays inside the folder just written is accepted — anything else the system
 * would run as a program (a page named "app.hta" or "run.cmd") or read outside the site. */
export function siteOpenRefusal(entry: string, dir: string): string | null {
  const refused = "Only an HTML page of the site can be opened in the browser.";
  if (!/\.html?$/i.test(entry)) return refused;
  const target = path.resolve(dir, entry);
  if (path.dirname(target) !== path.resolve(dir)) return refused;
  return null;
}
