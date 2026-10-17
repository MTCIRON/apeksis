// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Whisper as a SpeechEngine: audio is collected into 30 s windows, each one
// decoded with timestamps (openai-whisper's sequential long-form scheme: a
// cut-off last segment is decoded again at the start of the next window) and
// its words timed from cross-attention. A voice activity detector skips
// silent windows and drops words Whisper invents over silence.

import { OnlineFbank } from "../engine/fbank";
import type { SmallProvider } from "../engine";
import type { EncoderProvider, Ort } from "../engine/models";
import type { SpeechEngine, SpeechStream } from "../engine/stream";
import type { Word } from "../engine/tokens";
import { alignWords, FRAME_SEC, tokenFrames } from "./alignment";
import { HOP, LogMel, SAMPLE_RATE, WINDOW_SAMPLES } from "./mel";
import { WhisperModel, type WhisperConfig } from "./model";
import { WhisperTokenizer } from "./tokenizer";
import { SileroVad } from "./vad";

export type { WhisperConfig } from "./model";

export interface WhisperFiles {
  config: WhisperConfig;
  encoder: Uint8Array;
  decoder: Uint8Array;
  vocab: Record<string, number>;
  vad: Uint8Array;
}

/** Thresholds openai-whisper uses to treat a window as silence. */
const NO_SPEECH_PROB = 0.6;
const LOGPROB_FLOOR = -1;
/** A finished stream's leftover shorter than this is not decoded. */
const MIN_TAIL = SAMPLE_RATE / 10;
const SAMPLES_PER_TS = FRAME_SEC * SAMPLE_RATE;

export class WhisperEngine implements SpeechEngine {
  private constructor(
    private model: WhisperModel,
    private tok: WhisperTokenizer,
    private vad: SileroVad,
  ) {}

  static async create(
    ort: Ort,
    files: WhisperFiles,
    provider: EncoderProvider,
    small: SmallProvider = "wasm",
  ): Promise<WhisperEngine> {
    // Sequential: onnxruntime-web rejects concurrent initialisation.
    const vad = await SileroVad.create(ort, files.vad, small);
    const model = await WhisperModel.create(ort, files.config, files.encoder, files.decoder, provider);
    return new WhisperEngine(model, new WhisperTokenizer(files.vocab), vad);
  }

  get provider() {
    return this.model.provider;
  }

  createRecognizer(): SpeechStream {
    this.vad.reset();
    return new WhisperRecognizer(this.model, this.tok, this.vad);
  }
}

/**
 * Which generated text is final, and how far the window moves on. A window
 * that ends mid-segment moves only to the last complete one.
 */
export function splitSegments(tokens: number[], tsBegin: number, windowSamples: number, takeAll: boolean) {
  const isTs = tokens.map((t) => t >= tsBegin);
  const n = tokens.length;
  const singleEnding = n >= 2 && !isTs[n - 2] && isTs[n - 1];
  const cuts: number[] = [];
  for (let i = 1; i < n; i++) if (isTs[i - 1] && isTs[i]) cuts.push(i);
  if (!cuts.length || singleEnding || takeAll) {
    return { text: tokens.filter((t) => t < tsBegin), advance: windowSamples };
  }
  const end = cuts[cuts.length - 1];
  const advance = (tokens[end - 1] - tsBegin) * SAMPLES_PER_TS;
  return {
    text: tokens.slice(0, end).filter((t) => t < tsBegin),
    advance: advance > 0 ? Math.min(advance, windowSamples) : windowSamples,
  };
}

class WhisperRecognizer implements SpeechStream {
  onFeature: ((f: Float32Array) => void) | null = null;
  readonly timing = { encoder: 0, search: 0, chunks: 0 };
  /** Only for onFeature (the aura); Whisper has its own features. */
  private fbank = new OnlineFbank(80);
  private mel: LogMel;
  /** Audio from the current window start on. */
  private audio = new Float32Array(WINDOW_SAMPLES * 2);
  private length = 0;
  private windowStart = 0;
  private finished = false;
  /** Samples given to the VAD so far. */
  private vadSamples = 0;
  private lastEnd = 0;
  private committed: Word[] = [];

  constructor(
    private model: WhisperModel,
    private tok: WhisperTokenizer,
    private vad: SileroVad,
  ) {
    this.mel = new LogMel(model.config.numMel);
  }

  get decodedSeconds() {
    return this.windowStart / SAMPLE_RATE;
  }

  acceptWaveform(samples: Float32Array) {
    if (this.length + samples.length > this.audio.length) {
      const next = new Float32Array(Math.max(this.audio.length * 2, this.length + samples.length));
      next.set(this.audio.subarray(0, this.length));
      this.audio = next;
    }
    this.audio.set(samples, this.length);
    this.length += samples.length;
    this.fbank.acceptWaveform(samples);
    this.pullFeatures();
  }

  inputFinished() {
    if (this.finished) return;
    this.finished = true;
    this.fbank.inputFinished();
    this.pullFeatures();
  }

  isReady() {
    return this.length >= WINDOW_SAMPLES || (this.finished && this.length >= MIN_TAIL);
  }

  async decodeChunk() {
    const n = Math.min(this.length, WINDOW_SAMPLES);
    const last = this.finished && this.length <= WINDOW_SAMPLES;
    const t0 = performance.now();
    await this.vad.push(this.audio.subarray(this.vadSamples - this.windowStart, n), last);
    this.vadSamples = this.windowStart + n;
    const from = this.decodedSeconds;
    if (!this.vad.hasSpeech(from, from + n / SAMPLE_RATE, 0)) {
      this.consume(n);
      return;
    }
    const enc = await this.model.encode(this.mel.compute(this.audio.subarray(0, n)));
    const t1 = performance.now();
    let advance = n;
    try {
      const gen = await this.model.generate(enc);
      const silent = gen.noSpeechProb > NO_SPEECH_PROB && gen.avgLogprob < LOGPROB_FLOOR;
      if (!silent && gen.tokens.length) {
        const seg = splitSegments(gen.tokens, this.model.config.tokens.timestampBegin, n, last || gen.looped);
        advance = seg.advance;
        if (seg.text.length) {
          const att = await this.model.attention(enc, seg.text);
          const frames = tokenFrames(
            att.heads,
            att.rows,
            Math.floor(n / (HOP * 2)),
            att.promptLen,
            this.model.config.medianFilterWidth,
          );
          for (const w of alignWords(this.tok, seg.text, frames, from)) {
            if (!this.vad.hasSpeech(w.start, w.end)) continue;
            // Words at a pause soak up the silence next to them (half a
            // second at sentence starts); keep them to the speech.
            Object.assign(w, this.vad.speechSpan(w.start, w.end));
            // Windows overlap a little where a segment was decoded again.
            w.start = Math.max(w.start, this.lastEnd);
            w.end = Math.max(w.end, w.start);
            this.lastEnd = w.end;
            this.committed.push(w);
          }
        }
      }
    } finally {
      this.model.release(enc);
    }
    this.timing.encoder += t1 - t0;
    this.timing.search += performance.now() - t1;
    this.timing.chunks++;
    this.consume(advance);
  }

  flush() {
    this.consume(this.length);
  }

  takeCommitted(): Word[] {
    const w = this.committed;
    this.committed = [];
    return w;
  }

  tentative(): Word[] {
    return [];
  }

  private consume(samples: number) {
    const k = Math.min(samples, this.length);
    this.audio.copyWithin(0, k, this.length);
    this.length -= k;
    this.windowStart += k;
  }

  private pullFeatures() {
    this.fbank.compute((f) => this.onFeature?.(f));
  }
}
