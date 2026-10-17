// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Server dubbing — the "sunucu" provider of the one "Seslendir" action
// (docs/merge-plan-2-integration.md, Aşama 6).
//
// `POST /v1/audio/speech` returns one clip per request. Asking for `pcm` at
// 48 kHz (`sample_rate: 48000`, the gateway's own maximum) gives raw
// `pcm_s16le` that needs NO decoding and NO resampling — the studio's dubbing
// rate is exactly 48 kHz (`studio/tts/ema.ts`). Each line becomes a `DubClip`
// at its own start time, so the server dub lands in the SAME `dubWav` blob, the
// same playback path and the same WAV download as a browser dub.

import { ApiError, synthesizeSpeech } from "../../api/client";
import { RATE } from "../tts/ema";
import type { DubClip } from "../tts/dub";
import type { DubLine } from "../worker/tts.worker";

export interface ServerDubOptions {
  model: string;
  voice: string;
  /** 0.25..4, the gateway's own range. */
  speed: number;
  signal?: AbortSignal;
  /** Lines finished / total, for the progress meter. */
  onProgress?: (done: number, total: number) => void;
}

/** A message the panel can show as-is. */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const req = error.requestId ? ` · ${error.requestId}` : "";
    if (error.status === 401 || error.status === 403) {
      return `Sunucu anahtarı reddedildi (${error.status}); Ayarlar → Sunucu'dan geçerli anahtarı gir.${req}`;
    }
    if (error.status === 0) return `Sunucuya ulaşılamadı: ${error.message}${req}`;
    return `Sunucu ${error.status} · ${error.code}: ${error.message}${req}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** `pcm_s16le` (little-endian) → mono Float32 in -1..1. */
function pcmToFloat(bytes: ArrayBuffer): Float32Array {
  const view = new DataView(bytes);
  const frames = Math.floor(bytes.byteLength / 2);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** One line of speech from the server, as mono Float32 at `RATE`. */
export async function serverSpeech(
  text: string,
  options: Pick<ServerDubOptions, "model" | "voice" | "speed" | "signal">,
): Promise<Float32Array> {
  let blob: Blob;
  try {
    ({ blob } = await synthesizeSpeech({
      model: options.model,
      voice: options.voice,
      input: text,
      response_format: "pcm",
      sample_rate: RATE,
      speed: options.speed,
    }));
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(describe(error));
  }
  const audio = pcmToFloat(await blob.arrayBuffer());
  if (!audio.length) throw new Error("Sunucu boş ses döndürdü.");
  return audio;
}

/**
 * One server request per caption line; the clips sit at the same start times the
 * browser dub uses. A line the server cannot read fails the whole run (rather
 * than silently dropping a sentence).
 */
export async function serverDubLines(lines: DubLine[], options: ServerDubOptions): Promise<DubClip[]> {
  const clips: DubClip[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i].text.trim();
    if (text) {
      const audio = await serverSpeech(text, options);
      clips.push({ start: lines[i].start, audio });
    }
    options.onProgress?.(i + 1, lines.length);
  }
  if (!clips.length) throw new Error("Seslendirilecek satır yok.");
  return clips;
}
