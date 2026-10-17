// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Word timestamps from cross-attention, following openai-whisper's
// find_alignment: the alignment heads' attention over the audio frames is
// normalised per frame, median filtered, averaged, and aligned to the tokens
// with dynamic time warping. Each encoder frame is 20 ms.

import type { Word } from "../engine/tokens";
import type { WhisperTokenizer } from "./tokenizer";

export const FRAME_SEC = 0.02;

/**
 * heads: attention of each alignment head, [rows, 1500] row-major, where row
 * r is the query at token position r of the forced sequence
 * (start-of-transcript prompt, text, end-of-text). Returns, for every text
 * token plus the end-of-text, the frame where DTW first reached it.
 */
export function tokenFrames(
  heads: Float32Array[],
  rows: number,
  frames: number,
  promptLen: number,
  medianWidth: number,
): Int32Array {
  const F = Math.max(1, Math.min(frames, 1500));
  const avg = new Float64Array(rows * F);
  const w = new Float64Array(rows * F);
  for (const h of heads) {
    // Softmax over the frames that hold audio: renormalise the kept part.
    for (let r = 0; r < rows; r++) {
      let sum = 0;
      for (let f = 0; f < F; f++) sum += h[r * 1500 + f];
      for (let f = 0; f < F; f++) w[r * F + f] = h[r * 1500 + f] / (sum || 1);
    }
    // Standardise each frame across the tokens.
    for (let f = 0; f < F; f++) {
      let mean = 0;
      for (let r = 0; r < rows; r++) mean += w[r * F + f];
      mean /= rows;
      let v = 0;
      for (let r = 0; r < rows; r++) v += (w[r * F + f] - mean) ** 2;
      const std = Math.sqrt(v / rows) || 1;
      for (let r = 0; r < rows; r++) w[r * F + f] = (w[r * F + f] - mean) / std;
    }
    for (let r = 0; r < rows; r++) medianFilterRow(w, r * F, F, medianWidth, avg, 1 / heads.length);
  }
  // Text tokens plus end-of-text: rows promptLen-1 .. rows-2 (the query
  // before each token is the one that predicts it).
  const first = promptLen - 1;
  const n = rows - 1 - first;
  const cost = new Float64Array(n * F);
  for (let i = 0; i < n; i++) for (let f = 0; f < F; f++) cost[i * F + f] = -avg[(first + i) * F + f];
  return dtwFirstFrames(cost, n, F);
}

/** Adds scale · median-filtered row (reflect padding) into out. */
function medianFilterRow(x: Float64Array, off: number, len: number, width: number, out: Float64Array, scale: number) {
  const half = width >> 1;
  const win = new Float64Array(width);
  for (let i = 0; i < len; i++) {
    for (let k = -half; k <= half; k++) {
      let j = i + k;
      if (j < 0) j = -j;
      if (j >= len) j = 2 * len - 2 - j;
      win[k + half] = x[off + Math.min(Math.max(j, 0), len - 1)];
    }
    win.sort();
    out[off + i] += win[half] * scale;
  }
}

/** DTW over cost [n, m]; for each row, the first column on the path. */
function dtwFirstFrames(x: Float64Array, n: number, m: number): Int32Array {
  const W = m + 1;
  const cost = new Float64Array((n + 1) * W).fill(Infinity);
  const trace = new Int8Array((n + 1) * W).fill(-1);
  cost[0] = 0;
  for (let j = 1; j <= m; j++) {
    for (let i = 1; i <= n; i++) {
      const c0 = cost[(i - 1) * W + j - 1];
      const c1 = cost[(i - 1) * W + j];
      const c2 = cost[i * W + j - 1];
      let c: number;
      let t: number;
      if (c0 < c1 && c0 < c2) [c, t] = [c0, 0];
      else if (c1 < c0 && c1 < c2) [c, t] = [c1, 1];
      else [c, t] = [c2, 2];
      cost[i * W + j] = x[(i - 1) * m + j - 1] + c;
      trace[i * W + j] = t;
    }
  }
  const first = new Int32Array(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    // Walking backwards, the last write per row is its first frame.
    if (i > 0 && j > 0) first[i - 1] = j - 1;
    const t = i === 0 ? 2 : j === 0 ? 1 : trace[i * W + j];
    if (t === 0) {
      i--;
      j--;
    } else if (t === 1) i--;
    else j--;
  }
  return first;
}

const OPENING = new Set([..."\"'“‘«¿([{-"]);
const SENTENCE_END = /[.!?…]["'”’»)]*$/;

/**
 * Group text tokens into words (a leading space starts a word) and time them
 * from tokenFrames(). Lone punctuation joins its neighbour. Words that DTW
 * stretched over a pause are cut to twice the median word length, as in
 * openai-whisper.
 */
export function alignWords(
  tok: WhisperTokenizer,
  tokens: number[],
  frames: Int32Array,
  offset: number,
): Word[] {
  const groups: { bytes: number[]; first: number; last: number }[] = [];
  tokens.forEach((id, i) => {
    const b = tok.tokenBytes(id);
    if (tok.startsWord(id) || !groups.length) groups.push({ bytes: [...b], first: i, last: i });
    else {
      const g = groups[groups.length - 1];
      g.bytes.push(...b);
      g.last = i;
    }
  });
  const utf8 = new TextDecoder();
  let words = groups
    .map((g) => ({
      text: utf8.decode(Uint8Array.from(g.bytes)).trim(),
      start: offset + frames[g.first] * FRAME_SEC,
      end: offset + frames[g.last + 1] * FRAME_SEC,
    }))
    .filter((w) => w.text);

  // Punctuation on its own: opening marks go to the next word, others to the previous.
  const merged: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!/[\p{L}\p{N}]/u.test(w.text)) {
      const next = words[i + 1];
      if (OPENING.has(w.text[0]) && next) {
        words[i + 1] = { ...next, text: w.text + next.text, start: w.start };
        continue;
      }
      const prev = merged[merged.length - 1];
      if (prev) {
        prev.text += w.text;
        prev.end = Math.max(prev.end, w.end);
        continue;
      }
    }
    merged.push({ ...w });
  }
  words = merged;

  const durations = words.map((w) => w.end - w.start).filter((d) => d > 0).sort((a, b) => a - b);
  const median = Math.min(0.7, durations.length ? durations[durations.length >> 1] : 0.7);
  const max = median * 2;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w.end - w.start <= max) continue;
    if (SENTENCE_END.test(w.text)) w.end = w.start + max;
    else if (i === 0 || SENTENCE_END.test(words[i - 1].text)) w.start = w.end - max;
  }
  return words;
}
