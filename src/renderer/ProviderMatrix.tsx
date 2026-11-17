import { ARTIFACT_SOURCES, PROVIDERS, type Build } from "../core/providers";

/**
 * The provider compatibility matrix (Developer settings): every inference
 * provider and artifact source, its build availability, its egress — where user
 * content can go through it — and what was verified on the REFERENCE machine.
 * This device's own status is the per-device evidence store, never these
 * constants. The matrix states unvalidated paths instead of hiding them.
 */

/** Which build this renderer is running in: the Tauri bridge only wires itself
 * up under WebView2. */
function detectBuild(): Build {
  if (typeof window !== "undefined" && ("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return "tauri";
  return "electron";
}

const EGRESS_BADGE = {
  "loopback-only": { label: "loopback", cls: "good", hint: "Content stays on this PC: the endpoint is 127.0.0.1." },
  "local-files": { label: "local", cls: "good", hint: "Reads local content only; nothing leaves the PC." },
  "web-keywords": { label: "keywords → web", cls: "fair", hint: "Sends only search keywords to the web, never the chat text, and only when the search setting is on." },
  "remote-content": { label: "content → remote", cls: "low", hint: "Content leaves the PC. The app never routes a prompt here silently." },
} as const;

const CHECK = (ok: boolean) => (ok ? "yes" : "no");

export function ProviderMatrix({ build = detectBuild() }: { build?: Build }) {
  return (
    <>
      <table className="kv prov-matrix">
        <thead>
          <tr><td>Inference provider</td><td>In this build</td><td>Endpoint</td><td>Egress</td><td>Verified (reference machine, not this PC)</td></tr>
        </thead>
        <tbody>
          {PROVIDERS.map((p) => {
            const inBuild = p.builds.includes(build) || p.builds.includes("both");
            const e = EGRESS_BADGE[p.egress];
            return (
              <tr key={p.id}>
                <td><strong>{p.name}</strong><div className="muted small">{p.role}</div></td>
                <td>{inBuild ? "yes" : `no (${p.builds.join(", ")} only)`}</td>
                <td className="small">{p.endpoint ?? "—"}</td>
                <td><span className={`badge score ${e.cls}`} title={e.hint}>{e.label}</span></td>
                <td className="small">
                  {p.validatedOnReferenceMachine
                    ? <>{CHECK(p.validatedOnReferenceMachine.paths.discovery)} / {CHECK(p.validatedOnReferenceMachine.paths.download)} / {CHECK(p.validatedOnReferenceMachine.paths.load)} / {CHECK(p.validatedOnReferenceMachine.paths.inference)}<div className="muted small">on {p.validatedOnReferenceMachine.machine}</div></>
                    : <>{CHECK(false)} / {CHECK(false)} / {CHECK(false)} / {CHECK(false)}</>}
                  <div className="muted small">THIS device's status is not this table: it is the per-device evidence (the badges in Models).</div>
                  {p.notes.length > 0 && <div className="muted small">{p.notes.join(" ")}</div>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h2>Artifact sources</h2>
      <table className="kv prov-matrix">
        <thead>
          <tr><td>Source</td><td>What it provides</td><td>Duplicate-import protection</td></tr>
        </thead>
        <tbody>
          {ARTIFACT_SOURCES.map((s) => (
            <tr key={s.id}>
              <td><strong>{s.name}</strong></td>
              <td className="small">{s.role}</td>
              <td className="small">{s.duplicateProtection === "protected" ? "built-in" : s.duplicateProtection === "protected-now" ? "added" : "none"} — {s.protectionNote}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">Every chat completion goes to a localhost OpenAI-compatible endpoint; the app has no remote LLM provider and never routes a prompt off this PC without an explicit choice. Thinking on QAIRT bundles is verified against the installed runtime's contract (enable_think); on GGUF it is declared by the chat template only.</p>
    </>
  );
}
