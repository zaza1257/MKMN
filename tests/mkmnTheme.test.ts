import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { normalizeAppearance, applyAppearance, subscribeToSystemAppearance } from "../src/renderer/theme";

afterEach(() => vi.unstubAllGlobals());

describe("MKMN appearance", () => {
  it("normalizes corrupt or missing preferences safely", () => {
    for (const value of [null, undefined, {}, "invalid"]) expect(normalizeAppearance(value)).toBe("system");
    for (const value of ["light", "dark", "system"]) expect(normalizeAppearance(value)).toBe(value);
  });

  it("explicit light and dark override the OS, with local persistence", () => {
    const dataset: Record<string, string> = {};
    const style: Record<string, string> = {};
    const saved = new Map<string, string>();
    vi.stubGlobal("document", { documentElement: { dataset, style } });
    vi.stubGlobal("localStorage", { setItem: (k: string, v: string) => saved.set(k, v) });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    applyAppearance("light");
    expect(dataset.theme).toBe("light");
    expect(style.colorScheme).toBe("light");
    expect(saved.get("mkmn.appearance")).toBe("light");
    applyAppearance("dark");
    expect(dataset.theme).toBe("dark");
    applyAppearance("system");
    expect(dataset.theme).toBe("dark");
  });

  it("subscribes to OS changes and cleans up its listener", () => {
    const add = vi.fn(), remove = vi.fn(), cb = vi.fn();
    vi.stubGlobal("window", { matchMedia: () => ({ addEventListener: add, removeEventListener: remove }) });
    const off = subscribeToSystemAppearance(cb);
    expect(add.mock.calls[0][0]).toBe("change");
    add.mock.calls[0][1]();
    expect(cb).toHaveBeenCalledOnce();
    off();
    expect(remove).toHaveBeenCalledWith("change", add.mock.calls[0][1]);
  });

  it("pre-paint bootstrap handles saved modes, OS preference and blocked storage", () => {
    const source = readFileSync(resolve(__dirname, "../src/renderer/public/mkmn-theme.js"), "utf8");
    for (const [saved, osDark, expected] of [
      ["dark", false, "dark"], ["light", true, "light"],
      ["system", true, "dark"], ["system", false, "light"], ["broken", false, "light"]
    ] as const) {
      const element = { dataset: {} as Record<string, string>, style: {} as Record<string, string> };
      runInNewContext(source, {
        localStorage: { getItem: () => saved },
        matchMedia: () => ({ matches: osDark }), document: { documentElement: element }
      });
      expect(element.dataset.theme).toBe(expected);
    }
    const element = { dataset: {} as Record<string, string>, style: {} };
    runInNewContext(source, {
      localStorage: { getItem: () => { throw new Error("storage blocked"); } },
      matchMedia: () => ({ matches: true }), document: { documentElement: element }
    });
    expect(element.dataset.theme).toBe("dark");
  });

  it("main text, muted text, success and primary button pairs meet AA contrast", () => {
    const css = readFileSync(resolve(__dirname, "../src/renderer/styles.css"), "utf8");
    const luminance = (hex: string) => {
      const h = hex.length === 4 ? "#" + [...hex.slice(1)].map((c) => c + c).join("") : hex;
      const values = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255)
        .map((n) => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
      return .2126 * values[0] + .7152 * values[1] + .0722 * values[2];
    };
    const blocks = [css.slice(0, css.indexOf('[data-theme="dark"]')), css.slice(css.indexOf('[data-theme="dark"]'), css.indexOf('* {'))];
    for (const block of blocks) {
      const tokens = Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[\da-f]+)/gi)].map((m) => [m[1], m[2]]));
      for (const [fg, bg] of [["text", "bg"], ["text", "surface"], ["muted", "bg"], ["green", "surface"], ["on-accent", "accent"]]) {
        const a = luminance(tokens[fg]), b = luminance(tokens[bg]);
        expect((Math.max(a, b) + .05) / (Math.min(a, b) + .05), `${fg}/${bg}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
