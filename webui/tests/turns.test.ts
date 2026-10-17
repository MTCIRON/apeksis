// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// "Son turu gönder" needs to know where the newest turn starts
// (docs/merge-plan-2-integration.md, Aşama 9). It takes the newest boundary the
// recognizer itself marked, and only when there is none does it fall back to the
// last sentence, then to the newest words.

import { describe, expect, it } from "vitest";

import { lastTurnText } from "../src/studio/lib/turns";
import type { Word } from "../src/studio/engine";

const w = (text: string, cue = false): Word => ({ text, start: 0, end: 1, ...(cue ? { cue: true } : {}) });

describe("lastTurnText", () => {
  it("is empty for an empty transcript", () => {
    expect(lastTurnText([])).toBe("");
  });

  it("takes the newest cue line when the recognizer marked lines", () => {
    const words = [w("bir", true), w("iki"), w("üç", true), w("dört")];
    expect(lastTurnText(words)).toBe("üç dört");
  });

  it("takes the newest sentence when there are no line marks", () => {
    const words = [w("bir"), w("iki."), w("üç"), w("dört")];
    expect(lastTurnText(words)).toBe("üç dört");
  });

  it("takes the newest words when the text has no punctuation either", () => {
    const words = Array.from({ length: 30 }, (_, i) => w(`k${i}`));
    const text = lastTurnText(words);
    expect(text.split(" ")).toHaveLength(25);
    expect(text.endsWith("k29")).toBe(true);
  });

  it("keeps the whole transcript when it is short", () => {
    expect(lastTurnText([w("bir"), w("iki")])).toBe("bir iki");
  });
});
