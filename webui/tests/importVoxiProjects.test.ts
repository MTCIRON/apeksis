// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The one-time Voxi → studio project import (docs/merge-plan-2-integration.md, Aşama 7).
//
// Guards the two conversions that decide whether a user's old project survives
// intact: milliseconds → seconds (and the segment-only fallback), and the old
// subtitle style → studio caption settings (only what maps one-to-one, with
// the changed keys recorded as the user's own).

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, settingsFor } from "../src/studio/captions/style";
import { toSettings, toWords } from "../src/studio/lib/importVoxiProjects";

describe("toWords", () => {
  it("moves word timings from milliseconds to seconds, as they are", () => {
    const words = toWords({
      words: [
        { segmentId: "s1", startMs: 0, endMs: 400, text: "Merhaba" },
        { segmentId: "s1", startMs: 400, endMs: 900, text: "dünya" },
      ],
    });
    expect(words).toEqual([
      { text: "Merhaba", start: 0, end: 0.4 },
      { text: "dünya", start: 0.4, end: 0.9 },
    ]);
  });

  it("does not mark line breaks when the words carry their own timings", () => {
    // The studio groups lines with its own rules; the words are the data.
    const words = toWords({
      words: [
        { segmentId: "s1", startMs: 0, endMs: 400, text: "Bir" },
        { segmentId: "s2", startMs: 400, endMs: 900, text: "iki" },
      ],
    });
    expect(words.every((w) => w.cue === undefined)).toBe(true);
  });

  it("drops entries that are not a usable word instead of inventing times", () => {
    const words = toWords({
      words: [
        { segmentId: "s1", startMs: 0, endMs: 400, text: "  " },
        { segmentId: "s1", startMs: 400, endMs: 300, text: "geri" },
        { segmentId: "s1", startMs: "x", endMs: 900, text: "bozuk" },
        { segmentId: "s1", startMs: 1000, endMs: 1400, text: "sağlam" },
      ],
    });
    expect(words).toEqual([{ text: "sağlam", start: 1, end: 1.4 }]);
  });

  it("falls back to one timed line per segment, marked as a line", () => {
    const words = toWords({
      segments: [
        { startMs: 0, endMs: 2500, text: "Birinci cümle." },
        { startMs: 2500, endMs: 5000, text: "İkinci cümle." },
      ],
    });
    expect(words).toEqual([
      { text: "Birinci cümle.", start: 0, end: 2.5, cue: true },
      { text: "İkinci cümle.", start: 2.5, end: 5, cue: true },
    ]);
  });

  it("is empty when the document holds nothing usable", () => {
    expect(toWords(undefined)).toEqual([]);
    expect(toWords({})).toEqual([]);
    expect(toWords({ words: "yok", segments: 3 })).toEqual([]);
  });
});

describe("toSettings", () => {
  it("maps the five legacy styles to the five matching presets", () => {
    for (const kind of ["klasik", "karaoke", "vurgu", "pop", "sade"] as const) {
      expect(toSettings({ kind }).preset).toBe(kind);
    }
  });

  it("keeps the default preset for a style it does not know", () => {
    expect(toSettings({ kind: "bilinmeyen" }).preset).toBe(DEFAULT_SETTINGS.preset);
    expect(toSettings(undefined).preset).toBe(DEFAULT_SETTINGS.preset);
  });

  it("moves the fields that map one-to-one", () => {
    const s = toSettings({
      kind: "klasik",
      position: "center",
      uppercase: true,
      color: "#123456",
      highlightColor: "#abcdef",
      backgroundColor: "transparent",
      fontFamily: "Inter",
    });
    expect(s.position).toBe("middle");
    expect(s.uppercase).toBe(true);
    expect(s.textColor).toBe("#123456");
    expect(s.accentColor).toBe("#abcdef");
    expect(s.background).toBe("outline");
    expect(s.font).toBe("inter");
  });

  it("uses a box for any non-transparent legacy background", () => {
    expect(toSettings({ kind: "klasik", backgroundColor: "rgba(0,0,0,0.6)" }).background).toBe("box");
  });

  it("ignores a font that exists on neither side", () => {
    const base = settingsFor("klasik");
    expect(toSettings({ kind: "klasik", fontFamily: "Comic Sans" }).font).toBe(base.font);
  });

  it("records what the import changed, so a preset switch keeps it", () => {
    const s = toSettings({ kind: "klasik", color: "#123456", position: "top" });
    expect(s.overrides).toContain("textColor");
    expect(s.overrides).toContain("position");
    // Unchanged keys are not the user's own.
    expect(s.overrides).not.toContain("uppercase");
  });

  it("leaves a legacy style that already matches the preset without overrides", () => {
    const s = toSettings({ kind: "klasik" });
    expect(s.overrides).toEqual([]);
    expect(s.preset).toBe("klasik");
  });
});
