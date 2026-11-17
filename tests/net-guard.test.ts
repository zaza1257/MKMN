import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { guardedFetch, isPrivateAddress } from "../src/core/netGuard";

/**
 * Web search reads pages the search engine returned, and their redirects. Neither
 * may reach this PC or the local network: a page (or a redirect) pointing at
 * localhost, a private range or a link-local address is refused, at every hop.
 * The person's own SearXNG instance, which may be local, stays allowed.
 */

const lookupTable: Record<string, string[]> = {
  "public.example": ["93.184.216.34"],
  "inside.example": ["192.168.1.10"],
  "router.local": ["10.0.0.1"],
  "searx.lan": ["192.168.1.50"],
};
const lookup = async (host: string) => (lookupTable[host] ?? []).map((address) => ({ address }));

function fakeFetch(routes: Record<string, { status: number; location?: string; body?: string }>) {
  const seen: string[] = [];
  const f = async (url: string) => {
    seen.push(url);
    const r = routes[url];
    if (!r) throw new Error(`unexpected fetch ${url}`);
    return new Response(r.body ?? "", { status: r.status, headers: r.location ? { location: r.location } : {} });
  };
  return { f, seen };
}

describe("isPrivateAddress", () => {
  it("knows loopback, private, link-local and unique-local ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"]) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) expect(isPrivateAddress(ip), ip).toBe(false);
  });
});

describe("guardedFetch", () => {
  it("reads a public page", async () => {
    const { f } = fakeFetch({ "https://public.example/a": { status: 200, body: "hello" } });
    const r = await guardedFetch(f as any, lookup, [])("https://public.example/a");
    expect(await r.text()).toBe("hello");
  });

  it("refuses a page on the local network, and never fetches it", async () => {
    const { f, seen } = fakeFetch({});
    await expect(guardedFetch(f as any, lookup, [])("http://inside.example/admin")).rejects.toThrow(/local network/);
    await expect(guardedFetch(f as any, lookup, [])("http://127.0.0.1:18181/v1/models")).rejects.toThrow(/local network/);
    expect(seen).toEqual([]);
  });

  it("refuses a redirect from a public page to a private one", async () => {
    const { f, seen } = fakeFetch({ "https://public.example/r": { status: 302, location: "http://router.local/" } });
    await expect(guardedFetch(f as any, lookup, [])("https://public.example/r")).rejects.toThrow(/local network/);
    expect(seen).toEqual(["https://public.example/r"]);
  });

  it("refuses a scheme that is not the web, and too many redirects", async () => {
    const { f } = fakeFetch({ "https://public.example/loop": { status: 301, location: "https://public.example/loop" } });
    await expect(guardedFetch(f as any, lookup, [])("file:///C:/Windows/win.ini")).rejects.toThrow(/http/);
    await expect(guardedFetch(f as any, lookup, [])("https://public.example/loop")).rejects.toThrow(/redirect/);
  });

  it("allows the person's own search instance even when it is local", async () => {
    const { f } = fakeFetch({ "http://searx.lan:8080/search?q=x": { status: 200, body: "{}" } });
    const r = await guardedFetch(f as any, lookup, ["http://searx.lan:8080"])("http://searx.lan:8080/search?q=x");
    expect(r.status).toBe(200);
  });
});

describe("the sidecar reads web pages only through the guard", () => {
  it("guards public library downloads and exposes no web search handler", () => {
    const src = readFileSync("src/sidecar/main.ts", "utf8");
    expect(src).toContain("const r = await guardedFetch(");
    expect(src).not.toMatch(/register\("(?:testWebSearch|wikimediaImage)"/);
    expect(src).not.toMatch(/redirect: "follow"/);
  });
});
