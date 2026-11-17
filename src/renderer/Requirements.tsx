import { useEffect, useState } from "react";
import { REQUIREMENTS, type RequirementStatus } from "../core/requirements";
import type { RequirementUpdates } from "../shared/api";
import { api } from "./api";

/**
 * What MKMN needs on this PC, read now: each runtime with whether the app needs it, whether it is there, and the way to
 * get a missing one (Install runs the package of the fixed list; drivers open Windows Update; GenieX has its setup).
 */
export function Requirements({ onOpenSetup }: { onOpenSetup?: () => void }) {
  const [status, setStatus] = useState<RequirementStatus[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [updates, setUpdates] = useState<RequirementUpdates | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);

  // newer versions are looked for only when asked: winget reads its sources over the internet, which takes a while
  const checkForUpdates = async () => {
    setCheckingUpdates(true);
    setMessage(null);
    try {
      const u = await api().requirementUpdates();
      setUpdates(u);
      setMessage(u.geniex.newer ? `${u.message} A newer GenieX installer is available.` : u.message);
    } catch (e) { setMessage(`The update check failed: ${(e as Error).message}`); } finally { setCheckingUpdates(false); }
  };

  const update = async (id: string, pkg: string) => {
    setBusy(id);
    setMessage(null);
    try {
      const r = await api().updateRequirement(id, pkg);
      setMessage(r.message);
      if (r.ok) setUpdates((u) => (u ? { ...u, updates: u.updates.filter((x) => x.pkg !== pkg) } : u));
      await check();
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(null); }
  };

  // GenieX is updated by MKMN's own install (newest installer, signature checked), never by `geniex update`
  const updateGeniex = async () => {
    setBusy("geniex");
    setMessage(null);
    try {
      await api().openGeniexDownload();
      setMessage("GenieX is being updated by MKMN's setup; its progress shows in the setup step.");
      setUpdates((u) => (u ? { ...u, geniex: { ...u.geniex, newer: false } } : u));
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(null); }
  };

  const check = async () => {
    setChecking(true);
    try { setStatus(await api().requirements()); } catch (e) { setMessage(`The check failed: ${(e as Error).message}`); } finally { setChecking(false); }
  };
  useEffect(() => { void check(); }, []);

  const install = async (id: string) => {
    setBusy(id);
    setMessage(null);
    try {
      const r = await api().installRequirement(id);
      setMessage(r.message);
      await check();
    } catch (e) { setMessage((e as Error).message); } finally { setBusy(null); }
  };

  const of = (id: string) => status?.find((s) => s.id === id);
  return (
    <div className="requirements">
      <table className="small">
        <thead><tr><th>Needed</th><th>What uses it</th><th>On this PC</th><th /></tr></thead>
        <tbody>
          {REQUIREMENTS.map((r) => {
            const s = of(r.id);
            const state = !s ? (checking ? "Checking…" : "Not checked") : s.present ? `Yes${s.detail ? ` · ${s.detail}` : ""}` : `Missing${s.detail ? ` · ${s.detail}` : ""}`;
            return (
              <tr key={r.id}>
                <td><strong>{r.name}</strong><div className="muted">{r.need === "required" ? "Required" : "Optional"}</div></td>
                <td>{r.what}</td>
                <td className={s && !s.present && r.need === "required" ? "warn" : undefined}>{state}</td>
                <td>
                  {s && !s.present && r.install.winget && <button disabled={busy !== null} onClick={() => void install(r.id)}>{busy === r.id ? "Installing…" : "Install"}</button>}
                  {s && !s.present && r.install.settingsUri && <a href={r.install.settingsUri}>Windows Update</a>}
                  {s && !s.present && r.install.setup && onOpenSetup && <button onClick={onOpenSetup}>Set up</button>}
                  {s && !s.present && r.install.bundled && <span className="muted">Reinstall MKMN</span>}
                  {s && !s.present && r.install.library && <span className="muted">Settings → Models</span>}
                  {s?.present && updates?.updates.filter((u) => u.id === r.id).map((u) => (
                    <button key={u.pkg} disabled={busy !== null} title={`${u.pkg}: ${u.current} → ${u.available}`} onClick={() => void update(r.id, u.pkg)}>
                      {busy === r.id ? "Updating…" : `Update to ${u.available}`}
                    </button>
                  ))}
                  {s?.present && r.id === "geniex" && updates?.geniex.newer && (
                    <button disabled={busy !== null} title={`Installed: ${updates.geniex.installed ?? "version unknown"}. The installer on Qualcomm's server is newer.`} onClick={() => void updateGeniex()}>
                      {busy === "geniex" ? "Updating…" : "Update GenieX"}
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button className="linkbtn" disabled={checking || busy !== null} onClick={() => void check()}>{checking ? "Checking…" : "Check again"}</button>
        <button className="linkbtn" disabled={checkingUpdates || busy !== null} onClick={() => void checkForUpdates()}>{checkingUpdates ? "Looking for updates…" : "Check for updates"}</button>
        {message && <span className="small" role="status">{message}</span>}
      </div>
      <p className="muted small">Install and Update download the package from the internet with winget; Windows asks for permission when it needs to. GenieX is updated by MKMN's own setup, which checks the installer's signature. MKMN itself is updated by installing a newer MKMN release.</p>
    </div>
  );
}
