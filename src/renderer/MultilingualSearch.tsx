import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import type { VectorModelStatusView } from "../shared/api";

const mb = (bytes: number) => `${Math.round(bytes / 1048576)} MB`;

/**
 * Settings → Files & projects → Search across languages: installs or removes the
 * multilingual search model the knowledge retrieval uses when the words of a question
 * do not clearly match the files (another language, other words). Nothing is
 * downloaded until the person presses Install.
 */
export function MultilingualSearch() {
  const [st, setSt] = useState<VectorModelStatusView | null>(null);
  const [busy, setBusy] = useState<"install" | "remove" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let live = true;
    void api().vectorModelStatus().then((s) => { if (live) setSt(s); });
    return () => { live = false; if (poll.current) clearInterval(poll.current); };
  }, []);

  const install = async () => {
    setBusy("install");
    poll.current = setInterval(() => { void api().vectorModelStatus().then((s) => s && setSt(s)); }, 700);
    const s = await api().vectorModelInstall();
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    setSt(s);
    setBusy(null);
  };
  const remove = async () => {
    setBusy("remove");
    setConfirmRemove(false);
    setSt(await api().vectorModelRemove());
    setBusy(null);
  };

  if (st && !st.runtime) {
    return <div className="muted small">This build has no runtime for the multilingual search model.</div>;
  }
  const progress = st?.progress && st.progress.of ? Math.round((st.progress.done / st.progress.of) * 100) : null;
  return (
    <>
      <p className="muted small">
        When the words of a question do not clearly match your project files (a question in Arabic about English files, or other words than the files use),
        MKMN searches them by meaning with a small model that runs on the processor. Without it, MKMN asks the chat model to write search words, which small models often get wrong.
      </p>
      <div className="row">
        {st?.installed ? (
          <>
            <span className="small">Installed{st.label ? `: ${st.label}` : ""}</span>
            {confirmRemove ? (
              <>
                <span className="small">Remove the model ({mb(st.bytes)})? Search goes back to keywords.</span>
                <button className="danger" onClick={() => void remove()} disabled={busy !== null}>Remove</button>
                <button onClick={() => setConfirmRemove(false)}>Keep it</button>
              </>
            ) : (
              <button onClick={() => setConfirmRemove(true)} disabled={busy !== null}>Remove</button>
            )}
          </>
        ) : (
          <button className="primary" onClick={() => void install()} disabled={busy !== null || !st}>
            {busy === "install" ? `Installing… ${progress !== null ? `${progress} %` : ""}` : `Install (${st ? mb(st.bytes) : "about 129 MB"})`}
          </button>
        )}
      </div>
      {busy === "install" && <div className="muted small" role="status">Downloading and checking the files. Each file's fingerprint is checked before it is used.</div>}
      {st?.error && <div className="warn small" role="alert">The install did not finish: {st.error}</div>}
      <div className="muted small">Source: paraphrase-multilingual-MiniLM-L12-v2 (Apache-2.0). It reads your files on this computer only.</div>
    </>
  );
}
