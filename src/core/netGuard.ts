// A fetch for web pages that cannot reach this PC or the local network.
//
// Search results and their redirects come from outside: a result (or a redirect)
// pointing at localhost, a private range or a link-local address (a router, the
// model server on 127.0.0.1, a cloud metadata address) must not be read and fed to
// the model. Redirects are followed here, one hop at a time, each hop checked.
// Residual risk, stated: the address is checked by resolving the name before the
// request, so a name that resolves differently a moment later (DNS rebinding) is
// not pinned; the scheme, the hop limit and the per-hop check still hold.

export type Lookup = (host: string) => Promise<Array<{ address: string }>>;
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_HOPS = 5;

function ipv4Private(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127) // shared address space (carrier NAT)
    || a >= 224; // multicast and reserved
}

/** Loopback, private, link-local, unique-local, unspecified, or a mapped IPv4 of those. */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v)) return ipv4Private(v);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (mapped) return ipv4Private(mapped[1]);
  if (v === "::" || v === "::1") return true;
  return /^fe[89ab]/.test(v) || /^f[cd]/.test(v) || /^ff/.test(v);
}

async function refusedReason(url: URL, lookup: Lookup, allowed: Set<string>): Promise<string | null> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `only http and https pages are read (${url.protocol})`;
  if (allowed.has(url.origin)) return null;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "the page is on this PC or the local network";
  const addresses = /^[\d.]+$/.test(host) || host.includes(":") ? [{ address: host }] : await lookup(host).catch(() => []);
  if (!addresses.length) return `the address of ${host} could not be found`;
  if (addresses.some((a) => isPrivateAddress(a.address))) return "the page is on this PC or the local network";
  return null;
}

/** A fetch that follows at most MAX_HOPS redirects itself and refuses any hop that
 *  leaves the public web. `allowOrigins` are the person's own configured services
 *  (their SearXNG instance), which may live on the local network. */
export function guardedFetch(fetchImpl: FetchLike, lookup: Lookup, allowOrigins: string[]): FetchLike {
  const allowed = new Set(allowOrigins.map((o) => { try { return new URL(o).origin; } catch { return ""; } }).filter(Boolean));
  return async (input: string, init?: RequestInit) => {
    let url = new URL(input);
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const why = await refusedReason(url, lookup, allowed);
      if (why) throw new Error(`Not read: ${why}.`);
      const res = await fetchImpl(url.toString(), { ...init, redirect: "manual" });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;
      url = new URL(location, url);
    }
    throw new Error(`Not read: more than ${MAX_HOPS} redirects.`);
  };
}
