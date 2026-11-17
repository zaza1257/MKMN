import { describe, expect, it } from "vitest";
import { friendly } from "../src/core/errors";

// A chat on HUMAIN Fuse now runs through the orchestrator, whose errors go through friendly():
// the codes the Fuse and Node docs name must read as what they are, never "Something went wrong".
describe("HUMAIN failures in the chat pipeline", () => {
  it("a refused key", () => {
    expect(friendly("HUMAIN Fuse: HTTP 401 · invalid_api_key · request req_1")?.id).toBe("humain-key");
  });
  it("a model the key can no longer use", () => {
    expect(friendly("HUMAIN Fuse: HTTP 404 · model_not_found")?.id).toBe("humain-model");
  });
  it("a limit reached, with when to try again", () => {
    const e = friendly("Server error 429 · request req_2 · retry after 30s: {\"error\":{\"code\":\"weekly_cap_exceeded\"}}");
    expect(e?.id).toBe("humain-limit");
    expect(e?.raw).toContain("retry after 30s");
  });
  it("no connection", () => {
    expect(friendly("HUMAIN Fuse: connection unavailable")?.id).toBe("humain-offline");
  });
});
