// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { Word } from "../engine";

/** Subtitle files that can be opened in place of a transcription. */
export const SUBTITLE_EXTS = [".srt", ".vtt"];

export const isSubtitle = (name: string) => SUBTITLE_EXTS.some((e) => name.toLowerCase().endsWith(e));

/** UTF-8, or Windows-1254 (Turkish) for files saved by older Windows tools. */
export async function readSubtitle(f: File): Promise<string> {
  const bytes = await f.arrayBuffer();
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1254").decode(bytes);
  }
}

// "01:02:03,456" (SRT), "01:02:03.456" or "02:03.456" (VTT).
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[,.](\d{1,3}))?/;
const ARROW = new RegExp(`${TIME.source}\\s*-->\\s*${TIME.source}`);

const seconds = (h = "0", m: string, s: string, ms = "0") =>
  +h * 3600 + +m * 60 + +s + +ms.padEnd(3, "0") / 1000;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** Cue text without markup: VTT tags and timestamps, HTML tags, {\an8}-style codes, entities. */
const clean = (s: string) =>
  s
    .replace(/<[^>]*>/g, " ")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, e: string) => ENTITIES[e])
    .replace(/&(lrm|rlm);|[‎‏]/g, "");

/**
 * Words with times from an SRT or VTT file. Each cue's words share its time
 * in proportion to their length. Throws a readable message when the file
 * holds no cues.
 */
export function parseSubtitles(text: string): Word[] {
  const cues: { start: number; end: number; tokens: string[] }[] = [];
  const blocks = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => ARROW.test(l));
    if (at < 0) continue; // Header, NOTE, STYLE or a stray line.
    const t = lines[at].match(ARROW)!;
    const start = seconds(t[1], t[2], t[3], t[4]);
    const end = seconds(t[5], t[6], t[7], t[8]);
    // Dialogue dashes and music notes are not words.
    const tokens = clean(lines.slice(at + 1).join(" "))
      .split(/\s+/)
      .filter((w) => w && !/^[-–—♪♫]+$/.test(w));
    if (tokens.length && end > start) cues.push({ start, end, tokens });
  }
  if (!cues.length) throw new Error("Bu dosyada okunabilir altyazı bulunamadı.");

  // Words must run forward in time: overlapping cues are pushed back.
  cues.sort((a, b) => a.start - b.start);
  const words: Word[] = [];
  let last = 0;
  for (const c of cues) {
    const lo = Math.max(c.start, last);
    const hi = Math.max(c.end, lo + 0.05 * c.tokens.length);
    const weights = c.tokens.map((w) => w.length + 1);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = lo;
    c.tokens.forEach((text, i) => {
      const d = ((hi - lo) * weights[i]) / total;
      words.push(i ? { text, start: t, end: t + d } : { text, start: t, end: t + d, cue: true });
      t += d;
    });
    last = hi;
  }
  return words;
}
