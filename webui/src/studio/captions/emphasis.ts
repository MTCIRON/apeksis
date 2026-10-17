// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// "Sesle vurgula": picks the words said louder than the speech around them,
// from the speech band's loudness (log-mel, BAND_RATE frames a second).
//
// Not the aura's band levels: those stop at loud speech, and mastered video
// sound sits there almost all the time, so nothing stood out. Only the
// middle of each word is read, away from its neighbours' edges. Words are compared with their neighbours within WINDOW seconds,
// not the whole file, so a quieter speaker or a new microphone later on still
// gets its own emphasis.

import type { Word } from "../engine";
import { BAND_RATE } from "../render/aura";

/** Seconds either side a word is compared within. */
const WINDOW = 10;
/** A word must be in the loudest share of its neighbourhood... */
const TOP = 0.15;
/** ...and clearly above its middle (log-mel units; 1 is about 4.3 dB). */
const MARGIN = 0.8;
/** Fewer neighbours than this and the comparison means little. */
const MIN_NEIGHBOURS = 6;
/** Loudness of each word: the peak over the middle of the word; NaN without frames there. */
function wordLoudness(words: Word[], loudness: Float32Array): number[] {
  const frames = loudness.length;
  return words.map((w) => {
    const d = w.end - w.start;
    const a = Math.floor((w.start + d * 0.2) * BAND_RATE);
    const b = Math.max(a, Math.ceil((w.end - d * 0.2) * BAND_RATE));
    if (a < 0 || b >= frames) return NaN;
    let peak = -Infinity;
    for (let f = a; f <= b; f++) peak = Math.max(peak, loudness[f]);
    return peak;
  });
}

const quantile = (sorted: number[], q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];

/** The words to emphasise (the same objects as in `words`). */
export function loudWords(words: Word[], loudness: Float32Array): Set<Word> {
  const out = new Set<Word>();
  if (!loudness.length || !words.length) return out;
  const level = wordLoudness(words, loudness);
  const mid = words.map((w) => (w.start + w.end) / 2);
  let lo = 0;
  let hi = 0;
  words.forEach((w, i) => {
    if (Number.isNaN(level[i])) return;
    // Words are in time order: slide the neighbourhood along.
    while (mid[lo] < mid[i] - WINDOW) lo++;
    while (hi < words.length && mid[hi] <= mid[i] + WINDOW) hi++;
    const near = level.slice(lo, hi).filter((v) => !Number.isNaN(v));
    if (near.length < MIN_NEIGHBOURS) return;
    near.sort((x, y) => x - y);
    if (level[i] >= quantile(near, 1 - TOP) && level[i] >= quantile(near, 0.5) + MARGIN) out.add(w);
  });
  return out;
}
