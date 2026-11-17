/**
 * Which run a model call journals into. Pipelines nest: a program build runs
 * inside a chat turn, and while it runs, its calls belong to the build's run,
 * not the turn's. A scope (the turn's id) holds a stack of open runs; the
 * innermost open one is where the next call is journaled.
 *
 * The registry holds no state of its own beyond the stack: each run still owns
 * its journal, its steps and its settle.
 */
import type { LiveRun } from "./run";

const stacks = new Map<string, LiveRun[]>();

/** Open a run for a scope: the model calls made while it is open journal into it. */
export function openRunScope(scope: string, run: LiveRun): void {
  const stack = stacks.get(scope) ?? [];
  stacks.set(scope, [...stack, run]);
}

/** Close a run's scope. The run below it (the turn's own) becomes the journal target again. */
export function closeRunScope(scope: string, run: LiveRun): void {
  const stack = stacks.get(scope);
  if (!stack) return;
  const i = stack.lastIndexOf(run);
  if (i >= 0) {
    stack.splice(i, 1);
    if (stack.length === 0) stacks.delete(scope);
  }
}

/** The run a call belongs to: the call's id is its scope's id (`<turnId>` or `<turnId>:plan`), and the innermost open run of that scope wins. A call from outside every scope finds no run. */
export function currentRun(callId: string): LiveRun | undefined {
  const scope = callId.split(":")[0];
  return (stacks.get(callId) ?? stacks.get(scope))?.at(-1);
}
