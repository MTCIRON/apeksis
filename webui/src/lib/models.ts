// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The speech models the user can choose from. Files live under
// VITE_MODELS_BASE_URL (default /models) in each model's directory.

export type ModelId = "seda" | "duyu" | "whisper-turbo" | "whisper-turbo-q4";

export const MODELS_BASE = (import.meta.env.VITE_MODELS_BASE_URL || "/models").replace(/\/+$/, "");

export interface ModelInfo {
  id: ModelId;
  /** Which engine runs it. */
  engine: "seda" | "duyu" | "whisper";
  name: string;
  /** Short tag next to the name. */
  tier: string;
  note: string;
  /** Approximate first download, ONNX runtime included. */
  size: string;
  /** Model and weight precision, for the inspector and exports. */
  spec: string;
  dir: string;
  /**
   * Files listed in the directory's model.json, downloaded and cached.
   * Whisper: encoder, decoder, vocab, VAD, in this order.
   */
  files: string[];
  link: string;
  /** Streams with low latency, so it can transcribe the microphone. */
  live: boolean;
  /** Needs WebGPU. */
  gpuOnly: boolean;
  /** Always runs on the CPU (WASM), whatever the provider choice. */
  cpuOnly: boolean;
  /** Needs 16-bit float shaders (shader-f16) on the GPU. */
  needsF16: boolean;
  /** Writes punctuation and capitals itself. */
  punctuates: boolean;
}

/** Lightest first, as the menu lists them. */
export const MODELS: ModelInfo[] = [
  {
    id: "seda",
    engine: "seda",
    name: "Seda",
    tier: "Hızlı",
    note: "Küçük ve hızlı; canlı kayıtta ve her cihazda çalışır.",
    size: "105 MB",
    spec: "seda-v0.1",
    dir: "seda-v0.1",
    files: ["encoder.webgpu.onnx", "decoder.onnx", "joiner.int8.onnx", "rnnlm.int8.onnx", "lodr.bin", "tokens.txt"],
    link: "https://huggingface.co/atasoglu/seda-v0.1",
    live: true,
    gpuOnly: false,
    cpuOnly: false,
    needsF16: false,
    punctuates: false,
  },
  {
    id: "duyu",
    engine: "duyu",
    name: "Duyu",
    tier: "Hafif",
    note: "Küçük; noktalama ve büyük harfi kendisi yazar. İşlemcide çalışır; canlı kayıtta kullanılmaz.",
    size: "85 MB",
    spec: "Duyu-small (int8)",
    dir: "duyu-small",
    files: ["encoder_pre.onnx", "encoder_pass.onnx", "encoder_post.onnx", "decoder.onnx", "fbank.bin", "tokens.json"],
    link: "https://huggingface.co/KaanAydinli/Duyu-small",
    live: false,
    gpuOnly: false,
    cpuOnly: true,
    needsF16: false,
    punctuates: true,
  },
  {
    id: "whisper-turbo-q4",
    engine: "whisper",
    name: "Whisper Turbo Hafif",
    tier: "Daha küçük",
    note: "Whisper Turbo'nun 4 bitlik hâli: üçte bir boyutta, zor seste biraz daha fazla hata. Ekran kartı gerekir; canlı kayıtta kullanılmaz.",
    size: "600 MB",
    spec: "whisper-large-v3-turbo (q4f16 encoder, q4f16 decoder)",
    dir: "whisper-large-v3-turbo",
    files: ["encoder_model_q4f16.onnx", "decoder_model_merged_q4f16.onnx", "vocab.json", "silero_vad.onnx"],
    link: "https://huggingface.co/openai/whisper-large-v3-turbo",
    live: false,
    gpuOnly: true,
    cpuOnly: false,
    needsF16: true,
    punctuates: true,
  },
  {
    id: "whisper-turbo",
    engine: "whisper",
    name: "Whisper Turbo",
    tier: "Yüksek doğruluk",
    note: "En az hata, noktalama ve rakamlarla yazar. Büyük indirme, ekran kartı gerekir; canlı kayıtta kullanılmaz.",
    size: "1,5 GB",
    spec: "whisper-large-v3-turbo (fp16 encoder, q4f16 decoder)",
    dir: "whisper-large-v3-turbo",
    files: ["encoder_model_fp16.onnx", "decoder_model_merged_q4f16.onnx", "vocab.json", "silero_vad.onnx"],
    link: "https://huggingface.co/openai/whisper-large-v3-turbo",
    live: false,
    gpuOnly: true,
    cpuOnly: false,
    needsF16: true,
    punctuates: true,
  },
];

