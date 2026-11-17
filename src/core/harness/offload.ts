/**
 * The offload store (the context engine): a step's large payload does not
 * ride in the journal or in a prompt — it goes to a file next to the run's journal,
 * and the step record keeps a typed pointer (the journal's PromptSectionRef, which
 * holds names and sizes, never the text) plus a small preview (the first and last
 * lines). Reading the payload back is an explicit step, paged by offset and limit.
 *
 * Everything here derives its paths from the caller: the offload folder is the
 * journal's own folder (the workspace's `harness` folder in the app, a test's
 * temporary folder in the suite), so no path is resolved twice and no test writes
 * into a real workspace.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { PromptSectionRef } from "./journal";

/** A payload at most this big rides whole; a bigger one is offloaded. An eighth of the window (about 3 characters a token), never below 2048 bytes. */
export function offloadThreshold(nctx: number): number {
  return Math.max(2048, Math.floor((nctx * 3) / 8));
}

/** The first and the last lines of a payload, and how much a preview of them does not show. */
export function previewOf(text: string, keep = 5): { head: string; tail: string; cut: number; lines: number } {
  const lines = text === "" ? 0 : text.split("\n").length;
  if (lines <= keep * 2) return { head: text, tail: "", cut: 0, lines };
  const ls = text.split("\n");
  const head = ls.slice(0, keep).join("\n");
  const tail = ls.slice(-keep).join("\n");
  const cut = text.length - head.length - tail.length - 2; // the two joins the preview replaces
  return { head, tail, cut, lines };
}

/** One offloaded payload: the typed pointer a step record keeps, plus its preview. */
export interface OffloadRef {
  /** The payload file, named inside the run's offload folder. */
  file: string;
  bytes: number;
  lines: number;
  head: string;
  tail: string;
  /** Characters the preview does not show (0 when the payload rode whole). */
  cut: number;
}

/** The record a prompt section carries in the journal for an offloaded payload. */
export const offloadSection = (ref: OffloadRef): PromptSectionRef => ({ name: `offload:${ref.file}`, bytes: ref.bytes });

/** The name the folded turns of one conversation are kept under in the offload store: stable across its turns, so a later question can recall them. */
export const foldOffloadName = (convId: string): string => `fold-${convId.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;

/** Write one payload into `dir` and return its pointer. The file is written whole, once; it is never appended to. */
export function offloadPayload(dir: string, name: string, text: string): OffloadRef {
  mkdirSync(dir, { recursive: true });
  const file = name.endsWith(".txt") ? name.replace(/[^A-Za-z0-9._-]/g, "_") : `${name.replace(/[^A-Za-z0-9._-]/g, "_")}.txt`;
  writeFileSync(path.join(dir, file), text, "utf8");
  const p = previewOf(text);
  return { file, bytes: Buffer.byteLength(text, "utf8"), lines: p.lines, head: p.head, tail: p.tail, cut: p.cut };
}

/** The preview a step record's reply shows for an offloaded payload: the marker between head and tail names the file and the sizes. */
export const previewText = (ref: OffloadRef): string =>
  `${ref.head}\n[…the rest of this reply (${ref.cut} more characters, ${ref.lines} lines in all) is offloaded to ${ref.file}; ask for a part of it and it will be read back]\n${ref.tail}`;

/** One page of an offloaded payload: reading back is explicit, paged by character offset and limit. */
export interface ReadBack {
  text: string;
  /** Where the next page starts; equal to the payload's length when done. */
  nextOffset: number;
  done: boolean;
}

const READ_PAGE = 4000;

export function readBack(file: string, offset = 0, limit = READ_PAGE): ReadBack {
  if (!existsSync(file)) return { text: "", nextOffset: offset, done: true };
  const text = readFileSync(file, "utf8");
  const start = Math.max(0, Math.min(offset, text.length));
  const page = text.slice(start, start + limit);
  const nextOffset = start + page.length;
  return { text: page, nextOffset, done: nextOffset >= text.length };
}

/** Old steps' long arguments are cut with this marker before a summary reads them: what was cut is said, never silently dropped. */
export const truncateForPrompt = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.length - max;
  return `${text.slice(0, max)}\n[…truncated: ${cut} characters were cut before this summary]`;
};

/**
 * The plan of a run, as a file: the plan lives on disk, the steps read it (paged,
 * like any offloaded payload) and update it by rewriting it whole, and the journal
 * holds only its pointer (name and bytes, never the text). The plan is never
 * re-sent whole in every prompt.
 */
export interface PlanFile {
  file: string;
  /** The pointer a step record lists when it saw the plan. */
  ref(): PromptSectionRef;
  read(offset?: number, limit?: number): ReadBack;
  /** Rewrite the plan whole (a plan is one page, never appended to blindly); the fresh pointer comes back. */
  update(text: string): PromptSectionRef;
}

export function openPlan(dir: string, name: string, plan: string): PlanFile {
  const ref = offloadPayload(dir, name, plan);
  const file = path.join(dir, ref.file);
  return {
    file,
    ref: () => ({ name: `plan:${ref.file}`, bytes: ref.bytes }),
    read: (offset, limit) => readBack(file, offset, limit),
    update: (text: string) => {
      const next = offloadPayload(dir, ref.file.replace(/\.txt$/, ""), text);
      ref.bytes = next.bytes;
      ref.lines = next.lines;
      ref.head = next.head;
      ref.tail = next.tail;
      ref.cut = next.cut;
      return { name: `plan:${ref.file}`, bytes: next.bytes };
    },
  };
}
