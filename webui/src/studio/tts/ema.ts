// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// EMA Lightning: Turkish text to 48 kHz speech, for dubbing. A port of the model's
// own tts.js, which mirrors its frontend.py, chunker.py and engine.py.
// Model: huggingface.co/canberkkkkkk/ema-lightning (Apache-2.0).

import type { InferenceSession } from "onnxruntime-web";
import type { Ort } from "../engine/models";

export const RATE = 48000;
const WINDOW = 100; // frames decoded at a time (four seconds)
const CONTEXT = 8; // frames decoded on each side of a window
const MAX_WORD_FRAMES = 250;
const MAX_FRAMES = 3000;

export interface EmaMeta {
  vocab: string[];
  times: number[];
  latent_dim: number;
  hop: number;
}

// ---------- text frontend (frontend.py; normalizer-tr runs as WebAssembly) ----------

const TURKISH = new Set("çğıöşüÇĞİÖŞÜ");
const TYPOGRAPHY: Record<string, string> = {
  "’": "'", "‘": "'", "ʼ": "'", "´": "'", "`": "'", "“": '"', "”": '"', "„": '"',
  "«": '"', "»": '"', "–": "-", "—": "-", "−": "-", "…": "...",
};
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g;
const BLOCK_BYTES = 8 * 1024;

/** Split at whitespace into pieces the normalizer accepts in one call. */
function blocks(text: string): string[] {
  const out: string[] = [];
  let block: string[] = [];
  let size = 0;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const n = new TextEncoder().encode(word).length + 1;
    if (block.length && size + n > BLOCK_BYTES) {
      out.push(block.join(" "));
      block = [];
      size = 0;
    }
    block.push(word);
    size += n;
  }
  if (block.length) out.push(block.join(" "));
  return out;
}

function alphabet(text: string, vocab: Set<string>): string {
  text = [...text.replace(UNSAFE, " ")].map((ch) => TYPOGRAPHY[ch] ?? ch).join("");
  text = text.replace(/İ/g, "i").replace(/I/g, "ı").toLocaleLowerCase("tr");
  let out = "";
  for (let ch of text) {
    if (!TURKISH.has(ch)) ch = ch.normalize("NFKD").replace(/\p{M}/gu, "");
    out += ch && [...ch].every((c) => vocab.has(c)) ? ch : " ";
  }
  return out.replace(/\s+/g, " ").trim();
}

/** normalizer-tr compiled to WebAssembly: reads numbers, dates, times and money aloud ("14:30" → "on dört otuz"). */
export async function loadNormalizer(bytes: Uint8Array): Promise<(text: string) => string> {
  const { instance } = await WebAssembly.instantiate(bytes as Uint8Array<ArrayBuffer>, {});
  const w = instance.exports as {
    memory: WebAssembly.Memory;
    alloc(n: number): number;
    dealloc(ptr: number, n: number): void;
    normalize(ptr: number, n: number): void;
    result_ptr(): number;
    result_len(): number;
  };
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return (text) => {
    const input = enc.encode(text);
    const ptr = w.alloc(input.length);
    new Uint8Array(w.memory.buffer, ptr, input.length).set(input);
    w.normalize(ptr, input.length);
    w.dealloc(ptr, input.length);
    return dec.decode(new Uint8Array(w.memory.buffer, w.result_ptr(), w.result_len()));
  };
}

// ---------- chunker.py ----------

