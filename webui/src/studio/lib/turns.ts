// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Picking the text of "the current turn" out of the transcript
// (docs/merge-plan-2-integration.md, Aşama 9).
//
// The session bar sends what the workspace already holds — there is no second
// text box. The selection is the explicit gesture; this is the fallback for when
// nothing is selected. It never invents a boundary: it takes the newest words
// the recognizer itself marked as a line (`cue`), and only when the transcript
// has no line marks at all does it fall back to the last sentence, then to the
// newest words.

import type { Word } from "../engine";

/** How many words the last resort keeps. */
const TAIL_WORDS = 25;

const ENDS_SENTENCE = /[.!?…]["')\]]?$/;

/** The text of the newest turn in a transcript. */
export function lastTurnText(words: Word[]): string {
  if (!words.length) return "";
  // A line mark is the recognizer's own boundary — the strongest signal.
  let start = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i].cue) {
      start = i;
      break;
    }
  }
  // No line marks: the newest sentence, if the text has any punctuation.
  if (start < 0) {
    for (let i = words.length - 1; i > 0; i--) {
      if (ENDS_SENTENCE.test(words[i - 1].text)) {
        start = i;
        break;
      }
    }
  }
  if (start < 0) start = Math.max(0, words.length - TAIL_WORDS);
  return words
    .slice(start)
    .map((w) => w.text)
    .join(" ")
    .trim();
}
