/**
 * The app's runtime policy: the rules the gateway and settle() consult, in one
 * place. The gateway consults it at CALL time — the turn's
 * budget account is opened with the policy's cap, and the refusal that follows
 * (GatewayTurnLimitError) is the policy enforced before anything is sent.
 * settle() consults it at VERDICT time — a run the policy stopped (the turn's
 * budget refused a further call) did not finish its course, and must not end
 * `done` or read as the person's cancel: it settles unresolved with the cause
 * named.
 *
 * Everything here has a real consumer; a rule without one does not belong in
 * this file (the gateway's per-run limits sat unwired for two releases — the
 * lesson that drove this layer's shape). The trajectory is written down, not
 * invented: the UI work adds the Settings row that WRITES a tuned cap
 * here, and the headless exec reads the same rules when it runs the
 * orchestrator without a window.
 */

/** The per-turn cap on model calls and output tokens, summed across every run
 * the turn spawns. Measured, not guessed: the s6 scratch workspaces keep 1,625
 * run journals with model-call steps — per RUN the largest legitimate count was
 * 44 model calls / 9.4k output tokens (a build sub-run); a full user-visible
 * turn with its sub-runs stayed under ~70 calls / ~30k output tokens. These
 * values give ≥1.4× headroom over the largest legitimate turn measured and
 * still stop a runaway loop (a mend cycle, a sub-agent loop) before it can eat
 * the NPU budget call by call. */
export interface TurnBudget {
  maxCalls: number;
  maxOutputTokens: number;
}

import { settingDefault } from "../../shared/settingsSchema";

export const DEFAULT_TURN_BUDGET: TurnBudget = {
  maxCalls: settingDefault("turnBudget.maxCalls"),
  maxOutputTokens: settingDefault("turnBudget.maxOutputTokens"),
};

/** The turn budget in force: a fresh copy each call, so a caller that holds one
 * cannot mutate the rule for everyone else. The Settings row will
 * read its saved value here; until then the measured default is the policy. */
export function turnBudget(): TurnBudget {
  return { ...DEFAULT_TURN_BUDGET };
}

/**
 * The turn budget for one turn (the Settings row): the saved,
 * tuned cap when it is two positive numbers, the measured default otherwise —
 * unset, or a value that would disable or break the guard (0, negative,
 * non-finite, not a number). The row tunes the cap; it can never turn the
 * budget off.
 */
export function turnBudgetOfSettings(s: { turnBudget?: { maxCalls?: unknown; maxOutputTokens?: unknown } | null } | null | undefined): TurnBudget {
  const b = s?.turnBudget;
  const calls = b?.maxCalls;
  const tokens = b?.maxOutputTokens;
  if (typeof calls === "number" && Number.isFinite(calls) && calls > 0
    && typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
    return { maxCalls: Math.floor(calls), maxOutputTokens: Math.floor(tokens) };
  }
  return turnBudget();
}
