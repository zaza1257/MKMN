// Finds every lifecycle definition in the source, so the state-machine inventory can be
// checked for completeness. A "lifecycle" here is a named state/status/phase/stage/step
// type, or a status/phase/worker property whose value is a union of quoted strings.
//
// The scan is deliberately syntactic: it names places, not behaviour. Every key it returns
// must appear in src/shared/lifecycles.json (as a registry machine or an inventory entry),
// otherwise a person added a lifecycle without saying how it is handled.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SUFFIX = /(State|Status|Phase|Stage|Step)$/;
const PROPERTY = /^\s*(status|phase|worker)\s*:\s*([^;]*"[^"]*"[^;]*);?/m;
const ENCLOSING = /(?:interface|type)\s+([A-Z][A-Za-z0-9_]*)\b/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "generated" || name.endsWith(".generated.ts")) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** One named state/status/phase/stage/step type, and one property union, per place. */
export function scanFile(abs, root) {
  const text = readFileSync(abs, "utf8");
  const rel = relative(root, abs).replace(/\\/g, "/");
  const keys = [];

  for (const m of text.matchAll(/(?:export\s+)?type\s+([A-Z][A-Za-z0-9_]*)\s*=([\s\S]*?);/g)) {
    const name = m[1];
    const rhs = m[2];
    if (SUFFIX.test(name) && /["']/.test(rhs)) keys.push(`${rel}:${name}`);
  }
  for (const m of text.matchAll(/(?:export\s+)?enum\s+([A-Z][A-Za-z0-9_]*)/g)) {
    if (SUFFIX.test(m[1])) keys.push(`${rel}:${m[1]}`);
  }

  // status/phase/worker property unions, keyed by the enclosing type and the property
  const lines = text.split(/\r?\n/);
  let enclosing = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const e of line.matchAll(ENCLOSING)) enclosing = e[1];
    const pm = PROPERTY.exec(line);
    if (pm && /["']/.test(pm[2])) keys.push(`${rel}:${enclosing || "?"}.${pm[1]}`);
  }
  return keys;
}

/** Every lifecycle key in the source, sorted and unique. */
export function scanLifecycles(root) {
  const files = walk(join(root, "src"), []);
  const keys = new Set();
  for (const f of files) for (const k of scanFile(f, root)) keys.add(k);
  return [...keys].sort();
}

if (process.argv[1]?.endsWith("lifecycle-scan.mjs")) {
  const root = process.argv[2] ?? process.cwd();
  console.log(JSON.stringify(scanLifecycles(root), null, 2));
}
