import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/**
 * The app speaks English and Arabic only (decided in an earlier build). The closed JSON schemas the
 * model fills must offer exactly those two languages, and no other language code may
 * appear as a choice in a template.
 */

const FILES = ["src/core/templates/excel.ts", "src/core/templates/site.ts", "src/core/templates/multipage.ts", "src/core/page/catalog.ts", "src/core/templates/freefile.ts"];
const root = path.resolve(import.meta.dirname ?? ".", "..");

describe("template schemas offer English and Arabic only", () => {
  for (const f of FILES) {
    it(f, () => {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      for (const m of src.matchAll(/language:\s*\{[^}]*enum:\s*\[([^\]]*)\]/g)) expect(m[1].replace(/\s/g, "")).toBe('"en","ar"');
      expect(src).not.toMatch(/["'](fr|es|de|pt|it)["']/);
    });
  }
});
