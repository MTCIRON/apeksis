// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { Word } from "../engine";

export interface Cue {
  start: number;
  end: number;
  /** Index of the first word in the flat word list. */
  first: number;
  words: Word[];
}

export interface CueRules {
  /** A pause this long starts a new cue. */
  gap: number;
  maxDuration: number;
  maxChars: number;
  maxWords?: number;
  /**
   * A cue shown shorter than this (until the next word starts) takes the
   * next word too, even past maxWords, so short words do not flash by.
   */
  minDuration?: number;
}

/** Subtitle-friendly defaults: two lines of ~42 characters. */
export const SUBTITLE_RULES: CueRules = { gap: 0.8, maxDuration: 6.5, maxChars: 84 };

/** On-screen reading: longer lines, broken at pauses. */
export const READING_RULES: CueRules = { gap: 0.8, maxDuration: 14, maxChars: 220 };

export function buildCues(words: Word[], rules: CueRules = SUBTITLE_RULES): Cue[] {
  const cues: Cue[] = [];
  let cur: Cue | null = null;
  let chars = 0;
  words.forEach((w, i) => {
    const prev = i > 0 ? words[i - 1].text : "";
    // A sentence end starts a new cue, unless the cue would be a lone word.
    const sentenceEnd = /[.?!…]$/.test(prev) && !!cur && (chars >= 12 || cur.end - cur.start >= 0.8);
    // A cue of maxWords takes one more word only while it would flash by,
    // and never past a sentence end.
    const brief = !!cur && w.start - cur.start < (rules.minDuration ?? 0) && !/[.?!…]$/.test(prev);
    const full = !!cur && cur.words.length >= (rules.maxWords ?? Infinity) && !brief;
    const brk =
      !cur ||
      sentenceEnd ||
      full ||
      w.start - cur.end >= rules.gap ||
      w.end - cur.start > rules.maxDuration ||
      chars + 1 + w.text.length > rules.maxChars;
    if (brk) {
      cur = { start: w.start, end: w.end, first: i, words: [w] };
      cues.push(cur);
      chars = w.text.length;
    } else {
      cur!.words.push(w);
      cur!.end = w.end;
      chars += 1 + w.text.length;
    }
  });
  return cues;
}

/**
 * The lines of an imported subtitle file (words marked `cue`), or null when
 * the words were transcribed. Subtitle exports and the transcript keep them;
 * caption styles still group words their own way.
 */
export function importedCues(words: Word[]): Cue[] | null {
  if (!words.some((w) => w.cue)) return null;
  const cues: Cue[] = [];
  words.forEach((w, i) => {
    const cur = cues[cues.length - 1];
    if (w.cue || !cur) cues.push({ start: w.start, end: w.end, first: i, words: [w] });
    else {
      cur.words.push(w);
      cur.end = w.end;
    }
  });
  return cues;
}

export const cueText = (c: Cue) => c.words.map((w) => w.text).join(" ");
