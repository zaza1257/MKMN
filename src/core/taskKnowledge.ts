// What a scheduled task's run is given of its project's files.
//
// A chat whose project knowledge outgrows the budget searches the index for the
// parts that answer the question; a scheduled run packed the files whole and cut
// them at the budget, so a large project's run read whatever came first. A run now
// does what a chat does on its first pass: the index is searched with the task's
// own prompt and the best sections ride, within the same budget. Small knowledge
// still rides whole, exactly as before.

import type { Project } from "../shared/types";
import { knowledgeSize } from "./projects";
import type { KnowledgeIndex } from "./knowledge/store";

export function taskProjectView(project: Project, budgetChars: number, prompt: string, open: (p: Project) => KnowledgeIndex): Project {
  if (knowledgeSize(project) <= budgetChars) return project;
  let hits;
  try { hits = open(project).search(prompt, 24); } catch { return project; }
  if (!hits.length) return project; // nothing matched: the packed (cut) files, as before
  const files: Project["files"] = [];
  let left = budgetChars;
  for (const h of hits) {
    if (left <= 0) break;
    const text = h.text.length > left ? h.text.slice(0, left) : h.text;
    files.push({ id: `${h.fileId}#${h.doc}`, name: h.title ? `${h.name} — ${h.title}` : h.name, content: text });
    left -= text.length;
  }
  return { ...project, files };
}
