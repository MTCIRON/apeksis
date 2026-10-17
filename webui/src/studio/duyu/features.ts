// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Duyu-small's log-mel features, as its engine computes them (w2v-BERT 2.0
// front end): Kaldi framing 25 ms / 10 ms, DC removal, pre-emphasis 0.97,
// Povey window, 512-point power spectrum, 80 mel bins, log, mean and variance
// normalised over the utterance, two frames stacked -> 160 values at 50 Hz.
// The window and mel filters come from the model (fbank.bin).

import { MixedFft } from "../whisper/mel";

const WIN = 400;
const HOP = 160;
const NFFT = 512;
const BINS = NFFT / 2 + 1;
const MELS = 80;
const EPS = 1.192092955078125e-7;
export const FEATURE_DIM = 2 * MELS;

interface MelBin {
  offset: number;
  weights: Float64Array;
}

export class DuyuFbank {
  private window: Float64Array;
  private filters: MelBin[] = [];
  private fft = new MixedFft(NFFT);
  private frame = new Float64Array(NFFT);
  private re = new Float64Array(NFFT);
  private im = new Float64Array(NFFT);
  private power = new Float64Array(BINS);

  /** tables: the window (400) followed by the mel matrix (257 x 80, row-major). */
  constructor(tables: Float32Array) {
    if (tables.length !== WIN + BINS * MELS) throw new Error("fbank.bin has an unexpected size");
    this.window = Float64Array.from(tables.subarray(0, WIN));
    const mel = tables.subarray(WIN);
    for (let m = 0; m < MELS; m++) {
      let first = -1;
      let last = -1;
      for (let k = 0; k < BINS; k++) {
        if (mel[k * MELS + m] !== 0) {
          if (first < 0) first = k;
          last = k;
        }
      }
      const weights = new Float64Array(Math.max(0, last - first + 1));
      for (let k = first; k <= last; k++) weights[k - first] = mel[k * MELS + m];
      this.filters.push({ offset: Math.max(first, 0), weights });
    }
  }

  /** 16 kHz audio in [-1, 1] -> frames x 160 features. */
  compute(wav: Float32Array): { data: Float32Array; frames: number } {
    const len = Math.max(wav.length, WIN);
    const n = Math.floor((len - WIN) / HOP) + 1;
    const logmel = new Float64Array(n * MELS);
    const f = this.frame;
    for (let t = 0; t < n; t++) {
      const start = t * HOP;
      let mean = 0;
      for (let i = 0; i < WIN; i++) {
        const s = start + i;
        f[i] = s < wav.length ? wav[s] * 32768 : 0;
        mean += f[i];
      }
      mean /= WIN;
      for (let i = 0; i < WIN; i++) f[i] -= mean;
      // Pre-emphasis, backwards so each sample still sees its unchanged neighbour.
      for (let i = WIN - 1; i > 0; i--) f[i] -= 0.97 * f[i - 1];
      f[0] *= 1 - 0.97;
      for (let i = 0; i < WIN; i++) f[i] *= this.window[i];
      f.fill(0, WIN);
      this.fft.transform(f, this.re, this.im);
      for (let k = 0; k < BINS; k++) this.power[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      for (let m = 0; m < MELS; m++) {
        const { offset, weights } = this.filters[m];
        let e = 0;
        for (let k = 0; k < weights.length; k++) e += weights[k] * this.power[offset + k];
        logmel[t * MELS + m] = Math.log(Math.max(e, EPS));
      }
    }

    // Per-utterance normalisation (sample variance, as numpy's ddof=1).
    for (let m = 0; m < MELS; m++) {
      let sum = 0;
      for (let t = 0; t < n; t++) sum += logmel[t * MELS + m];
      const mean = sum / n;
      let v = 1;
      if (n > 1) {
        let sq = 0;
        for (let t = 0; t < n; t++) sq += (logmel[t * MELS + m] - mean) ** 2;
        v = sq / (n - 1);
      }
      const scale = 1 / Math.sqrt(v + 1e-7);
      for (let t = 0; t < n; t++) logmel[t * MELS + m] = (logmel[t * MELS + m] - mean) * scale;
    }

    // Two frames side by side: frame pairs (0, 1), (2, 3), ... The rows are
    // contiguous, so stacking is just dropping an odd last frame.
    const frames = n >> 1;
    return { data: Float32Array.from(logmel.subarray(0, frames * FEATURE_DIM)), frames };
  }
}
