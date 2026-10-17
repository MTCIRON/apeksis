// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Decoding for Duyu-small, a port of its engine's decode.py kept rule for rule:
//
//  * CTC greedy: argmax, collapse repeats, drop blanks.
//  * Attention beam search: step 0 forces (or detects) the language token,
//    step 1 the <cased> style; content steps never emit blank, BOS or control
//    tokens; finished beams absorb </s> at no cost; the length is bounded by
//    the CTC greedy length.
//  * Final ranking: length-normalised (1 - w) * attention + w * CTC score
//    (forward algorithm; a hypothesis the frames cannot hold is vetoed).
//  * Guards: silence veto (CTC hears at most one token but the decoder writes
//    more -> nothing), runaway veto (far longer than the CTC path, or an
//    n-gram repeated 6 times -> the next clean beam, else the CTC text).
//
// Plus a Viterbi alignment of the final text to the CTC frames, which the
// engine does not need but word timestamps do.

import type { DuyuConfig } from "./model";

const NEG = -1e30;
const MAX_REPEAT_RUN = 6;
const RUNAWAY_RATIO = 1.5;
const RUNAWAY_SLACK = 10;
const RUNAWAY_SLACK_SHORT = 4;
const RUNAWAY_SHORT = 8;
const N_PREFIX = 3; // <s> <lang> <cased>

/** Logits of the next token for each beam: rows x vocabSize. */
export type NextLogits = (tokens: BigInt64Array, rows: number, len: number) => Promise<Float32Array>;

export interface SearchOptions {
  beam: number;
  /** Language token name; null detects it. */
  lang: string | null;
  ctcWeight: number;
}

export function ctcGreedy(logp: Float32Array, frames: number, V: number, blank: number): number[] {
  const out: number[] = [];
  let prev = -1;
  for (let t = 0; t < frames; t++) {
    let best = 0;
    let bestV = logp[t * V];
    for (let v = 1; v < V; v++) {
      if (logp[t * V + v] > bestV) {
        bestV = logp[t * V + v];
        best = v;
      }
    }
    if (best !== prev && best !== blank) out.push(best);
    prev = best;
  }
  return out;
}

const runawayBound = (ctcLen: number) =>
  Math.floor(RUNAWAY_RATIO * ctcLen + (ctcLen < RUNAWAY_SHORT ? RUNAWAY_SLACK_SHORT : RUNAWAY_SLACK));

function isRunaway(seq: number[], ctcLen: number): boolean {
  if (seq.length > runawayBound(ctcLen)) return true;
  for (let n = 1; n <= 4; n++) {
    let run = 1;
    for (let i = n; i < seq.length - n + 1; i += n) {
      let same = true;
      for (let j = 0; j < n; j++) if (seq[i + j] !== seq[i - n + j]) same = false;
      if (same) {
        if (++run >= MAX_REPEAT_RUN) return true;
      } else {
        run = 1;
      }
    }
  }
  return false;
}

/** The CTC label sequence with blanks around and between the tokens. */
function extend(seq: number[], blank: number) {
  const ext = [blank];
  for (const s of seq) ext.push(s, blank);
  const skip = ext.map((e, s) => s >= 2 && e !== blank && e !== ext[s - 2]);
  return { ext, skip };
}

const logAdd3 = (a: number, b: number, c: number) => {
  const m = Math.max(a, b, c);
  return m + Math.log(Math.exp(a - m) + Math.exp(b - m) + Math.exp(c - m));
};

/** -log p_CTC(seq), or Infinity when the frames cannot hold the sequence. */
export function ctcNll(logp: Float32Array, frames: number, V: number, seq: number[], blank: number): number {
  if (!seq.length) {
    let s = 0;
    for (let t = 0; t < frames; t++) s += logp[t * V + blank];
    return -s;
  }
  const { ext, skip } = extend(seq, blank);
  const S = ext.length;
  if (frames < (S + 1) >> 1) return Infinity;
  let alpha = new Float64Array(S).fill(NEG);
  let next = new Float64Array(S);
  alpha[0] = logp[blank];
  alpha[1] = logp[ext[1]];
  for (let t = 1; t < frames; t++) {
    const row = t * V;
    for (let s = 0; s < S; s++) {
      const a1 = s >= 1 ? alpha[s - 1] : NEG;
      const a2 = skip[s] ? alpha[s - 2] : NEG;
      next[s] = logAdd3(alpha[s], a1, a2) + logp[row + ext[s]];
    }
    [alpha, next] = [next, alpha];
  }
  const tail = S === 1 ? alpha[S - 1] : Math.max(alpha[S - 1], alpha[S - 2]) + Math.log1p(Math.exp(-Math.abs(alpha[S - 1] - alpha[S - 2])));
  return tail > NEG / 2 ? -tail : Infinity;
}

/**
 * Viterbi alignment of `seq` to the frames: for each token the first and
 * last frame it is emitted on. Null if the frames cannot hold it.
 */
