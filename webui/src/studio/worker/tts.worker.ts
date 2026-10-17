/// <reference lib="webworker" />
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Dubbing: reads every caption line aloud with EMA Lightning or Antalia Mini and places it at the line's start time. A line that
// does not fit before the next one is spoken faster, up to MAX_SPEED; past that it runs over and the next line
// starts late. The voice's pitch is moved by synthesising at a matching speed and resampling, so it does not change
// how long a line takes.

import * as ort from "onnxruntime-web/webgpu";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import { packFileUrl, VOICE_PACKS } from "../models";
import type { DubClip } from "../tts/dub";
import { Ema, loadNormalizer, RATE, type EmaMeta } from "../tts/ema";
import { Mini, type MiniManifest } from "../tts/mini";
import { fetchAll } from "./modelStore";

declare const self: DedicatedWorkerGlobalScope;

export interface DubLine {
  start: number;
  end: number;
  text: string;
}

/** The text-to-speech models, both at 48 kHz. */
export type VoiceModel = "ema" | "mini";

export interface Voice {
  model: VoiceModel;
  /** Semitones; below 0 is deeper. */
  pitch: number;
  /** The same seed gives the same reading. */
  seed: number;
}

export type ToTts =
  | { type: "dub"; jobId: number; lines: DubLine[]; duration: number; voice: Voice }
  | { type: "preview"; jobId: number; text: string; voice: Voice }
  | { type: "cancel"; jobId: number };

export type FromTts =
  | { type: "download"; jobId: number; loaded: number; total: number }
  | { type: "progress"; jobId: number; done: number; total: number }
  | { type: "done"; jobId: number; clips: DubClip[]; elapsed: number }
  | { type: "preview"; jobId: number; audio: Float32Array }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/** Approximate; the real size is settled once the download finishes. */
const ORT_WASM_SIZE = 26_800_000;
const MAX_SPEED = 1.35;
/** Silence kept between two lines when the first one runs late. */
const GAP = 0.05;

const post = (m: FromTts, transfer: Transferable[] = []) => self.postMessage(m, transfer);
const cancelled = new Set<number>();

interface Speaker {
  speak(text: string, speed?: number, seed?: number): Promise<Float32Array>;
}

const speakers = new Map<VoiceModel, Promise<Speaker>>();
/** WebGPU adapter, or null for the CPU; set with the runtime, once, before the first session. */
let adapter: GPUAdapter | null | undefined;

async function load(jobId: number, model: VoiceModel): Promise<Speaker> {
  const pack = VOICE_PACKS[model];
  const res = await fetch(packFileUrl(pack, pack.manifest), { cache: "no-cache" });
  if (!res.ok)
    throw new Error(
      `Seslendirme paketi kurulu değil (models/${pack.dir}/, HTTP ${res.status}). ` +
        'Paketi sunucuya kurun ya da sağlayıcı olarak "Sunucu" seçin.',
    );
  const meta = await res.json();
  const names = pack.files;
  const runtime = adapter === undefined ? [{ url: ortWasmUrl, size: ORT_WASM_SIZE, approx: true }] : [];
  const files = await fetchAll(
    [...names.map((n) => ({ url: packFileUrl(pack, n), size: meta.files[n] as number })), ...runtime],
    (loaded, total) => post({ type: "download", jobId, loaded, total }),
  );

  if (adapter === undefined) {
    adapter = (await navigator.gpu?.requestAdapter().catch(() => null)) ?? null;
    ort.env.wasm.wasmBinary = files[names.length].buffer as ArrayBuffer;
    // See asr.worker.ts: wasm threads load this script, not the worker bundle.
    if (import.meta.env.PROD) ort.env.wasm.wasmPaths = { mjs: new URL(ortMjsUrl, self.location.href) };
    ort.env.wasm.numThreads =
      adapter || !self.crossOriginIsolated ? 1 : Math.max(1, Math.min(4, Math.ceil((navigator.hardwareConcurrency || 2) / 2)));
    ort.env.logLevel = "error";
  }

  const create = async (providers: string[]): Promise<Speaker> => {
    if (model === "mini") return Mini.load(ort, meta as MiniManifest, files.slice(0, names.length), providers);
    const [text, sound, decoder] = files;
    const opts = { executionProviders: providers, graphOptimizationLevel: "all" as const };
    // Sequential: the wasm runtime rejects concurrent initialisation.
    const sessions = {
      text: await ort.InferenceSession.create(text, opts),
      sound: await ort.InferenceSession.create(sound, opts),
      decoder: await ort.InferenceSession.create(decoder, opts),
    };
    return new Ema(ort, meta as EmaMeta, sessions, await loadNormalizer(files[3]));
  };
  try {
    return await create(adapter ? ["webgpu", "wasm"] : ["wasm"]);
  } catch (e) {
    if (!adapter) throw e;
    console.warn("WebGPU session failed, using the CPU", e);
    return create(["wasm"]);
  }
}

