import { describe, expect, it } from "vitest";
import { codeChecks } from "../src/core/labCode";
import type { Check } from "../src/core/promptLab";

describe("labCode sandbox escape", () => {
  it("the host process is not reachable from an answer", async () => {
    const escape = [
      "const escapeHatch = this.constructor.constructor;",
      "try { escapeHatch('return process.version')(); } catch (e) {}",
      "try { (function(){ return this.constructor.constructor('return process.platform')(); })(); } catch (e) {}",
      "try { globalThis.constructor.constructor('return require')()('fs'); } catch (e) {}",
      "function probe() { return typeof process; }",
    ].join("\n");
    const checks: Check[] = [
      { kind: "loads", code: escape } as Check,
      { kind: "run", code: "", call: "probe()", expect: "'undefined'" } as Check,
    ];
    const ran = await codeChecks(escape, checks);
    for (const [c, err] of ran) expect(err, JSON.stringify(c)).toBeNull();
  });
});
