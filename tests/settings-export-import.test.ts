// Pins for the 2.10 settings export/import and the Changed machinery: the one
// authority is the schema (settingsSchema.ts) — changedKeys never invents, the
// export rolls leaf changes up to whole stored objects, the import validates
// every key against the schema and refuses what it cannot vouch for, and a leaf
// patch merges into the stored parent so a pair's other half survives.
import { describe, expect, it } from "vitest";
import {
  changedKeys, exportSettings, importSettings, leafValuePatch,
  SETTING_GROUPS, SETTINGS_SCHEMA, SETTINGS_SCHEMA_GENERATION,
  settingDecl, valueProblem, voiceSettings,
} from "../src/shared/settingsSchema";
import { PRIMARY_TABS, redirectTab, tabLabel, type SettingsTab } from "../src/renderer/settingsSearch";

const s = (over: Record<string, unknown>) => over as any;

describe("changedKeys — the one Changed authority", () => {
  it("is empty when everything reads as its default (including a stored null parent)", () => {
    expect(changedKeys(undefined)).toEqual([]);
    expect(changedKeys(null)).toEqual([]);
    expect(changedKeys(s({ turnBudget: null }))).toEqual([]); // null parent = the default
  });

  it("names the LEAF that changed, never the parent beside it", () => {
    expect(changedKeys(s({ turnBudget: { maxCalls: 60 } }))).toEqual(["turnBudget.maxCalls"]);
    expect(changedKeys(s({ speculativeDecoding: { enabled: true } }))).toEqual(["speculativeDecoding.enabled"]);
    expect(changedKeys(s({ humainMode: "fuse" }))).toEqual(["humainMode"]);
  });

  it("counts a key changed only when the value truly differs (deep equality)", () => {
    expect(changedKeys(s({ turnBudget: { maxCalls: 120 } }))).toEqual([]); // leaf set to its default
    expect(changedKeys(s({ dynamic: { table: {} } }))).toEqual([]); // object equal to default
  });

  it("never lists a parent that other keys nest under", () => {
    const changed = changedKeys(s({ turnBudget: { maxCalls: 60, maxOutputTokens: 500 } }));
    expect(changed).toEqual(["turnBudget.maxCalls", "turnBudget.maxOutputTokens"]);
  });
});

describe("exportSettings — the person's non-default settings", () => {
  it("records the schema generation", () => {
    expect(exportSettings(undefined).generation).toBe(SETTINGS_SCHEMA_GENERATION);
  });

  it("exports nothing for default-only settings", () => {
    expect(exportSettings(undefined).values).toEqual({});
  });

  it("rolls a changed leaf up to its WHOLE stored object", () => {
    const doc = exportSettings(s({ turnBudget: { maxCalls: 60, maxOutputTokens: 500 } }));
    expect(doc.values).toEqual({ turnBudget: { maxCalls: 60, maxOutputTokens: 500 } });
  });

  it("exports the voice head as the full voice object (defaults filled in)", () => {
    const doc = exportSettings(s({ voice: { autoSend: false } }));
    const v = doc.values.voice as Record<string, unknown>;
    expect(v.autoSend).toBe(false);
    expect(v).toEqual(voiceSettings(s({ voice: { autoSend: false } })));
    // every schema voice leaf is present, so an import writes a whole block
    for (const d of SETTINGS_SCHEMA.filter((x) => x.key.startsWith("voice."))) {
      expect(v).toHaveProperty(d.key.slice("voice.".length));
    }
  });
});

describe("importSettings — every key checked, undeclared refused", () => {
  it("round-trips its own export", () => {
    const doc = exportSettings(s({
      humainFuseModel: "sk-abc", turnBudget: { maxCalls: 60 }, voice: { autoSend: false },
    }));
    const r = importSettings(doc);
    expect(r.refusals).toEqual([]);
    expect(r.rest.humainFuseModel).toBe("sk-abc");
    expect(r.rest.turnBudget).toEqual({ maxCalls: 60 });
    expect(r.voice.autoSend).toBe(false);
    expect(r.generation).toBe(SETTINGS_SCHEMA_GENERATION);
  });

  it("splits the voice block from the top-level values", () => {
    const r = importSettings({ values: { humainFuseModel: "k", voice: { autoSend: false } } });
    expect(r.rest).toEqual({ humainFuseModel: "k" });
    expect(r.voice).toEqual({ autoSend: false });
  });

  it("refuses a key the schema does not declare, and writes the others", () => {
    const r = importSettings({ values: { turboMode: true, humainFuseModel: "k" } });
    expect(r.refusals).toEqual([{ key: "turboMode", reason: expect.stringContaining("does not declare") }]);
    expect(r.rest).toEqual({ humainFuseModel: "k" });
  });

  it("refuses a wrong-typed value, naming the key", () => {
    const r = importSettings({ values: { humainFuseModel: 5 } });
    expect(r.refusals).toEqual([{ key: "humainFuseModel", reason: expect.stringContaining("expected text") }]);
    expect(r.rest).toEqual({});
  });

  it("refuses an out-of-range number, naming the key", () => {
    const r = importSettings({ values: { "turnBudget.maxCalls": 0 } });
    expect(r.refusals).toEqual([{ key: "turnBudget.maxCalls", reason: expect.stringContaining("minimum") }]);
    expect(r.rest).toEqual({});
  });

  it("accepts null for a key whose default is null (what its Default button saves)", () => {
    const r = importSettings({ values: { turnBudget: null } });
    expect(r.refusals).toEqual([]);
  });

  it("refuses a newer schema generation whole", () => {
    const r = importSettings({ generation: SETTINGS_SCHEMA_GENERATION + 1, values: { humainFuseModel: "k" } });
    expect(r.refusals).toEqual([{ key: "", reason: expect.stringContaining("newer version") }]);
    expect(r.rest).toEqual({});
    expect(r.generation).toBe(SETTINGS_SCHEMA_GENERATION + 1);
  });

  it("accepts an older or absent generation", () => {
    expect(importSettings({ generation: 1, values: {} }).refusals).toEqual([]);
    expect(importSettings({ values: {} }).refusals).toEqual([]);
    expect(importSettings({}).refusals).toEqual([]); // a bare object is accepted
  });

  it("refuses a file that is not a settings object", () => {
    for (const bad of [null, "hello", 42, [1, 2]]) {
      const r = importSettings(bad);
      expect(r.refusals).toEqual([{ key: "", reason: expect.stringContaining("JSON object") }]);
    }
  });

  it("refuses a values that is not an object", () => {
    const r = importSettings({ generation: 1, values: [1] });
    expect(r.refusals).toEqual([{ key: "", reason: expect.stringContaining("values object") }]);
  });

  it("refuses an undeclared voice leaf", () => {
    const r = importSettings({ values: { voice: { sttModelId: null, turbo: true } } });
    expect(r.refusals).toEqual([{ key: "voice.turbo", reason: expect.stringContaining("does not declare") }]);
    expect(r.voice).toEqual({ sttModelId: null });
  });
});

