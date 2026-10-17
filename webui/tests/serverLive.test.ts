// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The live server provider turns each VAD utterance into words
// (docs/merge-plan-2-integration.md, Aşama 9). The span is the server's own; only
// the distribution inside it is estimated, and the first word carries `cue` so
// the caption grouping keeps the server's line break.

import { describe, expect, it } from "vitest";

import { AUDIO_FRAMES_PER_BLOCK, wordsFromUtterance } from "../src/studio/lib/serverLive";
import { BAND_RATE, PEAK_STEP } from "../src/studio/worker/protocol";

describe("wordsFromUtterance", () => {
  it("spreads the words across the server's own span", () => {
    const words = wordsFromUtterance("bir iki üç", 1, 4);
    expect(words.map((w) => w.text)).toEqual(["bir", "iki", "üç"]);
    expect(words[0].start).toBe(1);
    expect(words[2].end).toBe(4);
    // Contiguous: every word ends where the next one starts.
    expect(words[1].start).toBe(words[0].end);
    expect(words[2].start).toBe(words[1].end);
  });

  it("marks only the first word as a line start", () => {
    const words = wordsFromUtterance("bir iki", 0, 2);
    expect(words[0].cue).toBe(true);
    expect(words[1].cue).toBeUndefined();
  });

  it("collapses whitespace and drops an empty utterance", () => {
    expect(wordsFromUtterance("  bir \n iki  ", 0, 2).map((w) => w.text)).toEqual(["bir", "iki"]);
    expect(wordsFromUtterance("   ", 0, 2)).toEqual([]);
    expect(wordsFromUtterance("", 0, 2)).toEqual([]);
  });

  it("never runs backwards when the span is empty or inverted", () => {
    for (const [words, start] of [
      [wordsFromUtterance("bir iki", 2, 2), 2],
      [wordsFromUtterance("bir iki", 3, 1), 3],
    ] as const) {
      expect(words[0].start).toBe(start);
      expect(words.every((w) => w.end >= w.start)).toBe(true);
      expect(words[words.length - 1].end).toBe(start);
    }
  });
});

describe("audio block bookkeeping", () => {
  it("fills exactly the band frames a 100 ms block covers", () => {
    expect(AUDIO_FRAMES_PER_BLOCK).toBe(Math.round(BAND_RATE * PEAK_STEP));
    expect(AUDIO_FRAMES_PER_BLOCK).toBe(5);
  });
});
