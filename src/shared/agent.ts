/*
 * The shared wire shapes of Computer Use v1, mirrored from the Rust contract in
 * `src-tauri/src/agent_wire.rs` (the driver's own types). The sidecar's loop,
 * the renderer's AgentPanel and the tests all read these; the host's driver
 * replies deserialize into them, so a field the driver stops sending is a
 * type error here, not a silent undefined.
 */

/** One top-level window the driver's list offered. The person picks from these. */
export type DriverWindow = {
  hwnd: number;
  pid: number;
  title: string;
  process: string;
  className: string;
};

/** One accessibility node of an observe snapshot. */
export type NodeInfo = {
  /** Window-scoped, single-observe reference: `e<observeGen>.<index>`. */
  ref: string;
  role: string;
  name?: string;
  value?: string;
  className?: string;
  enabled: boolean;
  offscreen: boolean;
  /** x, y, width, height in screen pixels. The driver omits the field when it
   * has no rectangle (an empty vec is skipped on the wire). */
  rect?: number[];
  /** The action kinds this element accepts (the closed action set). The driver
   * omits the field entirely when the element accepts nothing. */
  patterns?: string[];
  /** The element's visible state where the tree shows one: on/off/indeterminate, expanded/collapsed, selected/unselected. Absent otherwise. */
  state?: string;
};

/** One window's accessibility tree summary: the fresh snapshot `observe` returns. */
export type ObserveResult = {
  window: DriverWindow;
  /** Bumped on every observe of the window session; every earlier ref is stale. */
  observeGen: number;
  focused: boolean;
  nodes: NodeInfo[];
  truncated: boolean;
};

/**
 * One action. The closed v1 set — the pattern the driver uses is part of the
 * contract, and there is no keyboard or coordinate kind anywhere in it.
 * "Prepare an unsent draft" is guaranteed by this union: nothing in it can
 * press Enter anywhere.
 */
export type AgentAction =
  | { kind: "click"; ref: string }
  | { kind: "setValue"; ref: string; text: string }
  | { kind: "toggle"; ref: string }
  | { kind: "select"; ref: string; value: string }
  | { kind: "expand"; ref: string }
  | { kind: "collapse"; ref: string };

/** The action kinds the schema accepts, for validation and error lines. */
export const AGENT_ACTION_KINDS = ["click", "setValue", "toggle", "select", "expand", "collapse"] as const;

/**
 * How a driver act answered: the happy shapes per kind, or a short code the
 * loop reacts to (`staleRef` re-observes, `windowGone` fails the run).
 */
export type ActResult = {
  ok?: boolean;
  invoked?: boolean;
  set?: boolean;
  toggled?: boolean;
  selected?: string;
  expanded?: boolean;
  collapsed?: boolean;
  code?: string;
  message?: string;
};

/** The verdicts of the `agentRun` machine (src/shared/stateMachines.json). */
export type AgentRunStatus = "running" | "done" | "unresolved" | "failed" | "cancelled";

/** The window grant the host records for one run (its own shape, returned by begin). */
export type AgentGrant = {
  hwnd: number;
  pid: number;
  title: string;
  process: string;
};

/** The supporting step labels the events carry (not a machine). */
export type AgentStepPhase = "observe" | "propose" | "review" | "act" | "verify" | "settled";

/**
 * The review gate of Edit a copy, shown BEFORE anything is written: the exact
 * proposed text changes, and the file the edited copy will be saved as. The
 * person answers with Save edited copy (true) or Cancel (false).
 */
export type DocEditReview = {
  ops: { find: string; replace: string }[];
  summary: string;
  /** The file being edited a copy of (name only for display). */
  sourceName: string;
  /** The destination file name the edited copy will get. */
  destination: string;
};

/**
 * One streamed progress event of a run. The panel renders `line` verbatim and
 * uses the rest to show state, the step counter and the executed actions.
 */
export type AgentRunEvent = {
  runId: string;
  status: AgentRunStatus;
  /** One-based step counter; stays at the last step after settling. */
  step: number;
  phase: AgentStepPhase;
  /** A human line for Chat's progress list. */
  line: string;
  /** Set with the terminal events: why the run settled the way it did. */
  reason?: string;
  /** The summary when the model declared the task done. */
  summary?: string;
  /** The review gate (phase "review"): the exact proposed change, awaiting approval. */
  review?: DocEditReview;
  /** The edited copy's path, set when the run finished done. */
  copyPath?: string;
  /** Every action executed so far, with how its verification went. */
  actions: { action: AgentAction; verified: boolean | null; at: number }[];
  at: number;
};
