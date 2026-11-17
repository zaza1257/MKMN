import { describe, expect, it } from "vitest";
import { friendly } from "../src/core/errors";

// GenieX 0.11.0 reads a metadata.json every native NPU package must carry. Qualcomm's own Phi-3.5-Mini package
// has none, even freshly downloaded: installing it again does not help, so the message must not say it does.
describe("a native NPU package without the file this GenieX reads", () => {
  const line = "[dispatch.h:72:bundleFactsOf] dispatch: cannot read metadata.json: llm_spec_loader: cannot open C:/Users/x/.cache/geniex/models/qualcomm/Phi-3.5-Mini-Instruct/metadata.json";
  it("is named for what it is", () => {
    expect(friendly(line)?.id).toBe("old-bundle");
  });
  it("never promises that installing it again fixes it", () => {
    const e = friendly(line)!;
    expect(`${e.title} ${e.fix}`).not.toMatch(/install it again/i);
    expect(e.fix).toMatch(/another model/i);
  });
});