export function ctcAlign(
  logp: Float32Array,
  frames: number,
  V: number,
  seq: number[],
  blank: number,
): { first: Int32Array; last: Int32Array } | null {
  const first = new Int32Array(seq.length);
  const last = new Int32Array(seq.length);
  if (!seq.length) return { first, last };
  const { ext, skip } = extend(seq, blank);
  const S = ext.length;
  if (frames < (S + 1) >> 1) return null;
  let score = new Float64Array(S).fill(NEG);
  let next = new Float64Array(S);
  const back = new Uint8Array(frames * S); // 0 stay, 1 from s-1, 2 from s-2
  score[0] = logp[blank];
  score[1] = logp[ext[1]];
  for (let t = 1; t < frames; t++) {
    const row = t * V;
    for (let s = 0; s < S; s++) {
      let best = score[s];
      let from = 0;
      if (s >= 1 && score[s - 1] > best) {
        best = score[s - 1];
        from = 1;
      }
      if (skip[s] && score[s - 2] > best) {
        best = score[s - 2];
        from = 2;
      }
      next[s] = best + logp[row + ext[s]];
      back[t * S + s] = from;
    }
    [score, next] = [next, score];
  }
  let s = S === 1 || score[S - 1] >= score[S - 2] ? S - 1 : S - 2;
  if (score[s] < NEG / 2) return null;
  last.fill(-1);
  for (let t = frames - 1; t >= 0; t--) {
    if (s & 1) {
      const k = s >> 1;
      if (last[k] < 0) last[k] = t;
      first[k] = t;
    }
    s -= back[t * S + s];
  }
  return { first, last };
}

function logSoftmaxRow(v: Float32Array, start: number, n: number) {
  let max = -Infinity;
  for (let i = 0; i < n; i++) if (v[start + i] > max) max = v[start + i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.exp(v[start + i] - max);
  const lse = max + Math.log(sum);
  for (let i = 0; i < n; i++) v[start + i] -= lse;
}

/** Token ids of the best hypothesis, without <s>, language, style and </s>. */
export async function beamSearch(
  cfg: DuyuConfig,
  next: NextLogits,
  logp: Float32Array,
  frames: number,
  opts: SearchOptions,
): Promise<number[]> {
  const V = cfg.vocabSize;
  const K = opts.beam;
  const ctcSeq = ctcGreedy(logp, frames, V, cfg.pad);
  let maxLen = Math.min(cfg.maxPositions - 4, 8 + Math.floor(frames / 3));
  if (opts.ctcWeight > 0) maxLen = Math.min(maxLen, runawayBound(ctcSeq.length));

  const control = [...Object.values(cfg.lang), ...Object.values(cfg.style)];
  const langIds = opts.lang === null ? Object.values(cfg.lang) : [cfg.lang[opts.lang]];
  const cased = cfg.style.cased;

  let tokens: number[][] = Array.from({ length: K }, () => [cfg.bos]);
  let scores = new Float64Array(K).fill(NEG);
  scores[0] = 0;
  let finished = new Array<boolean>(K).fill(false);
  const topScore = new Float64Array(K);
  const topIdx = new Int32Array(K);

  for (let t = 0; t < maxLen + N_PREFIX - 1; t++) {
    const len = t + 1;
    const flat = new BigInt64Array(K * len);
    for (let k = 0; k < K; k++) for (let i = 0; i < len; i++) flat[k * len + i] = BigInt(tokens[k][i]);
    const lp = await next(flat, K, len);
    for (let k = 0; k < K; k++) {
      const row = k * V;
      logSoftmaxRow(lp, row, V);
      if (t === 0) {
        const keep = new Float32Array(V).fill(NEG);
        for (const id of langIds) keep[id] = lp[row + id];
        lp.set(keep, row);
      } else if (t === 1) {
        lp.fill(NEG, row, row + V);
        lp[row + cased] = 0;
      } else {
        lp[row + cfg.pad] = NEG;
        lp[row + cfg.bos] = NEG;
        for (const id of control) lp[row + id] = NEG;
      }
      if (finished[k]) {
        lp.fill(NEG, row, row + V);
        lp[row + cfg.eos] = 0;
      }
    }

    // The K best (beam, token) pairs over every beam's candidates.
    topScore.fill(-Infinity);
    for (let k = 0; k < K; k++) {
      const base = scores[k];
      for (let v = 0; v < V; v++) {
        const c = base + lp[k * V + v];
        if (c <= topScore[K - 1]) continue;
        let j = K - 1;
        while (j > 0 && topScore[j - 1] < c) {
          topScore[j] = topScore[j - 1];
          topIdx[j] = topIdx[j - 1];
          j--;
        }
        topScore[j] = c;
        topIdx[j] = k * V + v;
      }
    }
    const nextTokens: number[][] = [];
    const nextFinished: boolean[] = [];
    for (let j = 0; j < K; j++) {
      const b = Math.floor(topIdx[j] / V);
      const tok = topIdx[j] % V;
      nextTokens.push([...tokens[b], tok]);
      nextFinished.push(finished[b] || tok === cfg.eos);
    }
    tokens = nextTokens;
    finished = nextFinished;
    scores = Float64Array.from(topScore);
    if (t >= N_PREFIX && finished.every(Boolean)) break;
  }

  // Final ranking with the CTC score.
  const hyps = tokens.map((seq) => {
    const body = seq.slice(N_PREFIX);
    const end = body.indexOf(cfg.eos);
    return end >= 0 ? body.slice(0, end) : body;
  });
  const w = opts.ctcWeight;
  const total = hyps.map((h, k) => {
    let s = scores[k];
    if (w > 0) s = (1 - w) * s - w * ctcNll(logp, frames, V, h, cfg.pad);
    return Number.isFinite(s) ? s / Math.max(h.length + 1, 1) : -Infinity;
  });
  const order = total.map((_, k) => k).sort((a, b) => total[b] - total[a]);
  if (w > 0) {
    if (ctcSeq.length <= 1 && hyps[order[0]].length > ctcSeq.length + 1) return []; // silence veto
    for (const k of order) if (Number.isFinite(total[k]) && !isRunaway(hyps[k], ctcSeq.length)) return hyps[k];
    return ctcSeq; // every beam loops
  }
  return hyps[order[0]];
}
