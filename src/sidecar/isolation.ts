// The sidecar's runner for code a model wrote: every call is a fresh Node process with the
// permission model on (see src/core/isolate.ts). The process gets only what Node needs to
// start on Windows in its environment, never the sidecar's own variables.

import { spawn, spawnSync } from "child_process";
import * as path from "path";
import { lockedNodeArgs, readReply, type IsolatedOp, type IsolationRunner } from "../core/isolate";

/** Long enough for a page played 200 ticks with its scenes; a runaway loop dies with its process. */
const LIMIT_MS = 60_000;

function bareEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ["SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP"]) if (process.env[k]) env[k] = process.env[k];
  return env;
}

/** The app's compiled code (dist, or Runtime once installed) and the packages beside it: the
 *  only folders the locked-down process may read. Installed, node_modules sits inside Runtime;
 *  in a checkout it sits beside dist. */
export function codeDirs(sidecarDir: string): string[] {
  const code = path.resolve(sidecarDir, "..");
  return [code, path.join(code, "node_modules"), path.resolve(code, "..", "node_modules")];
}

export function lockedNodeRunner(nodeExe = process.execPath, worker = path.join(__dirname, "isolateWorker.js"), readDirs = codeDirs(__dirname)): IsolationRunner {
  const args = lockedNodeArgs(readDirs, worker);
  return {
    run(op: IsolatedOp, a: unknown[]): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const child = spawn(nodeExe, args, { windowsHide: true, env: bareEnv(), stdio: ["pipe", "pipe", "pipe"] });
        let out = "", err = "";
        const timer = setTimeout(() => { child.kill(); }, LIMIT_MS);
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("error", (e) => { clearTimeout(timer); reject(e); });
        child.on("close", (code) => {
          clearTimeout(timer);
          try { resolve(readReply(out, err, code)); } catch (e) { reject(e); }
        });
        child.stdin.end(JSON.stringify({ op, args: a }));
      });
    },
    runSync(op: IsolatedOp, a: unknown[]): unknown {
      const r = spawnSync(nodeExe, args, { windowsHide: true, env: bareEnv(), input: JSON.stringify({ op, args: a }), encoding: "utf8", timeout: LIMIT_MS, maxBuffer: 16 << 20 });
      if (r.error) throw r.error;
      return readReply(r.stdout ?? "", r.stderr ?? "", r.status);
    },
  };
}
