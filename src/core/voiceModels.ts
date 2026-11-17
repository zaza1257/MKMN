import { VoiceModel, VoiceSettings } from "../shared/types";
import { voiceSettings as readVoiceSettings } from "../shared/settingsSchema";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

/**
 * Speech models, run by sherpa-onnx in a separate process. Each one has its own CPU / NPU switch:
 * CPU leaves the NPU to the chat model; NPU is faster when the memory budget (core/budget.ts) allows
 * chat + dictation + read-aloud to sit there together. An NPU load that fails falls back to the CPU.
 * Each archive is pinned by its SHA-256 and exact size (src/core/voiceInstall.ts refuses any other
 * file). Pinned 2026-11-17: six from the digests GitHub publishes for the release assets, five
 * (Whisper, Moonshine) hashed from a download here; Piper Amy was hashed both ways and matched.
 * When upstream re-uploads an archive (Kokoro and Parakeet were in Oct/Nov 2026), its pin must change.
 */
export const VOICE_MODELS: VoiceModel[] = [
  // ----- dictation (speech to text)
  { id: "stt-whisper-base", kind: "stt", name: "Whisper base (multilingual)", family: "whisper", archive: "sherpa-onnx-whisper-base", sizeMB: 208, sha256: "911b2083efd7c0dca2ac3b358b75222660dc09fb716d64fbfc417ba6c99ff3de", bytes: 207557382, languages: "99 languages", note: "Good default: small, handles many languages and auto-detects.", default: true },
  { id: "stt-whisper-tiny", kind: "stt", name: "Whisper tiny (multilingual)", family: "whisper", archive: "sherpa-onnx-whisper-tiny", sizeMB: 116, sha256: "c46116994e539aa165266d96b325252728429c12535eb9d8b6a2b10f129e66b1", bytes: 116204861, languages: "99 languages", note: "Fastest Whisper; more mistakes." },
  { id: "stt-whisper-small", kind: "stt", name: "Whisper small (multilingual)", family: "whisper", archive: "sherpa-onnx-whisper-small", sizeMB: 639, sha256: "486a46afbb7ba798507190ffe02fea2dd726049af212e774537efac6afb210a6", bytes: 639387718, languages: "99 languages", note: "More accurate, slower on CPU." },
  { id: "stt-moonshine-base-en", kind: "stt", name: "Moonshine base (English)", family: "moonshine", archive: "sherpa-onnx-moonshine-base-en-int8", sizeMB: 251, sha256: "21870cecaa2e44e4e2bf63e02d1072bed183ccd10284871353bd9d24dad14e5e", bytes: 250807309, languages: "English", note: "Built for live use: short audio is decoded fast." },
  { id: "stt-moonshine-tiny-en", kind: "stt", name: "Moonshine tiny (English)", family: "moonshine", archive: "sherpa-onnx-moonshine-tiny-en-int8", sizeMB: 108, sha256: "d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2", bytes: 107600538, languages: "English", note: "Smallest and quickest." },
  { id: "stt-parakeet-v3", kind: "stt", name: "Parakeet TDT 0.6B v3", family: "transducer", archive: "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8", sizeMB: 487, sha256: "1495e91b59d7fc53ddca91f3431758ec99f8fa253fdb0e1e851be0f72b14b0f9", bytes: 487211443, languages: "25 European languages", note: "Best accuracy here, but the largest; uses ~1 GB of RAM." },

  // ----- read aloud (text to speech)
  {
    id: "tts-kokoro-multi-full", kind: "tts", name: "Kokoro (multilingual, full quality)", family: "kokoro", archive: "kokoro-multi-lang-v1_1", sizeMB: 365, sha256: "b78e1ac42b852e839cceaafbe88f66806bf5860992d1d7b9a3f2ad1198427aed", bytes: 364855331,
    languages: "English and other languages", note: "The same voice without the int8 compression: cleaner and less muffled. Default.", default: true, sidCount: 103
  },
  {
    id: "tts-kokoro-multi", kind: "tts", name: "Kokoro (multilingual, int8)", family: "kokoro", archive: "kokoro-int8-multi-lang-v1_1", sizeMB: 147, sha256: "259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c", bytes: 147052523,
    languages: "English and other languages", note: "Compressed: a third of the size, a slightly degraded sound.", sidCount: 103
  },
  {
    id: "tts-kokoro-en", kind: "tts", name: "Kokoro (English v0.19)", family: "kokoro", archive: "kokoro-en-v0_19", sizeMB: 320, sha256: "912804855a04745fa77a30be545b3f9a5d15c4d66db00b88cbcd4921df605ac7", bytes: 319625534, languages: "English", note: "The original Kokoro: English only, named voices.",
    voices: [
      { sid: 0, name: "Default" }, { sid: 1, name: "Bella" }, { sid: 2, name: "Nicole" }, { sid: 3, name: "Sarah" }, { sid: 4, name: "Sky" },
      { sid: 5, name: "Adam" }, { sid: 6, name: "Michael" }, { sid: 7, name: "Emma (UK)" }, { sid: 8, name: "Isabella (UK)" }, { sid: 9, name: "George (UK)" }, { sid: 10, name: "Lewis (UK)" }
    ]
  },
  { id: "tts-piper-en-lessac-high", kind: "tts", name: "Piper Lessac (English, high quality)", family: "vits", archive: "vits-piper-en_US-lessac-high", sizeMB: 116, sha256: "8619d204c7005866fe4f420181dfa79622af6a6222389f0b0818d2af31e0db0e", bytes: 115545841, languages: "English", note: "The high-quality Piper build: clear and steady." },
  { id: "tts-piper-en", kind: "tts", name: "Piper Amy (English)", family: "vits", archive: "vits-piper-en_US-amy-low", sizeMB: 67, sha256: "c70f5284a09a7fd4ed203b39b2ff51cac1432b422b852eb647b481dade3cf639", bytes: 67095344, languages: "English", note: "Very light and fast, flatter than Kokoro." }
];

