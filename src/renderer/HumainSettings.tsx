import { useEffect, useRef, useState } from "react";
import { FUSE_EFFORTS, HUMAIN_FEATURES, featureEnabled, modelServices, modelsForService, requestModelService, HUMAIN_LABEL, type HumainModel, type HumainProvider, type HumainResult, type HumainUpload } from "../shared/humain";
import { readSetting } from "../shared/settingsSchema";
import type { Settings } from "../shared/types";
import { api } from "./api";

type Save = (patch: Partial<Settings>) => Promise<unknown>;
const messageOf = (error: unknown) => error instanceof Error ? error.message : String(error);
const providers = ["fuse", "node"] as const;

function KeyEditor({ credential, label, disabled, onChange, onSaving }: { credential: HumainProvider; label: string; disabled: boolean; onChange: () => void; onSaving: (saving: boolean) => void }) {
  const [saved, setSaved] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void Promise.resolve().then(() => api().humainKeySaved(credential)).then((value) => { if (active) setSaved(value); })
      .catch((e) => { if (active) setError(messageOf(e)); });
    return () => { active = false; };
  }, [credential]);
  async function update(key: string | null) {
    setBusy(true);
    onSaving(true);
    setError("");
    try {
      await api().humainSaveKey(credential, key);
      setDraft("");
      setSaved(key !== null);
      onChange();
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
      onSaving(false);
    }
  }
  return <div className="small">
    <label>{label} <input type="password" disabled={disabled || busy} autoComplete="off" spellCheck={false} value={draft}
      placeholder={saved ? "Key saved" : "Enter key"} onChange={(e) => setDraft(e.target.value)} /></label>{" "}
    <button type="button" disabled={disabled || busy || !draft.trim()} onClick={() => void update(draft)}>Save key</button>{" "}
    {saved && <button type="button" disabled={disabled || busy} onClick={() => void update(null)}>Remove key</button>}
    {error && <p role="alert">{error}</p>}
  </div>;
}