/** Loaded once per model; both stay loaded, they are small. */
function getSpeaker(jobId: number, model: VoiceModel) {
  let p = speakers.get(model);
  if (!p) {
    p = load(jobId, model);
    speakers.set(model, p);
    p.catch(() => speakers.delete(model));
  }
  return p;
}

/** Plays `x` `ratio` times faster by linear interpolation: higher and shorter above 1. */
function resample(x: Float32Array, ratio: number): Float32Array {
  if (ratio === 1 || x.length < 2) return x;
  const y = new Float32Array(Math.floor((x.length - 1) / ratio) + 1);
  for (let k = 0; k < y.length; k++) {
    const pos = k * ratio;
    const i = Math.floor(pos);
    const b = i + 1 < x.length ? x[i + 1] : x[i];
    y[k] = x[i] + (b - x[i]) * (pos - i);
  }
  return y;
}

/** `speed` above 1 speaks faster; the pitch shift leaves the length as it would be without it. */
async function speak(speaker: Speaker, text: string, voice: Voice, speed = 1) {
  const ratio = 2 ** (voice.pitch / 12);
  return resample(await speaker.speak(text, speed / ratio, voice.seed), ratio);
}

async function dub(jobId: number, lines: DubLine[], duration: number, voice: Voice) {
  const started = performance.now();
  const speaker = await getSpeaker(jobId, voice.model);
  const clips: DubClip[] = [];
  let free = 0; // where the previous clip ends
  for (let i = 0; i < lines.length; i++) {
    if (cancelled.has(jobId)) return post({ type: "cancelled", jobId });
    post({ type: "progress", jobId, done: i, total: lines.length });
    const line = lines[i];
    const start = Math.max(line.start, free);
    const room = (i + 1 < lines.length ? lines[i + 1].start : Math.max(duration, line.end)) - start;
    let audio = await speak(speaker, line.text, voice);
    const seconds = audio.length / RATE;
    if (seconds > room && room > 0) audio = await speak(speaker, line.text, voice, Math.min(MAX_SPEED, seconds / room));
    if (!audio.length) continue;
    clips.push({ start, audio });
    free = start + audio.length / RATE + GAP;
  }
  post(
    { type: "done", jobId, clips, elapsed: (performance.now() - started) / 1000 },
    clips.map((c) => c.audio.buffer as ArrayBuffer),
  );
}

self.onmessage = (ev: MessageEvent<ToTts>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    return;
  }
  const job =
    m.type === "dub"
      ? dub(m.jobId, m.lines, m.duration, m.voice)
      : getSpeaker(m.jobId, m.voice.model)
          .then((speaker) => speak(speaker, m.text, m.voice))
          .then((audio) => post({ type: "preview", jobId: m.jobId, audio }, [audio.buffer as ArrayBuffer]));
  job
    .catch((e) => post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) }))
    .finally(() => cancelled.delete(m.jobId));
};
