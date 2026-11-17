import { describe, expect, it } from "vitest";
import { readZip, writeZip } from "../src/core/zip";

/**
 * readZip never checked the local header signature nor the CRC: a file whose bytes were
 * damaged decoded garbage as a part instead of saying the file is damaged.
 */

const enc = (s: string) => new TextEncoder().encode(s);

describe("readZip refuses a damaged entry", () => {
  it("reads back what it wrote", async () => {
    const z = await writeZip({ "a.txt": enc("hello hello hello hello") });
    expect(new TextDecoder().decode((await readZip(z))["a.txt"])).toBe("hello hello hello hello");
  });

  it("refuses stored bytes changed after writing (checksum)", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const bad = z.slice();
    // the single stored or deflated data byte sits right after the local header and the name
    const at = 30 + "a.txt".length;
    bad[at] ^= 0xff;
    await expect(readZip(bad)).rejects.toThrow(/damaged/);
  });

  it("refuses a directory that points at no local header", async () => {
    const z = await writeZip({ "a.txt": enc("x") });
    const bad = z.slice();
    bad[0] = 0; // the local header's signature
    await expect(readZip(bad)).rejects.toThrow(/damaged/);
  });
});
