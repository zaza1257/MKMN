import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { execFile, execFileSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { runExamples, smokeRun } from "../src/core/construct/sandbox";
import { runCases } from "../src/core/benchChecks";
import { codeChecks } from "../src/core/labCode";
import { lockedNodeArgs, setIsolation } from "../src/core/isolate";
import { codeDirs, lockedNodeRunner } from "../src/sidecar/isolation";

/**
 * Code a model wrote was run with node:vm INSIDE the sidecar: Node says vm is not a
 * security boundary, and a context made from a host object is escaped by
 * `this.constructor.constructor("return process")()`. The sidecar now runs these checks
 * in a one-shot Node process with the permission model on (read the app's own code,
 * nothing else). This test escapes ON PURPOSE and shows what the escape reaches:
 * everything in place (as before), nothing in the locked-down process.
 */

const root = path.resolve(__dirname, "..");
const dist = path.join(root, "dist");
const worker = path.join(dist, "sidecar", "isolateWorker.js");

beforeAll(() => {
  // the worker runs as compiled JavaScript, the way the app ships it
  execFileSync(process.execPath, [path.join(root, "node_modules", "typescript", "bin", "tsc"), "-p", path.join(root, "tsconfig.sidecar.json")], { cwd: root, windowsHide: true, stdio: "ignore" });
  if (!existsSync(worker)) throw new Error("the sidecar did not build");
}, 180_000);

afterEach(() => setIsolation(null));

const outside = path.join(root, "package.json").replace(/\\/g, "\\\\"); // outside dist: not the app's runtime code
const ESCAPE = `(function () { var p = this.constructor.constructor("return process")(); var m = function (n) { return p.getBuiltinModule(n); }; var r = []; ` +
  `try { m("fs").readFileSync("${outside}", "utf8"); r.push("read"); } catch (e) { r.push("fs:" + (e.code || "error")); } ` +
  `try { m("child_process").execFileSync(p.execPath, ["--version"]); r.push("spawned"); } catch (e) { r.push("child:" + (e.code || "error")); } ` +
  `return r.join(","); })()`;

/** What the escape reported (the failure echoes the call, then `gave "..."`). */
const gave = (failures: string[]) => /gave "([^"]*)"/.exec(failures.join(" "))?.[1] ?? "";

describe("generated code runs in a locked-down process", () => {
  it("in place (the old way), an escape reads the person's files and starts programs", async () => {
    const r = await runExamples([], "function f() { return 1; }", [{ call: ESCAPE, expect: '"x"' }]);
    expect(gave(r.failures)).toMatch(/^read,spawned/);
  });

  it("in the locked-down process the same escape reads nothing, starts nothing and opens no connection", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    const r = await runExamples([], "function f() { return 1; }", [{ call: ESCAPE, expect: '"x"' }]);
    expect(gave(r.failures)).toBe("fs:ERR_ACCESS_DENIED,child:ERR_ACCESS_DENIED");
  }, 60_000);

  it("a process with the same locked flags cannot open a connection (it fails later, so it is tried apart)", async () => {
    const server = createServer((s) => { reached = true; s.destroy(); });
    let reached = false;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const code = `const s = require("net").connect(${port}, "127.0.0.1"); s.on("connect", () => { console.log("CONNECTED"); s.destroy(); }); s.on("error", (e) => console.log(e.code));`;
      const out = await new Promise<string>((resolve) => {
        execFile(process.execPath, [...lockedNodeArgs(codeDirs(path.join(dist, "sidecar")), "-e"), code], { windowsHide: true, timeout: 20_000 }, (_e, stdout) => resolve(String(stdout).trim()));
      });
      expect(out).toBe("ERR_ACCESS_DENIED");
      expect(reached).toBe(false);
    } finally { server.close(); }
  }, 60_000);

  it("the checks still work there: examples, a smoke run, the benchmark's cases and the lab's code checks", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    expect(await runExamples([], "function add(a, b) { return a + b; }", [{ call: "add(2, 3)", expect: "5" }])).toEqual({ ok: true, failures: [] });
    expect(await smokeRun({ kind: "fn", name: "double", code: "function double(n) { return n * 2; }", state: JSON.stringify({ n: 2 }), others: [], params: ["n"] } as never)).toEqual([]);
    expect(runCases("function sq(x) { return x * x; }", [["sq(3)", 9], ["sq(-2)", 4]])).toEqual({ passed: 2, total: 2, error: undefined });
    const checks = [{ kind: "run", expr: "inc(1)", want: "2" }] as never[];
    const ran = await codeChecks("```js\nfunction inc(n) { return n + 1; }\n```", checks);
    expect([...ran.keys()][0]).toBe(checks[0]); // keyed by the caller's own check
  }, 60_000);

  it("a loop that never ends is stopped and reported, not left running", async () => {
    setIsolation(lockedNodeRunner(process.execPath, worker, codeDirs(path.join(dist, "sidecar"))));
    const r = await runExamples([], "function spin() { while (true) {} }", [{ call: "spin()", expect: "1" }]);
    expect(r.ok).toBe(false);
  }, 60_000);
});
