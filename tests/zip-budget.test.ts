import { describe, expect, it } from "vitest";
import { readZip, writeZip } from "../src/core/zip";

/**
 * A zip's declared sizes are claims, not facts. The total budget must hold on the
 * bytes really decoded, and an entry whose decoded size differs from its declared
 * size is refused (an Office file never lies about it).
 */

/** Rewrite every central-directory entry's uncompressed size (offset 24). */
function lieAboutSizes(zip: Uint8Array, size: number): Uint8Array {
  const out = zip.slice();
  const v = new DataView(out.buffer);
  for (let i = 0; i + 4 <= out.length; i++) if (v.getUint32(i, true) === 0x02014b50) v.setUint32(i + 24, size, true);
  return out;
}

describe("readZip trusts decoded bytes, not declared sizes", () => {
  it("refuses an entry whose decoded size is not the size it declared", async () => {
    const zip = await writeZip({ "word/document.xml": new TextEncoder().encode("a".repeat(5000)) });
    await expect(readZip(lieAboutSizes(zip, 10))).rejects.toThrow(/damaged|more than/);
  });

  it("still reads an honest file", async () => {
    const zip = await writeZip({ "a.xml": new TextEncoder().encode("hello world ".repeat(100)) });
    const files = await readZip(zip);
    expect(new TextDecoder().decode(files["a.xml"])).toBe("hello world ".repeat(100));
  });
});
