// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Silero VAD v5 (MIT, 2.3 MB): speech probability per 32 ms of 16 kHz audio.
// Whisper invents text over silence ("Altyazı M.K.") and turbo's own
// no-speech score does not catch it, so words outside speech are dropped.

import type * as OrtWeb from "onnxruntime-web";
import type { Ort } from "../engine/models";

const FRAME = 512;
const CONTEXT = 64;
export const VAD_FRAME_SEC = FRAME / 16000;
/** Enter speech above this probability, leave below EXIT (silero's defaults). */
const ENTER = 0.5;
const EXIT = 0.35;

export class SileroVad {
  private state: OrtWeb.Tensor;
  private input = new Float32Array(CONTEXT + FRAME);
  private sr: OrtWeb.Tensor;
  /** Audio not yet a whole frame. */
  private pending = new Float32Array(FRAME);
  private pendingLength = 0;
  private speaking = false;
  /** One flag per frame since the stream started. */
  private speech: number[] = [];

  private constructor(
    private ort: Ort,
    private session: OrtWeb.InferenceSession,
  ) {
    this.state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    this.sr = new ort.Tensor("int64", BigInt64Array.of(16000n), []);
  }

  static async create(ort: Ort, bytes: Uint8Array, provider: "wasm" | "cpu"): Promise<SileroVad> {
    const session = await ort.InferenceSession.create(bytes, {
      executionProviders: [provider],
      graphOptimizationLevel: "all",
      logSeverityLevel: 3,
    });
    return new SileroVad(ort, session);
  }

  reset() {
    this.state = new this.ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
    this.input.fill(0);
    this.pendingLength = 0;
    this.speaking = false;
    this.speech = [];
  }

  /** Seconds of audio classified so far. */
  get seconds() {
    return this.speech.length * VAD_FRAME_SEC;
  }

  /** Classify more audio; `last` pads the final partial frame with silence. */
  async push(samples: Float32Array, last = false) {
    let i = 0;
    while (i < samples.length || (last && this.pendingLength > 0)) {
      const take = Math.min(FRAME - this.pendingLength, samples.length - i);
      this.pending.set(samples.subarray(i, i + take), this.pendingLength);
      this.pendingLength += take;
      i += take;
      if (this.pendingLength < FRAME) {
        if (!last || i < samples.length) break;
        this.pending.fill(0, this.pendingLength);
      }
      await this.frame();
      this.pendingLength = 0;
    }
  }

  private async frame() {
    // Each frame carries the last 64 samples of the previous one.
    this.input.copyWithin(0, FRAME);
    this.input.set(this.pending, CONTEXT);
    const x = new this.ort.Tensor("float32", this.input.slice(), [1, CONTEXT + FRAME]);
    const out = await this.session.run({ input: x, state: this.state, sr: this.sr });
    this.state = out.stateN;
    const p = (out.output.data as Float32Array)[0];
    this.speaking = this.speaking ? p >= EXIT : p >= ENTER;
    this.speech.push(this.speaking ? 1 : 0);
  }

  /**
   * The part of [start, end] that holds speech, widened by `pad` seconds but
   * never past the original range; the range itself when none of it does.
   */
  speechSpan(start: number, end: number, pad = 0.05): { start: number; end: number } {
    const a = Math.max(0, Math.floor(start / VAD_FRAME_SEC));
    const b = Math.min(this.speech.length, Math.ceil(end / VAD_FRAME_SEC));
    let first = -1;
    let last = -1;
    for (let k = a; k < b; k++) {
      if (!this.speech[k]) continue;
      if (first < 0) first = k;
      last = k;
    }
    if (first < 0) return { start, end };
    return {
      start: Math.max(start, first * VAD_FRAME_SEC - pad),
      end: Math.min(end, (last + 1) * VAD_FRAME_SEC + pad),
    };
  }

  /** True if there is speech between the two times, widened by `pad` seconds. */
  hasSpeech(start: number, end: number, pad = 0.2): boolean {
    const a = Math.max(0, Math.floor((start - pad) / VAD_FRAME_SEC));
    const b = Math.min(this.speech.length, Math.ceil((end + pad) / VAD_FRAME_SEC));
    for (let k = a; k < b; k++) if (this.speech[k]) return true;
    return false;
  }
}