function ProviderSettings({ provider, section, settings, save }: { provider: HumainProvider; section: string; settings: Settings; save: Save }) {
  const [models, setModels] = useState<HumainModel[] | null>(null);
  const [savingKey, setSavingKey] = useState(false);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const modelKey = provider === "fuse" ? "humainFuseModel" : "humainNodeModel";
  const apiKey = provider === "fuse" ? "humainFuseChatApi" : "humainNodeChatApi";
  const selected = readSetting(settings, modelKey);
  const formats = models?.find((model) => model.id === selected)?.node?.supported_formats;
  const selectedApi = readSetting(settings, apiKey);
  function chooseModel(id: string, available = models ?? []) {
    const model = available.find((entry) => entry.id === id);
    const formats = model?.node?.supported_formats;
    const supported = formats?.filter((format) => ["chat_completions", "responses", "messages"].includes(format));
    const api = supported?.includes(selectedApi === "chat/completions" ? "chat_completions" : selectedApi)
      ? selectedApi : supported?.[0] === "responses" ? "responses" : supported?.[0] === "messages" ? "messages" : "chat/completions";
    return save({ [modelKey]: id, ...(provider === "node" ? { [apiKey]: api } : {}) });
  }
  async function refresh() {
    setBusy(true);
    setStatus("");
    try {
      const models = await api().humainModels(provider);
      const chatModels = modelsForService(provider, models, "chat");
      setModels(chatModels);
      const current = chatModels.find((model) => model.id === selected);
      const onlyModel = chatModels.length === 1 ? chatModels[0] : undefined;
      const currentFormat = selectedApi === "chat/completions" ? "chat_completions" : selectedApi;
      const advertised = current?.node?.supported_formats;
      if (!current && onlyModel && modelServices(provider, onlyModel).includes("chat")) {
        await chooseModel(onlyModel.id, chatModels);
      } else if (current && advertised?.length && !advertised.includes(currentFormat)) {
        await chooseModel(current.id, chatModels);
      }
      setStatus(chatModels.length ? `Connected. ${chatModels.length} chat model(s) available.` : "Connected. This key returned no selectable chat models.");
    } catch (e) {
      setStatus(messageOf(e));
      setModels(null);
    } finally {
      setBusy(false);
    }
  }
  return <section id={section} tabIndex={-1}>
    <h2>{HUMAIN_LABEL[provider]}</h2>
    <KeyEditor credential={provider} label={`${HUMAIN_LABEL[provider]} inference API key`} disabled={busy} onSaving={setSavingKey} onChange={() => { setModels(null); setStatus(""); }} />
    <p><button disabled={busy || savingKey} onClick={() => void refresh()}>{busy ? "Connecting…" : "Test connection and load models"}</button> <span role="status">{status}</span></p>
    <label>Chat model{" "}
      <select value={selected} disabled={busy || savingKey} onChange={(e) => void chooseModel(e.target.value)}>
        <option value="">Choose a model</option>
        {selected && !models?.some((m) => m.id === selected) && <option value={selected} disabled={models !== null}>{selected}{models !== null ? " · no longer available" : " · saved"}</option>}
        {models?.map((m) => <option key={m.id} value={m.id}>{m.id}{modelServices(provider, m).length === 0 ? " · compatibility unknown" : ""}</option>)}
      </select>
    </label>{" "}
    <label>Chat API{" "}
      <select value={provider === "fuse" ? "chat/completions" : readSetting(settings, apiKey)} disabled={provider === "fuse" || busy || savingKey} onChange={(e) => void save({ [apiKey]: e.target.value })}>
        <option value="chat/completions" disabled={!!formats?.length && !formats.includes("chat_completions")}>Chat Completions</option>
        <option value="responses" disabled={!!formats?.length && !formats.includes("responses")}>Responses</option>
        <option value="messages" disabled={!!formats?.length && !formats.includes("messages")}>Messages</option>
      </select>
    </label>
    {provider === "fuse" && <p className="muted small">Chats on Fuse run through MKMN's own pipeline (files, charts, project knowledge), which uses Chat Completions. Web search is asked of Fuse separately.</p>}
  </section>;
}

const sharedRoutes = ["/v1/models", "/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/images/generations", "/v1/embeddings", "/v1/rerank", "/v1/systemone"];
const examples: Record<HumainProvider, string[]> = {
  fuse: ["/v1/openapi.json", "/v1/limits", "/v1/completions", "/v1/messages/count_tokens", "/v1/systemone/batch",
    "/v1/videos", "/v1/audio/speech", "/v1/audio/transcriptions", "/v1/audio/voices", "/v1/audio/voice",
    "/v1/audio/generate", "/v1/audio/clone", "/v1/files", "/v1/batches"],
  node: ["/healthz"],
};

const workflows = [
  { label: "Generate an image", feature: "images", path: "/v1/images/generations", body: { model: "", prompt: "" } },
  { label: "Generate a video", feature: "video", path: "/v1/videos", fuse: true, body: { model: "", prompt: "" } },
  { label: "Synthesize speech", feature: "speech", path: "/v1/audio/speech", fuse: true, body: { model: "", input: "" } },
  { label: "Transcribe audio", feature: "transcription", path: "/v1/audio/transcriptions", fuse: true, body: { model: "" } },
  { label: "List custom voices", feature: "voices", path: "/v1/audio/voices", fuse: true },
  { label: "Embed text", feature: "embeddings", path: "/v1/embeddings", body: { model: "", input: "" } },
  { label: "Rerank documents", feature: "rerank", path: "/v1/rerank", body: { model: "", query: "", documents: [""] } },
  { label: "Ask System One", feature: "systemone", path: "/v1/systemone", body: { model: "", state: "", questions: { relevant: { type: "noul", instructions: "Is this relevant?" } } } },
  { label: "Upload a file", feature: "files", path: "/v1/files", fuse: true, body: { purpose: "batch" } },
  { label: "List files", feature: "files", path: "/v1/files", fuse: true },
  { label: "List batch jobs", feature: "batch", path: "/v1/batches", fuse: true },
  { label: "Create batch job", feature: "batch", path: "/v1/batches", fuse: true, body: { input_file_id: "", endpoint: "/v1/chat/completions", completion_window: "24h" } },
  { label: "Read batch status", feature: "batch", path: "/v1/batches/BATCH_ID", fuse: true },
  { label: "Cancel batch job", feature: "batch", path: "/v1/batches/BATCH_ID/cancel", fuse: true, body: {} },
  { label: "Read video status", feature: "video", path: "/v1/videos/VIDEO_ID", fuse: true },
  { label: "Download video", feature: "video", path: "/v1/videos/VIDEO_ID/content", fuse: true },
  { label: "Download provider file", feature: "files", path: "/v1/files/FILE_ID/content", fuse: true },
  { label: "Read stored response", feature: "advancedText", path: "/v1/responses/RESPONSE_ID", fuse: true },
  { label: "Count message tokens", feature: "advancedText", path: "/v1/messages/count_tokens", fuse: true, body: { model: "", messages: [{ role: "user", content: "" }] } },
  { label: "Read image content", feature: "images", path: "/v1/images/IMAGE_ID/content", fuse: true },
  { label: "Read limits", path: "/v1/limits", fuse: true },
] as const;

function CapabilitySettings({ settings, save, fuseChat = false }: { settings: Settings; save: Save; fuseChat?: boolean }) {
  const disabled = readSetting(settings, "humainDisabledFeatures");
  const [saving, setSaving] = useState(false);
  async function update(patch: Partial<Settings>) {
    setSaving(true);
    try { await save(patch); }
    finally { setSaving(false); }
  }
  return <section id={fuseChat ? "sec-humain-fuse-chat" : "sec-humain-features"} tabIndex={-1}>
    <h2>{fuseChat ? "Fuse chat options" : "HUMAIN capabilities"}</h2>
    {fuseChat ? <fieldset disabled={saving}>
      <legend>Fuse chat</legend>
      <label>Hosted search{" "}
        <select value={readSetting(settings, "humainChatSearch")} disabled={!featureEnabled(disabled, "search")}
          onChange={(e) => void update({ humainChatSearch: e.target.value as Settings["humainChatSearch"] })}>
          <option value="off">Off</option><option value="search">Web search</option><option value="research">Cited research</option>
        </select>
      </label>{" "}
      <label>Thinking effort{" "}
        <select value={readSetting(settings, "humainFuseEffort")}
          onChange={(e) => void update({ humainFuseEffort: e.target.value as Settings["humainFuseEffort"] })}>
          {FUSE_EFFORTS.map((level) => <option key={level} value={level}>{level === "default" ? "Model default" : level === "none" ? "Off" : level}</option>)}
        </select>
      </label>
      <p className="muted small">Hosted web search and cited research apply to Fuse chat.</p>
    </fieldset> : <fieldset disabled={saving}>
      <legend>Enabled capabilities</legend>
      {HUMAIN_FEATURES.map(([feature, label]) => <label key={feature} className="check">
        <input type="checkbox" checked={featureEnabled(disabled, feature)} onChange={(e) =>
          void update({ humainDisabledFeatures: { ...disabled, [feature]: !e.target.checked } })} /> {label}
      </label>)}
    </fieldset>}
  </section>;
}

function CostSettings({ settings, save }: { settings: Settings; save: Save }) {
  const [provider, setProvider] = useState<HumainProvider>("fuse");
  const [input, setInput] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const model = readSetting(settings, provider === "fuse" ? "humainFuseModel" : "humainNodeModel");
  const modelKey = `${provider}:${model}`;
  const rates = (readSetting(settings, "humainUsdRates") ?? {}) as NonNullable<Settings["humainUsdRates"]>;
  const rate = rates[modelKey];
  useEffect(() => {
    setInput(rate ? String(rate.input) : "");
    setOutput(rate ? String(rate.output) : "");
  }, [modelKey, rate?.input, rate?.output]);
  const fixedModel = Boolean(model && !model.endsWith("/auto") && !model.startsWith("@preset/"));
  const valid = Boolean(input.trim() && output.trim() && [input, output].every((v) => Number.isFinite(Number(v)) && Number(v) >= 0));
  async function update(remove: boolean) {
    setBusy(true);
    try {
      const next = { ...rates };
      if (remove) delete next[modelKey];
      else next[modelKey] = { input: Number(input), output: Number(output) };
      await save({ humainUsdRates: next });
    } finally {
      setBusy(false);
    }
  }
  return <section id="sec-humain-cost" tabIndex={-1}>
    <h2>Chat cost estimates</h2>
    <p>Enter the provider's USD rates per million tokens for the selected model. Estimates use reported token counts and exclude other charges.</p>
    <fieldset disabled={busy}>
      <label>Rate provider <select value={provider} onChange={(e) => setProvider(e.target.value as HumainProvider)}>
        {providers.map((p) => <option key={p} value={p}>{HUMAIN_LABEL[p]}</option>)}
      </select></label>
      <p>{fixedModel ? model : "Select a fixed chat model to set its rates."}</p>
      <label>Input USD per million <input type="number" min="0" step="any" value={input} disabled={!fixedModel} onChange={(e) => setInput(e.target.value)} /></label>{" "}
      <label>Output USD per million <input type="number" min="0" step="any" value={output} disabled={!fixedModel} onChange={(e) => setOutput(e.target.value)} /></label>{" "}
      <button type="button" disabled={!fixedModel || !valid} onClick={() => void update(false)}>Save rates</button>{" "}
      {rate && <button type="button" onClick={() => void update(true)}>Remove rates</button>}
    </fieldset>
  </section>;
}

function ApiConsole({ settings }: { settings: Settings }) {
  const disabled = readSetting(settings, "humainDisabledFeatures");
  const [provider, setProvider] = useState<HumainProvider>("fuse");
  const [method, setMethod] = useState("GET");
  const [workflow, setWorkflow] = useState("");
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageModel, setImageModel] = useState("");
  const [catalog, setCatalog] = useState<HumainModel[] | null>(null);
  const [path, setPath] = useState("/v1/models");
  const service = requestModelService(path);
  const serviceModels = modelsForService(provider, catalog ?? [], service);
  async function loadCatalog() {
    setBusy(true);
    setError("");
    try { setCatalog(await api().humainModels(provider)); }
    catch (e) { setError(messageOf(e)); }
    finally { setBusy(false); }
  }
  function chooseWorkflow(value: string) {
    setWorkflow(value);
    setImagePrompt("");
    setImageModel("");
    const choice = workflows.find((item) => item.label === value);
    if (!choice) {
      setJson("");
      setFile(undefined);
      setResult(undefined);
      return;
    }
    setPath(choice.path);
    setMethod("body" in choice ? "POST" : "GET");
    setJson("body" in choice ? JSON.stringify(choice.body, null, 2) : "");
    setField("file");
    setFile(undefined);
    setResult(undefined);
  }
  const [json, setJson] = useState("");
  const [file, setFile] = useState<File>();
  const [field, setField] = useState("file");
  const [result, setResult] = useState<HumainResult>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run() {
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      let upload: HumainUpload | undefined;
      if (file && method === "POST") {
        const data = await new Promise<string>((ok, fail) => {
          const reader = new FileReader();
          reader.onload = () => ok(String(reader.result).split(",")[1]);
          reader.onerror = () => fail(reader.error);
          reader.readAsDataURL(file);
        });
        upload = { base64: data, field, filename: file.name, mime: file.type };
      }
      const body = workflow === "Generate an image"
        ? { model: imageModel, prompt: imagePrompt.trim(), ...(provider === "fuse" ? { response_format: "b64_json" } : {}) }
        : method !== "GET" && json.trim() ? JSON.parse(json) : undefined;
      setResult(await api().humainOperation(provider, method, path.trim(), body, upload));
    } catch (e) {
      setError(messageOf(e));
    } finally {
      setBusy(false);
    }
  }
  function download(result: Extract<HumainResult, { type: "file" }>) {
    const bytes = Uint8Array.from(atob(result.base64), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = result.mime === "image/png" ? "humain-image.png" : "humain-result";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const imageWorkflow = workflow === "Generate an image";
  const imageData = path.trim() === "/v1/images/generations" && result?.type === "json"
    ? (result.value as { data?: { b64_json?: unknown }[] } | null)?.data : undefined;
  const images = Array.isArray(imageData) ? imageData.flatMap((item) => {
    const data = item?.b64_json;
    return typeof data === "string" && data.startsWith("iVBORw0KGgo") && /^[A-Za-z0-9+/=]+$/.test(data) ? [data] : [];
  }) : [];
  return <section id="sec-humain-api" tabIndex={-1}><h2>HUMAIN API</h2>
    <p>Send a provider request for media, files, batches, embeddings, rerank, or System One. Requests may incur charges or change provider resources.</p>
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <label>Provider <select value={provider} onChange={(e) => { setProvider(e.target.value as HumainProvider); setPath("/v1/models"); setMethod("GET"); setWorkflow(""); setCatalog(null); setJson(""); setFile(undefined); setResult(undefined); setError(""); }}>
        {providers.map((p) => <option value={p} key={p}>{HUMAIN_LABEL[p]}</option>)}
      </select></label>{" "}
      <p><label>Operation <select value={workflow} onChange={(e) => chooseWorkflow(e.target.value)}>
        <option value="">Custom request</option>
        {workflows.filter((item) => !("fuse" in item) || provider === "fuse").map((item) => <option key={item.label} disabled={"feature" in item && !featureEnabled(disabled, item.feature)}>{item.label}</option>)}
      </select></label></p>
      {imageWorkflow && <p>
        <label>Image prompt <textarea rows={3} value={imagePrompt} onChange={(e) => setImagePrompt(e.target.value)} /></label>
      </p>}
      {workflow && method === "POST" && service && <>
        {catalog && serviceModels.length === 0 && <p role="status">This key returned no models for this operation.</p>}
        <button type="button" onClick={() => void loadCatalog()}>Load provider models</button>{" "}
        {serviceModels.length > 0 && <label>Model <select value={imageWorkflow ? imageModel : ""} onChange={(e) => {
          if (imageWorkflow) { setImageModel(e.target.value); return; }
          try { setJson(JSON.stringify({ ...JSON.parse(json), model: e.target.value }, null, 2)); }
          catch { setError("Correct the request JSON before selecting a model."); }
        }}>
          <option value="">Choose a model</option>
          {serviceModels.map((item) => <option key={item.id} value={item.id}>{item.id}{service && !modelServices(provider, item).length ? " · compatibility unknown" : ""}</option>)}
        </select></label>}
      </>}
      {!imageWorkflow && <><label>Method <select value={method} onChange={(e) => setMethod(e.target.value)}>
        {["GET", "POST", "DELETE"].map((verb) => <option key={verb}>{verb}</option>)}
      </select></label>{" "}
      <label>Endpoint <input list="humain-endpoints" value={path} onChange={(e) => setPath(e.target.value)} /></label>
      <datalist id="humain-endpoints">{[...sharedRoutes, ...examples[provider]].map((route) => <option key={route} value={route} />)}</datalist>
      {method !== "GET" && <p><label>Request JSON <textarea rows={5} value={json} onChange={(e) => setJson(e.target.value)} /></label></p>}
      {method === "POST" && <p><label>Upload <input key={provider + workflow} type="file" onChange={(e) => setFile(e.target.files?.[0])} /></label>{" "}
        {file && <label>Form field <input value={field} onChange={(e) => setField(e.target.value)} /></label>}</p>}
      </>}
      <button type="button" disabled={imageWorkflow && (!imageModel || !imagePrompt.trim())} onClick={() => void run()}>{busy ? "Sending…" : imageWorkflow ? "Generate image" : "Send request"}</button>
    </fieldset>
    {error && <p role="alert">{error}</p>}
    {images.map((data, index) => <div key={index}>
      <img src={`data:image/png;base64,${data}`} alt={`Generated image ${index + 1}`} style={{ maxWidth: "100%", maxHeight: "24rem" }} />
      <button type="button" onClick={() => download({ type: "file", mime: "image/png", base64: data })}>Download image</button>
    </div>)}
    {result?.type === "json" && images.length === 0 && <pre tabIndex={0} style={{ overflow: "auto", maxHeight: "24rem" }}>{JSON.stringify(result.value, null, 2)}</pre>}
    {result?.type === "file" && <button type="button" onClick={() => download(result)}>Download response</button>}
  </section>;
}

function Realtime() {
  const [model, setModel] = useState("");
  const [models, setModels] = useState<HumainModel[]>([]);
  const [loading, setLoading] = useState(false);
  async function loadModels() {
    setLoading(true);
    setError("");
    try {
      const available = modelsForService("node", await api().humainModels("node"), "realtime");
      setModels(available);
      if (!available.length) setError("This key returned no Realtime models.");
      setModel((current) => available.some((entry) => entry.id === current) ? current : "");
    } catch (e) {
      setModels([]);
      setModel("");
      setError(messageOf(e));
    } finally {
      setLoading(false);
    }
  }
  const [session, setSession] = useState("");
  const activeSession = useRef("");
  const [state, setState] = useState("Disconnected");
  const [json, setJson] = useState('{"type":"response.create"}');
  const [events, setEvents] = useState<unknown[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!session) return;
    let active = true;
    let reading = false;
    const timer = setInterval(async () => {
      if (reading) return;
      reading = true;
      try {
        const batch = await api().humainRealtimeEvents(session);
        if (!active) return;
        if (batch.length) setEvents((prev) => [...prev, ...batch].slice(-100));
        if (batch.some((event) => (event as { type?: string } | null)?.type === "closed")) {
          activeSession.current = "";
          setSession("");
          setState("Disconnected");
        }
      } catch (e) {
        if (active) setError(messageOf(e));
      } finally {
        reading = false;
      }
    }, 500);
    return () => { active = false; if (activeSession.current === session) activeSession.current = ""; clearInterval(timer); void api().humainRealtimeClose(session).catch(() => undefined); };
  }, [session]);
  async function connect() {
    const id = crypto.randomUUID();
    activeSession.current = id;
    setSession(id);
    setEvents([]);
    setError("");
    setState("Connecting…");
    try {
      await api().humainRealtimeOpen(id, model);
      if (activeSession.current === id) setState("Connected");
    } catch (e) {
      if (activeSession.current !== id) return;
      activeSession.current = "";
      setError(messageOf(e));
      setSession("");
      setState("Disconnected");
    }
  }
  async function send() {
    setError("");
    try { await api().humainRealtimeSend(session, JSON.parse(json)); }
    catch (e) { setError(messageOf(e)); }
  }
  return <section><h2>Node realtime</h2>
    <p>Choose a Node model that supports realtime and send JSON events over its WebSocket connection.</p>
    <p><button type="button" disabled={loading || Boolean(session)} onClick={() => void loadModels()}>
      {loading ? "Loading…" : "Load Node models"}
    </button>{" "}
    <label>Realtime model <select value={model} disabled={loading || Boolean(session)} onChange={(e) => setModel(e.target.value)}>
      <option value="">Choose a model</option>
      {models.map((entry) => <option key={entry.id} value={entry.id}>{entry.id}{!modelServices("node", entry).length ? " · compatibility unknown" : ""}</option>)}
    </select></label></p>
    <button type="button" disabled={!model || loading || Boolean(session)} onClick={() => void connect()}>Connect</button>{" "}
    <button type="button" disabled={!session} onClick={() => { activeSession.current = ""; setSession(""); setState("Disconnected"); }}>Disconnect</button>{" "}
    <span role="status">{state}</span>
    <p><label>Realtime event JSON <textarea rows={3} value={json} onChange={(e) => setJson(e.target.value)} /></label>{" "}
      <button type="button" disabled={state !== "Connected"} onClick={() => void send()}>Send event</button></p>
    {error && <p role="alert">{error}</p>}
    {events.length > 0 && <pre tabIndex={0} style={{ overflow: "auto", maxHeight: "18rem" }}>{JSON.stringify(events, null, 2)}</pre>}
  </section>;
}

