// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Live server transcription — the "sunucu" provider for the microphone
// (docs/merge-plan-2-integration.md, Aşama 9).
//
// The file path (`serverEngine.ts`) is one request per file. Live capture has no
// file: the microphone PCM goes up `WS /v1/realtime/transcriptions`, the server's
// VAD cuts it into utterances and each final utterance comes back with the
// server's own `speech.started` / `speech.ended` span. That real span becomes the
// words of the utterance; the first one is marked `cue`, the same flag an
// imported subtitle line uses, so the caption grouping keeps the server's line
// breaks. Inside that span the words are spread evenly — the streaming protocol
// reports no per-word times, and this is exactly what a subtitle import already
// does (see `importVoxiProjects.ts`). Nothing else is invented.
//
// The waveform is a different matter: the audio is in our hands, so peaks, aura
// bands and loudness are measured locally from the microphone, never guessed
// from the transcript. Blocks are 100 ms, the timeline's own peak step.

import { mintSocketTicket } from "../../api/client";
import { connectStt, type SttSampleRate } from "../../api/stream";
import { floatTo16BitPcm, resampleLinear } from "../../lib/audio";
import { BAND_RATE, PEAK_STEP } from "../worker/protocol";
import { LiveMeter } from "../render/aura";
import { startMicrophone, type Microphone } from "./microphone";
import type { Word } from "../engine";

/** One 100 ms block of microphone audio, measured locally. */
export interface AudioBlock {
  peak: number;
  low: number;
  mid: number;
  high: number;
  /** RMS of the block, 0..1 — the same scale as the worker's loudness. */
  loudness: number;
}

export interface ServerLiveEvents {
  /** Text of the utterance being spoken right now; the span is the live cursor. */
  onPartial: (text: string, start: number, end: number) => void;
  /** A finished utterance: its words, inside the server's own span. */
  onFinal: (words: Word[]) => void;
  /** One block of microphone audio. */
  onAudio: (block: AudioBlock) => void;
  /** The meter, once the microphone rate is known — the aura and timeline read it. */
  onMeter: (meter: LiveMeter) => void;
  /** The socket or the microphone failed; the message is user-readable. */
  onError: (message: string) => void;
}

export interface ServerLive {
  /** Seconds of microphone audio captured so far. */
  readonly decoded: number;
  /** Seconds since the microphone opened. */
  readonly elapsed: number;
  /** Stop the microphone and close the socket; resolves with the recording. */
  stop: () => Promise<File | null>;
}

/** Milliseconds → seconds; anything unusable becomes 0. */
const sec = (ms: number) => (Number.isFinite(ms) && ms > 0 ? ms / 1000 : 0);

function rms(pcm: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return pcm.length ? Math.min(1, Math.sqrt(sum / pcm.length)) : 0;
}

/**
 * Turn one server utterance into words.
 *
 * `text` is the final transcript; `start` and `end` are the server's own VAD
 * span in seconds. The words are spread evenly inside that span (the protocol
 * has no per-word times) and the first one is marked `cue`, so the caption
 * grouping keeps the server's line break instead of re-splitting the sentence.
 */
export function wordsFromUtterance(text: string, start: number, end: number): Word[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const span = Math.max(0, end - start);
  const step = span / tokens.length;
  return tokens.map((t, i) => ({
    text: t,
    start: start + i * step,
    end: start + (i + 1) * step,
    ...(i === 0 ? { cue: true as const } : {}),
  }));
}

/** Frames of band/loudness data one 100 ms block fills at `BAND_RATE`. */
export const AUDIO_FRAMES_PER_BLOCK = Math.max(1, Math.round(BAND_RATE * PEAK_STEP));

/** How long to wait for `session.started` before giving up on the socket. */
const HANDSHAKE_MS = 10_000;
/** How long to keep listening after `session.stop` so the last utterance lands. */
const FLUSH_MS = 1500;

