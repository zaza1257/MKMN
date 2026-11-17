import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { taskProjectView } from "../src/core/taskKnowledge";
import { openKnowledgeIndex } from "../src/core/knowledge/store";

/**
 * A scheduled run of a large project read whatever came first in its packed,
 * cut-off files. It now gets the sections that match the task's prompt, the way a
 * chat's search does; small knowledge still rides whole.
 */

const filler = (n: number) => "The canteen menu lists soups and salads for the week. ".repeat(n);
const project = (files: Array<{ id: string; name: string; content: string }>) =>
  ({ id: "p1", name: "Ops", description: "", instructions: "", files, created: 1, updated: 1 }) as any;
const open = (p: any) => openKnowledgeIndex(null, p.id, p.files);

describe("a scheduled run's project knowledge", () => {
  it("rides whole when it fits", () => {
    const p = project([{ id: "f1", name: "a.txt", content: "short note" }]);
    expect(taskProjectView(p, 5000, "anything", open)).toBe(p);
  });

  it("over budget, sends the sections that match the task, not the first bytes", () => {
    const p = project([
      { id: "f1", name: "menu.txt", content: filler(400) },
      { id: "f2", name: "fire.txt", content: "# Fire drill\nThe fire drill is on Thursday at 10:00 in the east wing. Assemble in the car park." },
    ]);
    const view = taskProjectView(p, 3000, "When is the fire drill?", open);
    const text = view.files.map((f) => f.content).join("\n");
    expect(text).toMatch(/fire drill is on Thursday/);
    expect(view.files.reduce((n, f) => n + f.content.length, 0)).toBeLessThanOrEqual(3000);
  });

  it("the sidecar's task run uses it (source pin)", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toMatch(/taskProjectView\(task\.project/);
  });
});
