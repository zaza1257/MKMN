import { nextState, type MachineState } from "../shared/stateMachines";

export type NpuEngine = "geniex" | "foundry";
type Owner = MachineState<"npuOwner">;

/**
 * The registered machine `npuOwner` (src/shared/stateMachines.json): which engine holds the NPU. Every start of a
 * model goes through `claim`, which ALWAYS releases the other engine first: a holder this process did not start
 * (a model the window started on the host) is released too. The owner moves only through free, never straight
 * from one engine to the other.
 */
export class NpuOwner {
  state: Owner = "free";
  private starting = false;

  constructor(
    private readonly release: Record<NpuEngine, () => Promise<void>>,
    private readonly onState?: (s: Owner) => void,
    private readonly onError: (message: string) => void = (m) => console.error(`[npu-owner] ${m}`),
  ) {}

  private move(event: string): void {
    const to = nextState("npuOwner", this.state, event);
    if (!to) { this.onError(`no move "${event}" from ${this.state}`); return; }
    if (to !== this.state) { this.state = to; this.onState?.(to); }
  }

  /** The NPU for `engine`: the other engine is released first, whatever this process believes. */
  async claim(engine: NpuEngine): Promise<void> {
    const other: NpuEngine = engine === "geniex" ? "foundry" : "geniex";
    try {
      await this.release[other]();
    } catch (e) {
      const message = `Releasing ${other} failed: ${(e as Error).message}`;
      this.onError(message);
      throw new Error(message, { cause: e });
    }
    if (this.state === other) this.move("release");
    if (this.state === "free") this.move(engine === "geniex" ? "geniex_start" : "foundry_start");
  }

  /** Hold admission through the release and the native start or benchmark. */
  async run<T>(engine: NpuEngine, start: () => Promise<T>): Promise<T> {
    if (this.starting) throw new Error("Another model is starting or a benchmark is running. Wait for it to finish, then retry.");
    this.starting = true;
    try {
      await this.claim(engine);
      return await start();
    } finally {
      this.starting = false;
    }
  }

  /** An engine that stopped by itself (its model unloaded, its server stopped) frees the NPU if it held it. */
  released(engine: NpuEngine): void {
    if (this.state === engine) this.move("release");
  }
}