export async function startServerLive(
  events: ServerLiveEvents,
  options: { language: string; sampleRate?: SttSampleRate; model?: string },
): Promise<ServerLive> {
  const sampleRate: SttSampleRate = options.sampleRate ?? 16000;
  const { ticket } = await mintSocketTicket("audio:write");

  /** Server-side VAD span per utterance, in milliseconds. */
  const speeches = new Map<string, { startMs: number; endMs: number }>();
  let handshake: { resolve: () => void; reject: (e: Error) => void } | null = null;
  let ended: (() => void) | null = null;
  let stopping = false;
  let blocks = 0;
  let utteranceStart = 0;
  let startedAt = 0;
  let meter: LiveMeter | null = null;

  const failHandshake = (e: Error) => {
    const h = handshake;
    handshake = null;
    h?.reject(e);
  };

  const conn = connectStt(
    { model: options.model ?? "whisper-1", language: options.language, sampleRate },
    {
      onOpen: () => {},
      onStarted: () => {
        const h = handshake;
        handshake = null;
        h?.resolve();
      },
      onSpeechStarted: (id, startedMs) => {
        speeches.set(id, { startMs: startedMs, endMs: startedMs });
        utteranceStart = sec(startedMs);
      },
      onPartial: (_id, text) => events.onPartial(text, utteranceStart, blocks * PEAK_STEP),
      onSpeechEnded: (id, info) => {
        const s = speeches.get(id);
        if (s) s.endMs = info.endedMs;
      },
      onFinal: (e) => {
        const s = speeches.get(e.utteranceId);
        speeches.delete(e.utteranceId);
        const start = sec(s?.startMs ?? 0);
        const end = Math.max(start, s ? sec(s.endMs) : start + sec(e.durationMs));
        events.onPartial("", start, end);
        const words = wordsFromUtterance(e.text, start, end);
        if (words.length) events.onFinal(words);
      },
      onError: (code, message) => events.onError(message || `Sunucu akışı hatası (${code}).`),
      onSessionEnded: () => ended?.(),
      onClose: () => {
        ended?.();
        if (!stopping) failHandshake(new Error("Sunucu ses akışı kapandı; yetki anahtarını denetle."));
      },
    },
    ticket,
  );

  const connected = new Promise<void>((resolve, reject) => {
    handshake = { resolve, reject };
  });
  const timeout = setTimeout(() => failHandshake(new Error("Sunucu ses akışı yanıt vermedi.")), HANDSHAKE_MS);
  try {
    await connected;
  } catch (e) {
    conn.close();
    throw e;
  } finally {
    clearTimeout(timeout);
  }

  // The microphone opens only after the handshake: PCM sent earlier would be
  // dropped by `sendPcm` and the user would lose the first words.
  let rate = 0;
  let mic: Microphone;
  try {
    mic = await startMicrophone((pcm) => {
      if (!meter || !rate) return;
      meter.push(pcm);
      blocks++;
      const levels = meter.levels;
      events.onAudio({
        peak: meter.peaks[meter.peaks.length - 1] ?? 0,
        low: levels.low,
        mid: levels.mid,
        high: levels.high,
        loudness: rms(pcm),
      });
      const resampled = resampleLinear(pcm, rate, sampleRate);
      const i16 = new Int16Array(resampled.length);
      floatTo16BitPcm(resampled, i16);
      conn.sendPcm(i16.buffer);
    });
  } catch (e) {
    // No microphone: do not leave the socket hanging open.
    stopping = true;
    conn.close();
    throw e;
  }
  rate = mic.sampleRate;
  meter = new LiveMeter(rate);
  startedAt = performance.now();
  events.onMeter(meter);

  return {
    get decoded() {
      return blocks * PEAK_STEP;
    },
    get elapsed() {
      return startedAt ? (performance.now() - startedAt) / 1000 : 0;
    },
    async stop() {
      stopping = true;
      conn.stop(); // session.stop: the server flushes whatever is still open
      await new Promise<void>((resolve) => {
        ended = resolve;
        setTimeout(resolve, FLUSH_MS);
      });
      conn.close();
      return mic.stop();
    },
  };
}
