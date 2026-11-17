import { describe, expect, it } from "vitest";
import { cuesOf, findTheme, generateTheme, themeFromId, THEME_COUNT } from "../src/core/themeGen";
import { themeOf, THEMES } from "../src/core/slides";

describe("themes found from words", () => {
  it("reads a mood, a colour and a kind of subject", () => {
    expect(cuesOf("a somewhat old theme").style).toBe("retro");
    expect(cuesOf("make the theme technology").style).toBe("tech");
    expect(cuesOf("a class presentation theme to earn points").style).toBe("class");
    expect(cuesOf("an elegant wedding deck").style).toBe("elegant");
    expect(cuesOf("elegant").style).toBe("elegant");
    expect(cuesOf("dark with violet")).toMatchObject({ mood: "dark", hue: 270 });
    expect(cuesOf("write about volcanoes").score).toBe(0);
  });
  it("composes a complete theme with readable text", () => {
    const old = findTheme("a somewhat old theme")!;
    expect(old.titleFont).toBe("Georgia");
    expect(old.cover).toBe("frame");
    const tech = findTheme("technology")!;
    expect(tech.dark).toBe(true);
    expect(findTheme("nothing special here")).toBeNull();
    for (const m of ["light", "dark", "pastel", "vivid", "earthy", "mono"] as const) {
      const t = generateTheme(123, m, "corporate");
      expect(t.bg).toMatch(/^[0-9A-F]{6}$/);
      expect(t.accents).toHaveLength(4);
      expect(t.dark).toBe(m === "dark");
    }
  });
  it("a theme line takes a listed theme, a made one's id, or plain words, with changes after a bar", () => {
    expect(themeOf("Theme: sunrise\n\n---\n# a").id).toBe("sunrise");
    expect(themeOf("Theme: gen:200-dark-tech\n\n---\n# a").dark).toBe(true);
    expect(themeOf("Theme: old\n\n---\n# a").titleFont).toBe("Georgia");
    expect(themeOf("Theme: ocean | accent=7C3AED cover=frame deco=band\n\n---\n# a")).toMatchObject({ accent: "7C3AED", cover: "frame", deco: "band" });
    expect(themeOf("Theme: whatever\n\n---\n# a").id).toBe(THEMES[0].id);
    expect(themeFromId("gen:10-mono-minimal")?.name).toMatch(/mono minimal/);
    expect(THEME_COUNT).toBeGreaterThan(800);
  });
});
