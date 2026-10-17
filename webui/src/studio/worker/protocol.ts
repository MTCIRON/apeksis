// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { DecodeOptions, Word } from "../engine";
import type { ModelId } from "../models";

export type ProviderChoice = "auto" | "webgpu" | "wasm";

/**
 * Where a capability runs: the browser engines above, or the Voxi server.
 *
 * The merge turns "which program" into this single axis (docs/merge-plan-2-integration.md):
 * a server run produces the SAME job, transcript and timeline as a browser run,
 * so the user only chooses where the work happens.
 */
export type SttProvider = ProviderChoice | "sunucu";

/**
 * Where transcription runs when the user has not chosen: the Apeksis server.
 *
 * The UI is served by the gateway deployment (nginx serves /ui and proxies /v1
 * on the same origin), so the server path works on the very first run — while
 * the browser packs still need a download. "Tarayıcı" is one click away and the
 * choice is remembered (`apeksis.provider`).
 */
export const DEFAULT_STT_PROVIDER: SttProvider = "sunucu";

/** The stored provider, else the default. Nothing (or nonsense) is the default,
 *  never a value the worker would not understand. */
export function providerOrDefault(raw: string | null): SttProvider {
  return raw === "auto" || raw === "webgpu" || raw === "wasm" || raw === "sunucu"
    ? raw
    : DEFAULT_STT_PROVIDER;
}

export type ToWorker =
  /** Load the model. `reason`: why the page chose the CPU, shown once ready. */
  | { type: "init"; model: ModelId; provider: ProviderChoice; reason?: string }
  /** `startAt`: seconds into the file to start from (continuing a stopped job); times stay absolute. */
  | { type: "transcribe"; jobId: number; file: File; options: DecodeOptions; startAt?: number }
  | {
      type: "transcribe-pcm";
      jobId: number;
      pcm: Float32Array;
      sampleRate: number;
      options: DecodeOptions;
      startAt?: number;
    }
  | { type: "cancel"; jobId: number }
  /** Live microphone: audio arrives in chunks until live-stop. */
  | { type: "live-start"; jobId: number; sampleRate: number; options: DecodeOptions }
  | { type: "live-audio"; jobId: number; pcm: Float32Array }
  | { type: "live-stop"; jobId: number }
  /** Punctuate and true-case plain words (one entry per transcript word). */
  | { type: "punctuate"; id: number; words: string[] };

/** `gpu`: WebGPU failed; the page restarts the worker on the CPU. */
export type ErrorCode = "decode-unsupported" | "no-audio" | "model" | "runtime" | "gpu";

export type FromWorker =
  | { type: "download"; loaded: number; total: number; fromCache: boolean }
  | { type: "compiling" }
  | {
      type: "ready";
      provider: "webgpu" | "wasm";
      gpu: string | null;
      fallbackReason: string | null;
    }
  | { type: "meta"; jobId: number; duration: number }
  | {
      type: "progress";
      jobId: number;
      decoded: number;
      committed: Word[];
      tentative: Word[];
      /** Peak amplitude per PEAK_STEP seconds, appended since the last message. */
      peaks: Float32Array;
      /** Aura bands (low, mid, high interleaved, BAND_RATE per second), appended. */
      bands: Float32Array;
      /** Speech loudness (one log-mel value per band frame), appended; for "Sesle vurgula". */
      loudness: Float32Array;
      speed: number;
    }
  | {
      type: "done";
      jobId: number;
      committed: Word[];
      decoded: number;
      elapsed: number;
      bands: Float32Array;
      loudness: Float32Array;
      timing: { encoder: number; search: number; chunks: number };
    }
  | { type: "cancelled"; jobId: number }
  | { type: "punct-progress"; id: number; phase: "download" | "run"; done: number; total: number }
  | { type: "punctuated"; id: number; words: string[] }
  | { type: "punct-error"; id: number; message: string }
  | { type: "error"; jobId: number | null; code: ErrorCode; message: string };

export const PEAK_STEP = 0.1;
export { BAND_RATE } from "../render/aura";
