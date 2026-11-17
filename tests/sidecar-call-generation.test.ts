import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A sidecar request is bound to the process it is sent to. The host read the
 * generation, registered the call and sent it in three separate steps; a restart
 * in between could tag a request with the old generation while it went to the new
 * process (or the reverse), so an exit of one process failed — or missed — the
 * other's calls. All three now happen under the process lock, the same lock the
 * spawn holds while it publishes a new generation.
 *
 * A Rust unit test would need a live AppHandle and a child process; this pins the
 * structure of `call` instead (stated limitation).
 */

const rs = readFileSync("src-tauri/src/sidecar.rs", "utf8");
const callStart = rs.indexOf("self.ensure_spawned().await?;\n", rs.indexOf("pub async fn call")) >= 0
  ? rs.indexOf("self.ensure_spawned().await?;", rs.indexOf("pub async fn call"))
  : rs.indexOf("self.ensure_spawned().await?;");
const body = rs.slice(callStart, rs.indexOf("match tokio::time::timeout(CALL_TIMEOUT, rx)", callStart));

describe("a sidecar call is bound to the process it is sent to", () => {
  it("reads the generation, registers and sends while holding the process lock", () => {
    const lock = body.indexOf("self.process.lock().await");
    const gen = body.indexOf("self.generation.load(");
    const insert = body.indexOf("self.pending.lock().await.insert(");
    const send = body.indexOf("p.stdin.try_send(");
    expect(lock).toBeGreaterThan(-1);
    expect(gen).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(lock);
    expect(send).toBeGreaterThan(insert);
  });
});
