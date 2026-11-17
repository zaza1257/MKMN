/**
 * The code checks of the prompt lab: the answer is code, it is run in an isolated context (no page, no process, a time limit) and
 * expressions are compared with what they must give. This is how a prompt that asks for a unit of a program is judged on whether the
 * code WORKS, not on how much it looks like the ideal.
 */
import type { Check, Ran } from "./promptLab";
import { isolation } from "./isolate";
import { likeFences } from "./construct/pipeline";

/** The same value written with its keys in order: `{a, b}` and `{b, a}` are the same answer. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as Record<string, unknown>)[k])])) : v);
const same = (a: unknown, b: unknown): boolean => { try { return JSON.stringify(canon(a)) === JSON.stringify(canon(b)) || (Number.isNaN(a) && Number.isNaN(b)); } catch { return false; } };
const show = (v: unknown): string => { try { const s = JSON.stringify(v); return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}...` : s; } catch { return String(v); } };

/** The code of an answer: the first fenced block when there is one, else the answer. */
export function codeOf(answer: string): string {
  const text = likeFences(answer);
  const m = /```[^\n]*\n([\s\S]*?)(?:\n```|$)/.exec(text);
  return (m ? m[1] : text).replace(/<think>[\s\S]*?(?:<\/think>|$)/g, "").trim();
}

/** For every `loads` and `run` check: `null` when it holds, else why not. Other checks are not in the map. */
export async function codeChecks(answer: string, checks: Check[]): Promise<Ran> {
  const iso = isolation();
  // a Map does not cross the process boundary as JSON: its entries do
  // (keyed by position, so the map holds the caller's own check objects)
  if (iso) return new Map(((await iso.run("codeChecks", [answer, checks])) as [number, string | null][]).map(([i, v]) => [checks[i], v]));
  return codeChecksHere(answer, checks);
}

/** codeChecks in this process. */
export async function codeChecksHere(answer: string, checks: Check[]): Promise<Ran> {
  const ran: Ran = new Map();
  const todo = checks.filter((c) => c.kind === "loads" || c.kind === "run");
  if (!todo.length) return ran;
  const { createContext, Script } = await import("node:vm");
  // every check gets a fresh context: a handler that changes the state must not change what the next check sees.
  // The sandbox is a NULL-PROTOTYPE object: an ordinary `{}` keeps the HOST Object.prototype in its chain, and
  // `this.constructor.constructor` is then the host's Function — the codeGeneration policy does not reach it, and
  // `this.constructor.constructor("return process")()` escapes this sandbox (verified on Node 26). With no
  // prototype there is nothing to climb: the lookups fall through to this context's own intrinsics, which the
  // policy covers. Do not treat Node VM as a security boundary regardless.
  const fresh = () => {
    const ctx = createContext(Object.create(null), { codeGeneration: { strings: false, wasm: false } });
    try {
      for (const g of checks) if (g.kind === "given") new Script(g.code).runInContext(ctx, { timeout: 1000 });
      // strict, as the page runs a unit: a `this` that is not there is an error here too
      new Script(`"use strict";\n${codeOf(answer)}`).runInContext(ctx, { timeout: 1000 });
      return { ctx, error: null as string | null };
    } catch (e) { return { ctx, error: `does not load: ${(e as Error).message.split("\n")[0]}` }; }
  };
  for (const c of todo) {
    const { ctx, error } = fresh();
    if (error) { ran.set(c, error); continue; }
    if (c.kind !== "run") { ran.set(c, null); continue; }
    try {
      const got = new Script(`(${c.call})`).runInContext(ctx, { timeout: 1000 });
      const want = new Script(`(${c.expect})`).runInContext(ctx, { timeout: 1000 });
      ran.set(c, same(got, want) ? null : `gave ${show(got)}`);
    } catch (e) { ran.set(c, `failed: ${(e as Error).message.split("\n")[0]}`); }
  }
  return ran;
}
