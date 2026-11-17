/**
 * The multilingual search model: what it is, where it lives, how it is installed,
 * checked and removed. Installed only when the person asks (Settings →
 * Files & projects); without it, retrieval is BM25 and the model-written rewrite as
 * before. The files are pinned to one revision of their source, and each file's
 * SHA-256 is checked before it replaces anything: a file that does not match is
 * deleted and the install fails by name.
 *
 * Node only.
 */
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import * as path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { mkmnPaths } from "../../shared/paths";
import { openOnnxEmbedder, type Embedder } from "./embed";

export interface VectorModelFile {
  /** The name the file has in the installed folder. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface VectorModelSpec {
  id: string;
  label: string;
  license: string;
  files: VectorModelFile[];
}

const REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
const SOURCE = `https://huggingface.co/Xenova/paraphrase-multilingual-MiniLM-L12-v2/resolve/${REVISION}`;

/** paraphrase-multilingual-MiniLM-L12-v2 (Apache-2.0), q8 ONNX: the model the retrieval benchmark measured best. */
export const VECTOR_MODEL: VectorModelSpec = {
  id: `paraphrase-multilingual-MiniLM-L12-v2-q8@${REVISION.slice(0, 12)}`,
  label: "Multilingual search model (paraphrase-multilingual-MiniLM-L12-v2)",
  license: "Apache-2.0",
  files: [
    { name: "model_quantized.onnx", url: `${SOURCE}/onnx/model_quantized.onnx`, sha256: "66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc", bytes: 118308126 },
    { name: "tokenizer.json", url: `${SOURCE}/tokenizer.json`, sha256: "b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441", bytes: 17082913 },
  ],
};

/** The installed model's folder: `<Embeddings>/<model id>`, from the one path layout. */
export function vectorModelDir(spec: VectorModelSpec = VECTOR_MODEL, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(mkmnPaths(env).embeddingsDir, spec.id.replace(/[^A-Za-z0-9._@-]/g, "_"));
}

export interface VectorModelStatus {
  installed: boolean;
  /** The runtime that runs it ships with the app; false only in a build without it. */
  runtime: boolean;
  installing: boolean;
  bytes: number;
  label: string;
  error?: string;
  progress?: { done: number; of: number };
}

const runtimeAvailable = (): boolean => {
  try { require.resolve("onnxruntime-node"); return true; } catch { return false; }
};

/** Installed means every file is there with its pinned size (the hash was checked when it was written). */
export function vectorModelInstalled(dir: string = vectorModelDir(), spec: VectorModelSpec = VECTOR_MODEL): boolean {
  return spec.files.every((f) => { try { return statSync(path.join(dir, f.name)).size === f.bytes; } catch { return false; } });
}

let installing: Promise<VectorModelStatus> | null = null;
let lastError: string | undefined;
let progress: { done: number; of: number } | undefined;

export function vectorModelStatus(dir: string = vectorModelDir(), spec: VectorModelSpec = VECTOR_MODEL): VectorModelStatus {
  return {
    installed: vectorModelInstalled(dir, spec), runtime: runtimeAvailable(), installing: installing !== null,
    bytes: spec.files.reduce((n, f) => n + f.bytes, 0), label: spec.label,
    ...(lastError ? { error: lastError } : {}), ...(progress && installing ? { progress } : {}),
  };
}

/**
 * Downloads every file to a temporary name, hashing as it goes; only when all of them
 * match their pinned SHA-256 are they moved into place. One install at a time.
 */
export function installVectorModel(
  dir: string = vectorModelDir(), spec: VectorModelSpec = VECTOR_MODEL,
  fetchImpl: typeof fetch = fetch,
): Promise<VectorModelStatus> {
  if (installing) return installing;
  lastError = undefined;
  const total = spec.files.reduce((n, f) => n + f.bytes, 0);
  progress = { done: 0, of: total };
  installing = (async () => {
    const temps: string[] = [];
    try {
      mkdirSync(dir, { recursive: true });
      let before = 0;
      for (const f of spec.files) {
        const tmp = path.join(dir, `${f.name}.${process.pid}.download`);
        temps.push(tmp);
        const res = await fetchImpl(f.url);
        if (!res.ok || !res.body) throw new Error(`${f.name}: the download answered ${res.status}`);
        const hash = createHash("sha256");
        let got = 0;
        const counted = Readable.fromWeb(res.body as never).on("data", (chunk: Buffer) => {
          hash.update(chunk);
          got += chunk.length;
          progress = { done: before + got, of: total };
        });
        await pipeline(counted, createWriteStream(tmp));
        const digest = hash.digest("hex");
        if (digest !== f.sha256 || got !== f.bytes) throw new Error(`${f.name} did not match its published fingerprint (got ${got} bytes, SHA-256 ${digest.slice(0, 12)}…); nothing was installed`);
        before += f.bytes;
      }
      spec.files.forEach((f, i) => renameSync(temps[i], path.join(dir, f.name)));
      opened.delete(dir);
      return vectorModelStatus(dir, spec);
    } catch (e) {
      lastError = (e as Error).message;
      for (const t of temps) rmSync(t, { force: true });
      return { ...vectorModelStatus(dir, spec), error: lastError };
    } finally {
      installing = null;
      progress = undefined;
    }
  })();
  return installing;
}

/** Removes the model's files; the projects' stored vectors of that model are simply never read again. */
export function removeVectorModel(dir: string = vectorModelDir(), spec: VectorModelSpec = VECTOR_MODEL): VectorModelStatus {
  if (installing) return { ...vectorModelStatus(dir, spec), error: "The model is being installed; try again when it is done." };
  opened.delete(dir);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  lastError = undefined;
  return vectorModelStatus(dir, spec);
}

const opened = new Map<string, Promise<Embedder | null>>();

/**
 * The embedder when the model is installed and its runtime loads, else null (the
 * retrieval then keeps its BM25 and rewrite path). Opened once per process.
 */
export function vectorEmbedder(dir: string = vectorModelDir(), spec: VectorModelSpec = VECTOR_MODEL): Promise<Embedder | null> {
  if (!vectorModelInstalled(dir, spec) || !runtimeAvailable()) return Promise.resolve(null);
  let p = opened.get(dir);
  if (!p) {
    p = openOnnxEmbedder(dir, spec.id).catch((e) => {
      console.error(`[knowledge] the multilingual search model could not be opened: ${(e as Error).message}`);
      opened.delete(dir);
      return null;
    });
    opened.set(dir, p);
  }
  return p;
}
