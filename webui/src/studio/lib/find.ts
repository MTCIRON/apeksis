// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { Word } from "../engine";
import { replaceRange } from "./edit";

/** A hit in the transcript read as one text (words joined by single spaces). */
export interface Match {
  /** First and last word the hit touches. */
  first: number;
  last: number;
  /** Character range in the joined text. */
  from: number;
  to: number;
}

// Lower case in the text's language (Turkish: I -> ı) that never changes the
// length, so offsets in the folded text are offsets in the original.
const fold = (s: string, lang: string) =>
  Array.from(s, (c) => {
    const l = c.toLocaleLowerCase(lang);
    return l.length === c.length ? l : c;
  }).join("");

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);

/** Collapse runs of spaces the way the joined transcript does. */
export const squash = (s: string) => s.trim().split(/\s+/).filter(Boolean).join(" ");

/** Start offset of every word in the joined text. */
function offsets(words: Word[]): number[] {
  const out = new Array<number>(words.length);
  let at = 0;
  words.forEach((w, i) => {
    out[i] = at;
    at += w.text.length + 1;
  });
  return out;
}

/**
 * Every non-overlapping occurrence of `query`, ignoring case. A query may
 * span several words. With `wholeWord`, hits must not touch a letter or
 * digit on either side (so "Ali" finds "Ali'nin" but not "Alim").
 */
export function findMatches(words: Word[], query: string, wholeWord = false, lang = "tr"): Match[] {
  const q = fold(squash(query), lang);
  if (!q || !words.length) return [];
  const text = fold(words.map((w) => w.text).join(" "), lang);
  const starts = offsets(words);
  const out: Match[] = [];
  let w = 0;
  for (let from = text.indexOf(q); from >= 0; ) {
    const to = from + q.length;
    if (wholeWord && (isWordChar(text[from - 1]) || isWordChar(text[to]))) {
      from = text.indexOf(q, from + 1);
      continue;
    }
    while (w + 1 < words.length && starts[w + 1] <= from) w++;
    let last = w;
    while (last + 1 < words.length && starts[last + 1] < to) last++;
    out.push({ first: w, last, from, to });
    from = text.indexOf(q, to);
  }
  return out;
}

/** Capitalise the replacement when the text it replaces started with a capital. */
function keepCapital(found: string, replacement: string, lang: string): string {
  const a = found[0];
  const b = replacement[0];
  if (!a || !b || fold(a, lang) === a || fold(b, lang) !== b) return replacement;
  return b.toLocaleUpperCase(lang) + replacement.slice(1);
}

/**
 * Replace the given hits (from findMatches on the same words) with
 * `replacement`. Words left untouched keep their timing; see replaceRange.
 */
export function replaceMatches(words: Word[], matches: Match[], replacement: string, lang = "tr"): Word[] {
  if (!matches.length) return words;
  const text = words.map((w) => w.text).join(" ");
  const starts = offsets(words);
  const rep = squash(replacement);

  // Hits that share a word are rewritten together.
  const groups: Match[][] = [];
  for (const m of matches) {
    const g = groups[groups.length - 1];
    if (g && m.first <= g[g.length - 1].last) g.push(m);
    else groups.push([m]);
  }

  // Back to front, so earlier word indices stay valid.
  let out = words;
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    const first = g[0].first;
    const last = g[g.length - 1].last;
    let at = starts[first];
    let next = "";
    for (const m of g) {
      next += text.slice(at, m.from) + keepCapital(text.slice(m.from, m.to), rep, lang);
      at = m.to;
    }
    next += text.slice(at, starts[last] + words[last].text.length);
    out = replaceRange(out, first, last - first + 1, next);
  }
  return out;
}