export const DEFAULT_MODEL: ModelId = "seda";

export const modelInfo = (id: ModelId): ModelInfo => MODELS.find((m) => m.id === id) ?? MODELS[0];

export const isModelId = (v: unknown): v is ModelId => MODELS.some((m) => m.id === v);

export const modelFileUrl = (m: ModelInfo, file: string) => `${MODELS_BASE}/${m.dir}/${file}`;

// ---- every downloadable model ----

export type PackKind = "asr" | "punct" | "mt" | "tts";

/**
 * A set of files downloaded together: a speech model above, or one of the
 * helpers below. Settings lists these; the workers load them by the same dir
 * and file names.
 */
export interface ModelPack {
  id: string;
  kind: PackKind;
  name: string;
  note: string;
  dir: string;
  /** The directory's manifest; its `files` gives each file's exact size. */
  manifest: string;
  files: string[];
  gpuOnly: boolean;
  needsF16: boolean;
}

export const PUNCT_PACK: ModelPack = {
  id: "punct",
  kind: "punct",
  name: "Noktalama",
  note: "Seda'nın dökümüne nokta, virgül ve büyük harf ekler.",
  dir: "punct",
  manifest: "punct.json",
  files: ["punct.int8.onnx", "spm.json"],
  gpuOnly: false,
  needsF16: false,
};

export const MT_PACK: ModelPack = {
  id: "mt",
  kind: "mt",
  name: "İngilizce çeviri",
  note: "opus-mt-tc-big-tr-en; transkripti cümle cümle İngilizceye çevirir.",
  dir: "opus-mt-tc-big-tr-en",
  manifest: "model.json",
  files: ["encoder.int8.onnx", "decoder.int8.onnx", "spm.json"],
  gpuOnly: false,
  needsF16: false,
};

/** Dubbing voices; the file order is the order the TTS worker takes them in. */
export const VOICE_PACKS = {
  ema: {
    id: "tts-ema",
    kind: "tts",
    name: "EMA Lightning",
    note: "Seslendirme sesi.",
    dir: "ema-lightning",
    manifest: "model.json",
    files: ["text.onnx", "sound.onnx", "decoder.onnx", "normalizer.wasm"],
    gpuOnly: false,
    needsF16: false,
  },
  mini: {
    id: "tts-mini",
    kind: "tts",
    name: "Antalia Mini",
    note: "Seslendirme sesi; ekran kartı olmadan da hızlı.",
    dir: "antalia-mini",
    manifest: "model.json",
    files: ["text.onnx", "cond.onnx", "flow.onnx", "vocoder.fp16.onnx", "frontend-data.json.gz"],
    gpuOnly: false,
    needsF16: false,
  },
} satisfies Record<string, ModelPack>;

export const PACKS: ModelPack[] = [
  ...MODELS.map(
    (m): ModelPack => ({
      id: m.id,
      kind: "asr",
      name: m.name,
      note: m.note,
      dir: m.dir,
      manifest: "model.json",
      files: m.files,
      gpuOnly: m.gpuOnly,
      needsF16: m.needsF16,
    }),
  ),
  PUNCT_PACK,
  MT_PACK,
  VOICE_PACKS.ema,
  VOICE_PACKS.mini,
];

export const packFileUrl = (p: ModelPack, file: string) => `${MODELS_BASE}/${p.dir}/${file}`;