describe("leafValuePatch — the write-back through the settings save path", () => {
  it("merges a leaf into its parent's STORED object, keeping the other half", () => {
    const patch = leafValuePatch(s({ turnBudget: { maxCalls: 12, maxOutputTokens: 500 } }), { "turnBudget.maxCalls": 60 });
    expect(patch).toEqual({ turnBudget: { maxCalls: 60, maxOutputTokens: 500 } });
  });

  it("starts a fresh parent when none is stored", () => {
    expect(leafValuePatch(undefined, { "speculativeDecoding.enabled": true }))
      .toEqual({ speculativeDecoding: { enabled: true } });
  });

  it("never carries the voice block (it merges through the voice save path)", () => {
    expect(leafValuePatch(undefined, { voice: { allowInterrupt: false }, "voice.autoSend": false, humainFuseModel: "k" }))
      .toEqual({ humainFuseModel: "k" });
  });

  it("passes a top-level key as it is", () => {
    expect(leafValuePatch(undefined, { humainFuseModel: "k" })).toEqual({ humainFuseModel: "k" });
  });
});

describe("the schema generation constant is honest", () => {
  it("is 1 for the 2.10 schema", () => {
    expect(SETTINGS_SCHEMA_GENERATION).toBe(1);
  });

  it("every declared key resolves, and object parents are declared once", () => {
    const keys = SETTINGS_SCHEMA.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(settingDecl(k)?.key).toBe(k);
  });
});

describe("the navigation is the schema's group list", () => {
  it("PRIMARY_TABS shows the groups in the schema's fixed order, with the same labels", () => {
    expect(PRIMARY_TABS.map((t) => ({ id: t.id, label: t.label }))).toEqual(SETTING_GROUPS.map((g) => ({ id: g.id, label: g.label })));
  });

  it("tabLabel speaks the schema's label for every group", () => {
    for (const g of SETTING_GROUPS) expect(tabLabel(g.id as SettingsTab)).toBe(g.label);
  });

  it("every schema key's group is one of the seven navigation groups", () => {
    const ids = new Set(SETTING_GROUPS.map((g) => g.id));
    for (const d of SETTINGS_SCHEMA) expect(ids.has(d.group), `${d.key} names group ${d.group}`).toBe(true);
  });
});

describe("the pre-2.10 deep links keep working", () => {
  it("every legacy tab id lands on the group that inherited its controls", () => {
    expect(redirectTab("build")).toBe("files");
    expect(redirectTab("search")).toBe("web");
    expect(redirectTab("about")).toBe("about");
    expect(redirectTab("adv-system")).toBe("developer");
    expect(redirectTab("adv-runtime")).toBe("developer");
    expect(redirectTab("adv-routing")).toBe("developer");
    expect(redirectTab("adv-diag")).toBe("developer");
  });

  it("a group id passes through, and an unknown id lands on General", () => {
    expect(redirectTab("voice")).toBe("voice");
    expect(redirectTab("developer")).toBe("developer");
    expect(redirectTab("no-such-tab")).toBe("general");
    expect(redirectTab(null)).toBe("general");
    expect(redirectTab(undefined)).toBe("general");
  });

  it("covers every id the valueProblem language and schema can produce (no blank-page link)", () => {
    // every schema search entry's tab must be a reachable group
    for (const d of SETTINGS_SCHEMA) expect(redirectTab(d.group)).toBe(d.group);
  });

  it("valueProblem agrees with the schema for a parent and its leaf", () => {
    expect(valueProblem(settingDecl("turnBudget")!, { maxCalls: 1 })).toBeNull();
    expect(valueProblem(settingDecl("turnBudget")!, null)).toBeNull(); // its default
    expect(valueProblem(settingDecl("turnBudget")!, 5)).not.toBeNull();
    expect(valueProblem(settingDecl("turnBudget.maxCalls")!, 60)).toBeNull();
  });
});
