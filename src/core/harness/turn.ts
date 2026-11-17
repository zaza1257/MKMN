/**
 * The per-turn budget: ONE cap on ALL model calls a user-visible turn makes,
 * summed across every run it spawns — the main answer, the fold, the reviewer,
 * the locator, the sub-agents, the build sub-runs . Without it a runaway turn (a mend loop, a
 * sub-agent loop) could spend the NPU budget call by call.
 *
 * The account is found the same way the journal scope is (current.ts): every
 * call inside the turn carries an id whose first segment is the turn's id
 * (`<turnId>`, `<turnId>:agent:2`, `<turnId>:know`), so the innermost open
 * account of that scope is charged — and consulted BEFORE anything is sent.
 *
 * Two measured exclusions, logged in the decision log:
 *  - The router's tiny calls (id `router:...`, a 0.6B model on the CPU) are
 *    not the NPU budget the cap protects; they stay outside the account.
 *  - A background compaction that keeps running after the turn closed its
 *    account is uncounted; it is stopped at the next turn's start
 *    (stopBackgroundCompactions), and its purpose is the next turn's request.
 */
import type { GatewayLimits } from "./gateway";

/** The default per-turn cap. Measured headroom (the s6 journals, 1625 runs over
 * the 4b and 8b scratch workspaces): per RUN the largest legit count was 44
 * model calls / 9.4k output tokens (a build sub-run); a full turn with its
 * sub-runs stayed under ~70 calls / ~30k output tokens. 120 calls and 100k
 * tokens give ≥1.4× headroom over the largest legit turn and still stop a
 * runaway loop. A constant, not a setting row yet: the Settings row comes with
 * the UI work, and the cap protects without being tuned. */
import { turnBudget } from "./policy";

/** The default per-turn cap: the policy layer owns the rule
 * (src/core/harness/policy.ts) — this re-export is the pinned measured value. */
export const TURN_BUDGET: GatewayLimits = turnBudget();

export interface TurnBudget {
  calls: number;
  outputTokens: number;
  limits: GatewayLimits;
}

const turns = new Map<string, TurnBudget>();

/** Open the turn's account: every model call of this turn (by id prefix) is counted against it. The cap is the policy's, consulted at open (a Settings row will tune it per turn). */
export function openTurnBudget(turnId: string, limits: GatewayLimits = turnBudget()): void {
  turns.set(turnId, { calls: 0, outputTokens: 0, limits });
}

/** Close the turn's account: calls after this (a background compaction) find nothing. */
export function closeTurnBudget(turnId: string): void {
  turns.delete(turnId);
}

/** The account a call belongs to: the call's id is `<turnId>`, `<turnId>:agent:2`, … */
export function turnBudgetOf(callId: string | undefined): TurnBudget | undefined {
  if (!callId) return undefined;
  return turns.get(callId) ?? turns.get(callId.split(":")[0]);
}

/** Consulted before a call is sent. Returns the kind crossed, or null when the call may go
 * (the call is counted here — a refusal throws in the gateway, which owns the error). */
export function chargeTurnPrepare(b: TurnBudget): "calls" | "tokens" | null {
  if (b.limits.maxCalls !== undefined && b.calls >= b.limits.maxCalls) return "calls";
  if (b.limits.maxOutputTokens !== undefined && b.outputTokens >= b.limits.maxOutputTokens) return "tokens";
  b.calls++;
  return null;
}

/** Charged after a call is delivered: what it actually spent. */
export function chargeTurnUsage(b: TurnBudget, outputTokens: number): void {
  b.outputTokens += outputTokens;
}
