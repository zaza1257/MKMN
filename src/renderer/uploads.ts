import type { Attachment } from "../shared/types";
import { classifyFile, noPdfText, refusal } from "../core/attachments";
import { describePdfError } from "../core/pdf";

/**
 * One addFiles run, with an identity and a conversation it belongs to. A run may die four ways —
 * a newer addFiles supersedes it, the person presses Cancel, the chat switches, the chat closes —
 * and whichever way it dies, it must never again touch the composer, the notice, the reading
 * state or any conversation but its own. Files it already read stay (each was appended the moment
 * it was read); everything else it discards quietly.
 */

/** The reads a run performs; the chat wires the real ones (pdf.js, docs, the media store) so this module stays free of them. */
export interface UploadIo {
  readPdf(f: File, o: { onProgress: (page: number, total: number) => void; signal: AbortSignal; onOcrProblem?: (message: string) => void }): Promise<string>;
  readDocument(f: File): Promise<string>;
  saveMedia(dataUrl: string, name: string): Promise<{ mediaId?: string } | null>;
  /** An image as a data URL. */
  readImage(f: File): Promise<string>;
  readText(f: File): Promise<string>;
}

export interface UploadEnv {
  /** The conversation open right now. */
  currentConv: () => string;
  /** Adds fully read files to the composer. Only ever called while the run owns the chat. */
  appendFiles: (files: Attachment[]) => void;
  /** Replaces the composer notice. Only ever called while the run owns the chat. */
  setNotice: (text: string | null) => void;
  /** The reading state behind the Cancel button. */
  setReading: (on: boolean) => void;
  canSee: () => boolean;
}

export class UploadManager {
  private runId = 0;
  private ac: AbortController | null = null;

  constructor(private io: UploadIo, private env: UploadEnv) {}

  /** The person pressed Cancel (or the chat changed, or the chat closed). */
  cancel(): void {
    this.ac?.abort();
  }

  /** A truthy check for every state update: still the newest run, still not cancelled, still the same chat. */
  private mine(run: number, owner: string, ac: AbortController): boolean {
    return !ac.signal.aborted && this.runId === run && this.env.currentConv() === owner;
  }

  /** Races a read against the run's abort: reads that cannot be stopped mid-way (documents, images,
     the media store, plain text) are cut the moment the run dies instead of being waited on. */
  private cut<T>(ac: AbortController, p: Promise<T>): Promise<T> {
    if (ac.signal.aborted) return Promise.reject(new DOMException("The read was stopped", "AbortError"));
    return new Promise<T>((res, rej) => {
      const on = () => rej(new DOMException("The read was stopped", "AbortError"));
      ac.signal.addEventListener("abort", on, { once: true });
      p.then(
        (v) => { ac.signal.removeEventListener("abort", on); res(v); },
        (e) => { ac.signal.removeEventListener("abort", on); rej(e); }
      );
    });
  }

  /** Adds files, one at a time, appending each the moment it is fully read. Never throws. */
  async add(list: FileList | File[]): Promise<void> {
    const files = Array.from(list);
    this.ac?.abort(); // a newer run supersedes the older one: its remaining files are not read
    const run = ++this.runId;
    const ac = new AbortController();
    this.ac = ac;
    const owner = this.env.currentConv();
    this.env.setReading(true);
    const problems: string[] = [];
    const say = (text: string | null) => { if (this.mine(run, owner, ac)) this.env.setNotice(text); };
    let read = 0;
    try {
      for (const f of files) {
        if (!this.mine(run, owner, ac)) return; // superseded, cancelled, or the chat changed: stop here
        const why = refusal(f, true); // any model gets images: one that cannot see them has them described first
        if (why) { problems.push(why); say(problems.join(" ")); continue; }
        try {
          const kind = classifyFile(f.name, f.type);
          let one: Attachment | null = null;
          if (kind === "pdf") {
            // a scanned page is recognized on the device (D6); when the recognizer could
            // not read the file at all, its own problem (the language pack to add) is what
            // the person reads — the generic "no selectable text" only stands when
            // recognition also found nothing
            let ocrProblem: string | null = null;
            const text = await this.io.readPdf(f, {
              onProgress: (page, total) => say(`${f.name}: reading page ${page} of ${total}…`),
              signal: ac.signal,
              onOcrProblem: (m) => { ocrProblem ??= m; },
            });
            if (!this.mine(run, owner, ac)) return;
            if (!text.trim()) { problems.push(ocrProblem ?? noPdfText(f.name)); continue; }
            one = { name: f.name, kind: "text", size: f.size, text };
          } else if (kind === "document") {
            const text = await this.cut(ac, this.io.readDocument(f)); // not cancellable mid-read; cut when the run dies, discarded when stale
            if (!this.mine(run, owner, ac)) return;
            one = { name: f.name, kind: "text", size: f.size, text };
          } else if (kind === "image") {
            const dataUrl = await this.cut(ac, this.io.readImage(f));
            if (!this.mine(run, owner, ac)) return;
            // saved as a file in the local media store: the chat keeps its id, so a restart does not lose the picture
            let mediaId: string | undefined;
            try { const saved = await this.cut(ac, this.io.saveMedia(dataUrl, f.name)); if (saved?.mediaId) mediaId = saved.mediaId; } catch (e) { if (ac.signal.aborted) throw e; /* this session still has the bytes */ }
            if (!this.mine(run, owner, ac)) return;
            one = { name: f.name, kind: "image", size: f.size, dataUrl, mediaId };
          } else {
            const text = await this.cut(ac, this.io.readText(f));
            if (!this.mine(run, owner, ac)) return;
            one = { name: f.name, kind: "text", size: f.size, text };
          }
          read++;
          this.env.appendFiles([one]); // appended the moment it is read, while the run still owns the chat
        } catch (e) {
          if (ac.signal.aborted) return; // cancelled mid-read: not an error the person asked to see
          // PDFs (and documents) name the real reason — a password, a damaged file, a stop —
          // the other kinds keep the old one-line refusal.
          const kind = classifyFile(f.name, f.type);
          problems.push(kind === "pdf" ? describePdfError(f.name, e) : kind === "document" ? (e as Error).message : `${f.name}: could not be read.`);
          say(problems.join(" "));
        }
      }
      if (!this.mine(run, owner, ac)) return; // a dead run never writes a final word over a newer run's notice
      if (!this.env.canSee() && files.some((f) => classifyFile(f.name, f.type) === "image") && read > 0) {
        problems.push("This model cannot see images itself: an installed vision model looks at the image first, and its description goes with your message.");
      }
      this.env.setNotice(problems.length ? problems.join(" ") : null);
    } finally {
      if (this.runId === run) {
        // still the newest run: it may take the Cancel button down (its chat may have switched away —
        // the chat's own effect clears the state too, and a stale true must never survive either way)
        this.env.setReading(false);
        if (ac.signal.aborted && this.env.currentConv() === owner) {
          // cancelled with the chat still open and nothing newer: say what was kept and what was not
          const left = files.length - read;
          this.env.setNotice(read === 0 ? "Reading was stopped: no file was added."
            : left > 0 ? `Stopped: ${read} of ${files.length} file${files.length === 1 ? "" : "s"} added; the remaining ${left} ${left === 1 ? "was" : "were"} not read.`
            : null);
        }
      } else {
        ac.abort(); // a superseded run stops its own in-flight reads too
      }
    }
  }
}
