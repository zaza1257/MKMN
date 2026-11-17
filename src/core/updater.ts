import type { UpdateState } from "../shared/api";

/**
 * MKMN deliberately has no update transport, feed, installer download, or timer.
 * Keep the existing IPC contract so older renderer consumers fail explicitly.
 * A dedicated, signed MKMN release channel must be configured before enabling
 * any automatic updater. Never fall back to the upstream Open-NPU releases.
 */
export class Updater {
  private state: UpdateState = {
    status: "idle", version: null, percent: null,
    error: "Automatic updates are disabled. Install only a verified MKMN release.",
    checkedAt: null, installedAt: null
  };

  constructor(private readonly onState: (s: UpdateState) => void) {}
  get current(): UpdateState { return { ...this.state }; }
  get enabled(): boolean { return false; }
  start(): void {}
  stop(): void {}

  async check(): Promise<UpdateState> { return this.disabled(); }
  async force(): Promise<UpdateState> { return this.disabled(); }
  install(): void { this.disabled(); }

  private disabled(): UpdateState {
    this.state = { ...this.state, status: "error" };
    this.onState(this.current);
    return this.current;
  }
}