export function voiceModelUrl(m: VoiceModel): string {
  return `${RELEASES}/${m.kind === "stt" ? "asr-models" : "tts-models"}/${m.archive}.tar.bz2`;
}

export function voiceModel(id: string | null | undefined): VoiceModel | undefined {
  return VOICE_MODELS.find((m) => m.id === id);
}

export function defaultVoiceModel(kind: "stt" | "tts"): VoiceModel {
  return VOICE_MODELS.find((m) => m.kind === kind && m.default)!;
}

/** The voice defaults, built from the ONE declaration (the settings schema):
 *  this was a hand-copied literal whose 20 keys the Rust host's fresh-file
 *  default only half knew — it materialized 10 of them, so a fresh settings
 *  file lacked the other 10 until a voice control wrote them. Kept as the same
 *  name so the readers stay put. */
export const DEFAULT_VOICE_SETTINGS: VoiceSettings = readVoiceSettings(null);

/** The range each microphone setting can take: the settings page and the saved values are held to it. */
export const VOICE_LIMITS = {
  minLevel: { min: 0.002, max: 0.125 },
  minSpeechMs: { min: 80, max: 2000 },
  endSilenceMs: { min: 200, max: 4000 },
  waitMs: { min: 500, max: 10000 },
  interruptLevel: { min: 0.01, max: 0.125 },
  interruptMs: { min: 200, max: 4000 }
} as const;

export function clampVoice<K extends keyof typeof VOICE_LIMITS>(key: K, v: number): number {
  const l = VOICE_LIMITS[key];
  return Math.min(l.max, Math.max(l.min, Number.isFinite(v) ? v : DEFAULT_VOICE_SETTINGS[key]));
}

// ---------------------------------------------------------------- sherpa-onnx configs

/** Paths found in an extracted model folder; directories end with "/". */
export type FileList = string[];

function pick(files: FileList, re: RegExp, preferInt8 = true): string | undefined {
  const hits = files.filter((f) => re.test(f.replace(/\\/g, "/").split("/").pop()!));
  if (!hits.length) return undefined;
  if (preferInt8) {
    const q = hits.find((f) => /int8/i.test(f));
    if (q) return q;
  }
  return hits.sort((a, b) => a.length - b.length)[0];
}