const LETTERS_PER_SECOND = 18;
const MAX_SECONDS = 10;
const MAX_LETTERS = 250;
const SENTENCE_PAUSE = 0.25;
const CLAUSE_PAUSE = 0.12;
const CUTS: [RegExp, number][] = [
  [/[.!?]+["')]*(?= )/g, SENTENCE_PAUSE],
  [/[,;:](?= )/g, CLAUSE_PAUSE],
  [/\S(?= )/g, CLAUSE_PAUSE],
];

function finish(piece: string): string {
  if (/[.!?]$/.test(piece.replace(/["')]+$/, ""))) return piece;
  return piece.replace(/[,;:\- ]+$/, "") + ".";
}

/** Pieces the model reads in one go, each with the pause after it. */
function chunk(text: string, speed: number): [string, number][] {
  const limit = Math.floor(Math.min(MAX_LETTERS, LETTERS_PER_SECOND * MAX_SECONDS * speed));
  const pieces: [string, number][] = [];
  let rest = text.trim();
  while (rest) {
    let cut = rest.length;
    let pause = 0;
    if (rest.length > limit) {
      cut = limit;
      const head = rest.slice(0, limit + 1);
      for (const [pattern, gap] of CUTS) {
        const ends = [...head.matchAll(pattern)].map((m) => m.index + m[0].length);
        if (ends.length) {
          cut = ends.at(-1)!;
          pause = gap;
          break;
        }
      }
    }
    const piece = rest.slice(0, cut).trim();
    rest = rest.slice(cut).trim();
    if (/\p{L}/u.test(piece)) pieces.push([finish(piece), pause]);
  }
  if (pieces.length) pieces.at(-1)![1] = 0;
  return pieces;
}

// ---------- seeded Gaussian noise ----------

function gaussian(seed: number) {
  let a = seed >>> 0;
  const uniform = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return (n: number) => {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i += 2) {
      const r = Math.sqrt(-2 * Math.log(1 - uniform()));
      const th = 2 * Math.PI * uniform();
      out[i] = r * Math.cos(th);
      if (i + 1 < n) out[i + 1] = r * Math.sin(th);
    }
    return out;
  };
}

// ---------- engine.py ----------

/** Word index of each letter, and the first letter of that word (spaces belong to the next word). */
function words(text: string) {
  const starts: number[] = [];
  for (let i = 0; i < text.length; i++) if (text[i] !== " " && (i === 0 || text[i - 1] === " ")) starts.push(i);
  if (!starts.length) starts.push(0);
  const bounds = [0, ...starts.slice(1), text.length];
  const cw: number[] = [];
  const wstart: number[] = [];
  for (let w = 0; w + 1 < bounds.length; w++)
    for (let i = bounds[w]; i < bounds[w + 1]; i++) {
      cw.push(w);
      wstart.push(bounds[w]);
    }
  return { cw, wstart };
}

function plan(cw: number[], wstart: number[], dur: Float32Array, speed: number) {
  const L = cw.length;
  const nWords = cw[L - 1] + 1;
  const d = Float32Array.from(dur, (x) => x / speed);
  const sums = new Float64Array(nWords);
  for (let i = 0; i < L; i++) sums[cw[i]] += d[i];
  const counts = Array.from(sums, (s) => Math.min(MAX_WORD_FRAMES, Math.max(1, Math.round(s))));
  const T = Math.min(counts.reduce((a, b) => a + b, 0), MAX_FRAMES);
  const fw = new Int32Array(T);
  const fp = new Float32Array(T);
  for (let w = 0, f = 0; w < nWords; w++)
    for (let j = 0; j < counts[w] && f < T; j++, f++) {
      fw[f] = w;
      fp[f] = j / counts[w];
    }
  // sound_stage: where each letter sits inside its word, by duration
  const c = Float32Array.from(d, (x) => Math.max(x, 1e-4));
  const done = new Float32Array(L);
  const total = new Float32Array(nWords);
  for (let i = 0, acc = 0; i < L; i++) {
    acc += c[i];
    done[i] = acc;
    total[cw[i]] += c[i];
  }
  const before = (i: number) => done[i] - c[i];
  // aligner letter_pos: global positions measured in letters
  const wlen = new Float32Array(nWords);
  for (const w of cw) wlen[w] += 1;
  const woff = new Float32Array(nWords);
  for (let w = 1; w < nWords; w++) woff[w] = woff[w - 1] + Math.max(wlen[w - 1], 1);
  const cg = new Float32Array(L);
  const fg = new Float32Array(T);
  for (let i = 0; i < L; i++) {
    const cp = Math.min(1, Math.max(0, (done[i] - before(wstart[i]) - 0.5 * c[i]) / Math.max(total[cw[i]], 1e-8)));
    cg[i] = woff[cw[i]] + cp * Math.max(wlen[cw[i]], 1);
  }
  for (let f = 0; f < T; f++) fg[f] = woff[fw[f]] + fp[f] * Math.max(wlen[fw[f]], 1);
  return { T, fw, cg, fg };
}

export class Ema {
  private stoi: Map<string, number>;
  private alpha: Set<string>;

  constructor(
    private ort: Ort,
    private meta: EmaMeta,
    private sessions: { text: InferenceSession; sound: InferenceSession; decoder: InferenceSession },
    private normalize: (text: string) => string,
  ) {
    this.stoi = new Map(meta.vocab.map((ch, i) => [ch, i]));
    this.alpha = new Set(meta.vocab.filter((v) => v.length === 1));
  }

  private prepare(text: string): string {
    text = text.replace(UNSAFE, " ");
    if (!text.trim()) return "";
    return alphabet(blocks(text).map(this.normalize).join(" "), this.alpha);
  }

  /** All of the text as one buffer of 48 kHz audio. `speed` above 1 speaks faster. */
  async speak(text: string, speed = 1, seed = 0): Promise<Float32Array> {
    const { ort, meta } = this;
    const i64 = (arr: ArrayLike<number>) =>
      new ort.Tensor("int64", BigInt64Array.from(arr as number[], (x) => BigInt(x)), [1, arr.length]);
    const f32 = (arr: Float32Array, dims: number[]) => new ort.Tensor("float32", arr, dims);
    const nSteps = meta.times.length;
    const D = meta.latent_dim;
    const hop = meta.hop;
    const out: Float32Array[] = [];
    const pieces = chunk(this.prepare(text), speed);
    for (let k = 0; k < pieces.length; k++) {
      const [piece, pause] = pieces[k];
      const ids = [...piece].map((ch) => this.stoi.get(ch) ?? 1);
      const { cw, wstart } = words(piece);
      const { h, dur } = await this.sessions.text.run({ ids: i64(ids) });
      const { T, fw, cg, fg } = plan(cw, wstart, (await dur.getData()) as Float32Array, speed);
      const noise = gaussian(seed * 1000003 + k)(nSteps * T * D);
      const { latents } = await this.sessions.sound.run({
        h,
        cg: f32(cg, [1, cg.length]),
        fg: f32(fg, [1, T]),
        cw: i64(cw),
        fw: i64(fw),
        noise: f32(noise, [1, nSteps, T, D]),
      });
      const lat = (await latents.getData()) as Float32Array; // [T, D]
      h.dispose();
      dur.dispose();
      latents.dispose();
      for (let s = 0; s < T; s += WINDOW) {
        const e = Math.min(T, s + WINDOW);
        const a = Math.max(0, s - CONTEXT);
        const b = Math.min(T, e + CONTEXT);
        const n = b - a;
        const z = new Float32Array(D * n); // [1, D, n]
        for (let f = 0; f < n; f++) for (let d = 0; d < D; d++) z[d * n + f] = lat[(a + f) * D + d];
        const { audio } = await this.sessions.decoder.run({ z: f32(z, [1, D, n]) });
        out.push(((await audio.getData()) as Float32Array).slice((s - a) * hop, (e - a) * hop));
        audio.dispose();
      }
      if (pause) out.push(new Float32Array(Math.round(pause * RATE)));
    }
    const all = new Float32Array(out.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of out) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }
}
