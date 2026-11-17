// The context a QAIRT bundle was COMPILED with: `dialog.context.size` of the bundle's own
// genie_config.json. A compiled Hexagon graph cannot change its window at serve time, so this —
// not a setting and not a memory fit — is the model's real context. Read with the app's own
// cache-location rules (modelsDir + modelFolders, the same rules the removal path uses) and the
// one canonical identity mapping (ai-hub-models/X counts as qualcomm/X). Node-only: the renderer
// receives the same truth through `servedNctx` in the server status instead of reading files.
import fs from "node:fs";
import path from "node:path";
import { modelsDir, modelFolders } from "./geniex";
import { canonicalName } from "./modelIdentity";

/** The compiled dialog context of an installed QAIRT bundle, or null when it is not installed or does not say. */
export function compiledContextOf(modelRef: string, dir = modelsDir(), readFile: (p: string, enc: "utf8") => string = (p) => fs.readFileSync(p, "utf8")): number | null {
  const ref = canonicalName(modelRef);
  for (const folder of modelFolders(ref, dir)) {
    try {
      const v = JSON.parse(readFile(path.join(folder, "genie_config.json"), "utf8"));
      const size = v?.dialog?.context?.size;
      if (typeof size === "number" && Number.isFinite(size) && size > 0) return size;
    } catch { /* this folder has no readable genie_config.json: the next candidate is tried */ }
  }
  return null;
}