function need(v: string | undefined, what: string): string {
  if (!v) throw new Error(`Voice model folder is missing ${what}. Delete the model and download it again.`);
  return v;
}

const THREADS = 4;

/** sherpa-onnx provider name for a compute target. "qnn" is the Qualcomm NPU execution provider. */
export const providerFor = (c: "cpu" | "npu") => (c === "npu" ? "qnn" : "cpu");

/** Recognizer config for sherpa-onnx-node. */
export function sttConfig(m: VoiceModel, files: FileList, language = "", compute: "cpu" | "npu" = "cpu"): Record<string, unknown> {
  const tokens = need(pick(files, /tokens\.txt$/, false), "tokens.txt");
  const base = { tokens, numThreads: THREADS, provider: providerFor(compute), debug: 0 };
  const feat = { sampleRate: 16000, featureDim: 80 };
  switch (m.family) {
    case "whisper":
      return {
        featConfig: feat,
        modelConfig: {
          ...base,
          whisper: {
            encoder: need(pick(files, /encoder.*\.onnx$/), "the encoder"),
            decoder: need(pick(files, /decoder.*\.onnx$/), "the decoder"),
            language: m.id.includes("-en") ? "en" : language,
            task: "transcribe",
            tailPaddings: -1
          }
        }
      };
    case "moonshine":
      return {
        featConfig: feat,
        modelConfig: {
          ...base,
          moonshine: {
            preprocessor: need(pick(files, /preprocess.*\.onnx$/), "the preprocessor"),
            encoder: need(pick(files, /^encode.*\.onnx$/), "the encoder"),
            uncachedDecoder: need(pick(files, /uncached_decode.*\.onnx$/), "the uncached decoder"),
            cachedDecoder: need(pick(files, /^cached_decode.*\.onnx$/), "the cached decoder")
          }
        }
      };
    case "transducer":
      return {
        featConfig: feat,
        modelConfig: {
          ...base,
          transducer: {
            encoder: need(pick(files, /^encoder.*\.onnx$/), "the encoder"),
            decoder: need(pick(files, /^decoder.*\.onnx$/), "the decoder"),
            joiner: need(pick(files, /^joiner.*\.onnx$/), "the joiner")
          },
          modelType: "nemo_transducer"
        }
      };
    default:
      throw new Error(`${m.family} is not a speech-to-text family`);
  }
}

export function ttsConfig(m: VoiceModel, files: FileList, compute: "cpu" | "npu" = "cpu"): Record<string, unknown> {
  const tokens = need(pick(files, /tokens\.txt$/, false), "tokens.txt");
  const dataDir = files.find((f) => /(^|[\\/])espeak-ng-data[\\/]?$/.test(f));
  const common = { numThreads: THREADS, provider: providerFor(compute), debug: 0, maxNumSentences: 1 };
  if (m.family === "kokoro") {
    const lexicons = files.filter((f) => /lexicon.*\.txt$/.test(f.split(/[\\/]/).pop()!));
    return {
      ...common,
      model: {
        ...common,
        kokoro: {
          model: need(pick(files, /^model.*\.onnx$/), "the model"),
          voices: need(pick(files, /^voices\.bin$/, false), "voices.bin"),
          tokens,
          ...(dataDir ? { dataDir: dataDir.replace(/[\\/]$/, "") } : {}),
          ...(lexicons.length ? { lexicon: lexicons.join(",") } : {})
        }
      }
    };
  }
  if (m.family === "vits") {
    const model = need(files.find((f) => /\.onnx$/.test(f) && !/int8/.test(f)) ?? pick(files, /\.onnx$/), "the model");
    return {
      ...common,
      model: { ...common, vits: { model, tokens, ...(dataDir ? { dataDir: dataDir.replace(/[\\/]$/, "") } : {}) } }
    };
  }
  throw new Error(`${m.family} is not a text-to-speech family`);
}