export function HumainSettings({ settings, save, provider, onOpenProvider, onOpenChatLocation }: {
  settings: Settings; save: Save; provider?: HumainProvider;
  onOpenProvider?: (provider: HumainProvider) => void; onOpenChatLocation?: () => void;
}) {
  const location = readSetting(settings, "humainMode");
  return <>
    <section id="sec-humain-routing" tabIndex={-1}>
      <h2>Connect a cloud provider</h2>
      <p className="small">Save an API key for Fuse or Node, test the connection, then choose a chat model. Windows protects saved keys for your Windows account.</p>
      <p className="muted small">Cloud chat sends conversation context and attached content only to the selected provider.</p>
      <p className="muted small">Current chat location: {location === "local" ? "This PC" : HUMAIN_LABEL[location]}.{" "}
        {onOpenChatLocation && <button type="button" className="linklike" onClick={onOpenChatLocation}>Change chat location</button>}
      </p>
      {!provider && onOpenProvider && <div className="row">
        {providers.map((id) => <button key={id} type="button" className="linklike" onClick={() => onOpenProvider(id)}>Set up {HUMAIN_LABEL[id]}</button>)}
      </div>}
    </section>
    {provider && (
      <ProviderSettings key={provider} provider={provider}
        section={provider === "fuse" ? "sec-humain-fuse" : "sec-humain-node"} settings={settings} save={save} />
    )}
    {provider === "fuse" && <CapabilitySettings settings={settings} save={save} fuseChat />}
    {provider === "node" && featureEnabled(readSetting(settings, "humainDisabledFeatures"), "realtime") && (
      <section>
        <details className="bench-how">
          <summary>Node realtime</summary>
          <Realtime />
        </details>
      </section>
    )}
    {!provider && <>
    <CapabilitySettings settings={settings} save={save} />
    <CostSettings settings={settings} save={save} />
    <section aria-labelledby="humain-advanced-heading">
      <h2 id="humain-advanced-heading">Advanced tools</h2>
      <details className="bench-how">
        <summary>HUMAIN API console</summary>
        <ApiConsole settings={settings} />
      </details>
    </section>
    </>}
  </>;
}
