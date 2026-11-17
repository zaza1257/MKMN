/**
 * Whether the NPU is in use by something the person started, so background work on it (the load test of a
 * model the app does not know) waits. A Computer Use run counts: it waits for its model like a chat does.
 */
export function npuInUse(o: { chats: number; benchRunning: boolean; npuTestRunning: boolean; leaseBusy: boolean; agentRuns: number }): boolean {
  return o.chats > 0 || o.benchRunning || o.npuTestRunning || o.leaseBusy || o.agentRuns > 0;
}
