// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Whisper's log-mel spectrogram, numerically matching transformers'
// WhisperFeatureExtractor: 16 kHz, 400-point periodic Hann window, 160-sample
// hop, centred frames with reflect padding, power spectrum, 128 Slaney mel
// bins up to 8 kHz, log10 floored 8 below the maximum, scaled to about [-1, 1].

export const SAMPLE_RATE = 16000;
export const N_FFT = 400;
export const HOP = 160;
/** Every window is 30 s: 480 000 samples, 3000 mel frames. */
export const WINDOW_SAMPLES = SAMPLE_RATE * 30;
export const WINDOW_FRAMES = WINDOW_SAMPLES / HOP;

const BINS = N_FFT / 2 + 1;

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) / (Math.log(6.4) / 27));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));

interface MelBin {
  offset: number;
  weights: Float32Array;
}

/** Slaney-normalised triangular filters over the 201 FFT bins (librosa's defaults). */
function melFilters(numMel: number): MelBin[] {
  const top = hzToMel(SAMPLE_RATE / 2);
  const hz = Array.from({ length: numMel + 2 }, (_, i) => melToHz((top * i) / (numMel + 1)));
  const bins: MelBin[] = [];
  for (let m = 0; m < numMel; m++) {
    const [lo, mid, hi] = [hz[m], hz[m + 1], hz[m + 2]];
    const norm = 2 / (hi - lo);
    const w = new Float32Array(BINS);
    let first = -1;
    let last = -1;
    for (let k = 0; k < BINS; k++) {
      const f = (k * SAMPLE_RATE) / N_FFT;
      const v = Math.max(0, Math.min((f - lo) / (mid - lo), (hi - f) / (hi - mid)));
      if (v > 0) {
        w[k] = v * norm;
        if (first < 0) first = k;
        last = k;
      }
    }
    bins.push({ offset: first, weights: w.slice(first, last + 1) });
  }
  return bins;
}

/**
 * Mixed-radix complex FFT for sizes that factor into 2, 3, 4 and 5 (kissfft's
 * recursive decimation in time with generic butterflies). 400 = 4·4·5·5.
 */
export class MixedFft {
  private factors: number[] = [];
  private twRe: Float64Array;
  private twIm: Float64Array;
  private scratchRe = new Float64Array(5);
  private scratchIm = new Float64Array(5);

  constructor(readonly n: number) {
    let rest = n;
    for (const p of [4, 2, 3, 5]) {
      while (rest % p === 0) {
        this.factors.push(p);
        rest /= p;
      }
    }
    if (rest !== 1) throw new Error(`FFT size ${n} has unsupported factors`);
    this.twRe = new Float64Array(n);
    this.twIm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      this.twRe[i] = Math.cos((-2 * Math.PI * i) / n);
      this.twIm[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  /** out = FFT(in); `in` is real. */
  transform(input: Float64Array, outRe: Float64Array, outIm: Float64Array) {
    this.work(input, 0, 1, 0, outRe, outIm, 0, this.n);
  }

  private work(
    x: Float64Array,
    xOff: number,
    stride: number,
    level: number,
    re: Float64Array,
    im: Float64Array,
    out: number,
    len: number,
  ) {
    const p = this.factors[level];
    const m = len / p;
    if (m === 1) {
      for (let j = 0; j < p; j++) {
        re[out + j] = x[xOff + j * stride];
        im[out + j] = 0;
      }
    } else {
      for (let j = 0; j < p; j++) this.work(x, xOff + j * stride, stride * p, level + 1, re, im, out + j * m, m);
    }
    // Generic butterfly; `stride` is also the twiddle step at this level.
    const { n, twRe, twIm, scratchRe: sr, scratchIm: si } = this;
    for (let u = 0; u < m; u++) {
      for (let q = 0; q < p; q++) {
        sr[q] = re[out + u + q * m];
        si[q] = im[out + u + q * m];
      }
      for (let q1 = 0; q1 < p; q1++) {
        const k = u + q1 * m;
        let accRe = sr[0];
        let accIm = si[0];
        let tw = 0;
        for (let q = 1; q < p; q++) {
          tw += stride * k;
          tw %= n;
          accRe += sr[q] * twRe[tw] - si[q] * twIm[tw];
          accIm += sr[q] * twIm[tw] + si[q] * twRe[tw];
        }
        re[out + k] = accRe;
        im[out + k] = accIm;
      }
    }
  }
}

export class LogMel {
  private filters: MelBin[];
  private window = new Float64Array(N_FFT);
  private fft = new MixedFft(N_FFT);
  private frame = new Float64Array(N_FFT);
  private re = new Float64Array(N_FFT);
  private im = new Float64Array(N_FFT);
  private power = new Float64Array(BINS);

  constructor(readonly numMel = 128) {
    this.filters = melFilters(numMel);
    // Periodic Hann, as torch.hann_window(400).
    for (let i = 0; i < N_FFT; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);
  }

  /**
   * Features for one 30 s window, laid out [numMel, 3000]. Shorter audio is
   * padded with silence first, as the reference extractor does.
   */
  compute(audio: Float32Array): Float32Array {
    const x = new Float32Array(WINDOW_SAMPLES);
    x.set(audio.subarray(0, WINDOW_SAMPLES));
    const n = WINDOW_SAMPLES;
    const half = N_FFT / 2;
    const out = new Float32Array(this.numMel * WINDOW_FRAMES);
    let max = -Infinity;
    // Frame t is centred on sample t·HOP; the STFT's extra last frame is dropped.
    for (let t = 0; t < WINDOW_FRAMES; t++) {
      const start = t * HOP - half;
      for (let i = 0; i < N_FFT; i++) {
        let s = start + i;
        if (s < 0) s = -s;
        else if (s >= n) s = 2 * n - 2 - s;
        this.frame[i] = x[s] * this.window[i];
      }
      this.fft.transform(this.frame, this.re, this.im);
      for (let k = 0; k < BINS; k++) this.power[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
      for (let m = 0; m < this.numMel; m++) {
        const { offset, weights } = this.filters[m];
        let e = 0;
        for (let k = 0; k < weights.length; k++) e += weights[k] * this.power[offset + k];
        const v = Math.log10(Math.max(e, 1e-10));
        out[m * WINDOW_FRAMES + t] = v;
        if (v > max) max = v;
      }
    }
    const floor = max - 8;
    for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
    return out;
  }
}
