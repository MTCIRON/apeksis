// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Turkish number words -> digits, on finished (punctuated) transcript words:
// "bin dokuz yüz yirmi üçte" -> "1923'te", "yirminci" -> "20.".
//
// Several words become one, so the result says how many input words each
// output word covers; the caller merges their timing. Numbers below `min`
// stay as words (TDK writes small numbers in words: "üç kişi"), round millions
// keep their scale word ("15 milyon"), dates and times are always digits
// ("23 Nisan 1920", "saat 15.30"), and words
// that are also ordinary words on their own ("bir gün", "altı", "yedi",
// "yüz", "bin") are only converted as part of a longer number.

import type { Word } from "../engine";

/**
 * How numbers end up written, whichever model wrote them: "rule" (the
 * default, TDK) has 10 and up in digits and 1-9 in words, "all" has every
 * number in digits, "keep" leaves the transcript as the model wrote it.
 */
export type NumberMode = "rule" | "all" | "keep";

const UNITS: Record<string, number> = { bir: 1, iki: 2, üç: 3, dört: 4, beş: 5, altı: 6, yedi: 7, sekiz: 8, dokuz: 9 };
const TENS: Record<string, number> = {
  on: 10, yirmi: 20, otuz: 30, kırk: 40, elli: 50, altmış: 60, yetmiş: 70, seksen: 80, doksan: 90,
};
const SCALES: Record<string, number> = { bin: 1e3, milyon: 1e6, milyar: 1e9, trilyon: 1e12 };
const BASES = [...Object.keys(UNITS), ...Object.keys(TENS), "yüz", ...Object.keys(SCALES)].sort(
  (a, b) => b.length - a.length,
);

/** Ordinary words on their own: converted only inside a longer number. */
const AMBIGUOUS = new Set(["bir", "altı", "yedi", "yüz", "bin"]);

// Suffixes a number takes ("üçte", "yirmisinde", "seksenli", "on dördünde").
const CASE = "(?:[dt][ae](?:n|ki)?|y?[ae]|y?[ıiuü]|n?[ıiuü]n|y?l[ae]|[dt][ıiuü]r|y?d[ıiuü]|y?ken)";
const AFTER_POSSESSIVE = "(?:n[dt][ae](?:n|ki)?|n[ae]|n[ıiuü]n?|yl[ae]|[dt][ıiuü]r|yd[ıiuü])";
const SUFFIX = new RegExp(`^(?:${CASE}|l[ae]r${CASE}?|(?:l[ae]r)?s?[ıiuü]${AFTER_POSSESSIVE}?|l[ıiuü]k?)$`);
const ORDINAL = /^[ıiuü]?nc[ıiuü]$/;

const lower = (s: string) => s.toLocaleLowerCase("tr-TR");

interface NumberWord {
  base: string;
  value: number;
  kind: "unit" | "ten" | "hundred" | "scale";
  /** Suffix after the number, kept after an apostrophe ("te" in "üçte"). */
  suffix: string;
  ordinal: boolean;
  /** Punctuation after the word. */
  post: string;
  /** The word itself, lowercase, without the punctuation. */
  word: string;
}

function analyse(word: string): NumberWord | null {
  const m = /^(.*?)([.,;:!?…]*)$/u.exec(lower(word))!;
  const [, w, post] = m;
  for (const base of BASES) {
    // "dört" softens before a vowel: "dördü", "dördüncü".
    const stem = base === "dört" && /^dörd[üu]/.test(w) ? "dörd" : base;
    if (!w.startsWith(stem)) continue;
    const rest = w.slice(stem.length);
    const ordinal = ORDINAL.test(rest);
    if (rest && !ordinal && !SUFFIX.test(rest)) continue;
    const kind = base in UNITS ? "unit" : base in TENS ? "ten" : base === "yüz" ? "hundred" : "scale";
    const value = UNITS[base] ?? TENS[base] ?? SCALES[base] ?? 100;
    return { base, value, kind, suffix: ordinal ? "" : rest, ordinal, post, word: w };
  }
  return null;
}

/** The longest number starting at words[i]: its value, word count and last word. */
function parse(words: string[], i: number): { value: number; count: number; last: NumberWord } | null {
  let total = 0;
  let group = 0; // below a thousand, within the current scale
  let prev: NumberWord["kind"] | "start" = "start";
  let lastScale = Infinity;
  let last: NumberWord | null = null;
  let j = i;
  for (; j < words.length; j++) {
    const a = analyse(words[j]);
    if (!a) break;
    if (a.kind === "unit") {
      if (prev === "unit") break; // "beş altı kişi" is a range, not 56
      group += a.value;
    } else if (a.kind === "ten") {
      if (prev === "unit" || prev === "ten") break;
      group += a.value;
    } else if (a.kind === "hundred") {
      if (prev === "ten" || prev === "hundred" || (prev === "unit" && group === 1)) break; // "bir yüz" is a face
      group = (prev === "unit" ? group : 1) * 100;
    } else {
      if (a.value >= lastScale || (prev === "unit" && group === 1 && a.value === 1e3)) break;
      total += (group || 1) * a.value;
      group = 0;
      lastScale = a.value;
    }
    prev = a.kind;
    last = a;
    // A suffix, an ordinal or punctuation ends the number.
    if (a.suffix || a.ordinal || a.post) {
      j++;
      break;
    }
  }
  return last ? { value: total + group, count: j - i, last } : null;
}

/** 1923, 3000, 15.000, 1.717.942: dots from five digits on, as usually written. */
export function formatNumber(n: number): string {
  const s = String(n);
  return n < 10000 ? s : s.replace(/\B(?=(\d{3})+$)/g, ".");
}

/** Replace number words with digits. Each output word covers `count` input words. */
const MONTHS = ["ocak", "şubat", "mart", "nisan", "mayıs", "haziran", "temmuz", "ağustos", "eylül", "ekim", "kasım", "aralık"];
/** Also ordinary words: "bir aralık" (at one point), "bir ocak" (a hearth). */
const AMBIGUOUS_MONTHS = new Set(["ocak", "ekim", "aralık"]);
const CASE_ONLY = new RegExp(`^${CASE}$`);

/** Split a word into a base from `bases` and a case suffix: "nisanda" -> nisan + da. */
function withCase(word: string | undefined, bases: string[]): { base: string; suffix: string; post: string } | null {
  if (!word) return null;
  const [, w, post] = /^(.*?)([.,;:!?…]*)$/u.exec(lower(word))!;
  for (const base of bases) {
    const rest = w.slice(base.length);
    if (w.startsWith(base) && (!rest || CASE_ONLY.test(rest))) return { base, suffix: rest, post };
  }
  return null;
}

const withSuffix = (text: string, suffix: string, post: string) => (suffix ? `${text}'${suffix}` : text) + post;

/** "on beş otuzda" after "saat": 15.30'da; "üç buçuk" 3.30; "dokuzda" 9'da. */
function time(words: string[], k: number): { text: string; count: number } | null {
  const hour = parse(words, k);
  if (!hour || hour.value > 24 || hour.last.ordinal) return null;
  const h = String(hour.value);
  if (hour.last.suffix || hour.last.post) return { text: withSuffix(h, hour.last.suffix, hour.last.post), count: hour.count };
  const half = withCase(words[k + hour.count], ["buçuk"]);
  // "buçukta" is written as read: 3.30 is "üç otuz", so 3.30'da.
  if (half) return { text: withSuffix(`${h}.30`, half.suffix.replace(/^t/, "d"), half.post), count: hour.count + 1 };
  const minute = parse(words, k + hour.count);
  if (minute && minute.value >= 1 && minute.value <= 59 && !minute.last.ordinal) {
    const m = String(minute.value).padStart(2, "0");
    return { text: withSuffix(`${h}.${m}`, minute.last.suffix, minute.last.post), count: hour.count + minute.count };
  }
  return { text: h, count: hour.count };
}

export function digitize(words: string[], min = 10): { text: string; count: number }[] {
  const out: { text: string; count: number }[] = [];
  for (let i = 0; i < words.length; ) {
    // Times and dates are written in digits whatever the threshold.
    if (lower(words[i]) === "saat") {
      const t = time(words, i + 1);
      if (t) {
        out.push({ text: words[i], count: 1 }, t);
        i += 1 + t.count;
        continue;
      }
    }
    // A day already in digits (punctuated again after conversion): "23 nisanda" -> "23 Nisan'da".
    const dayDigits = /^([1-9]|[12]\d|3[01])$/.test(words[i]) ? withCase(words[i + 1], MONTHS) : null;
    if (dayDigits) {
      const name = dayDigits.base[0].toLocaleUpperCase("tr-TR") + dayDigits.base.slice(1);
      out.push({ text: words[i], count: 1 }, { text: withSuffix(name, dayDigits.suffix, dayDigits.post), count: 1 });
      i += 2;
      continue;
    }
    const n = parse(words, i);
    if (n && n.value >= 1 && n.value <= 31 && !n.last.ordinal && !n.last.suffix && !n.last.post) {
      const month = withCase(words[i + n.count], MONTHS);
      // "bir aralık" is a date only with a year after it.
      const ambiguous = n.count === 1 && n.last.base === "bir" && month && AMBIGUOUS_MONTHS.has(month.base);
      if (month && (!ambiguous || (!month.suffix && !month.post && parse(words, i + n.count + 1)))) {
        const name = month.base[0].toLocaleUpperCase("tr-TR") + month.base.slice(1);
        out.push({ text: String(n.value), count: n.count }, { text: withSuffix(name, month.suffix, month.post), count: 1 });
        i += n.count + 1;
        continue;
      }
    }
    const single = n?.count === 1;
    const skip =
      !n ||
      n.value < min ||
      (single && !n.last.ordinal && AMBIGUOUS.has(n.last.base)) ||
      (single && n.last.base === "on" && !!n.last.suffix) || // "onu", "ona", "onun": the pronoun
      (single && n.last.kind === "scale"); // "20 milyon", "milyonlarca": not "1 milyon" on its own
    if (skip) {
      out.push({ text: words[i], count: 1 });
      i++;
      continue;
    }
    const { value, count, last } = n;
    // Round millions and up keep their scale word: "15 milyon", "2 milyarın".
    if (last.kind === "scale" && last.value >= 1e6 && !last.ordinal && value % last.value === 0 && value / last.value < 1000) {
      out.push({ text: `${value / last.value} ${last.word}${last.post}`, count });
      i += count;
      continue;
    }
    const digits = formatNumber(value);
    let text = last.ordinal ? `${digits}.` : last.suffix ? `${digits}'${last.suffix}` : digits;
    text += last.ordinal && last.post.startsWith(".") ? last.post.slice(1) : last.post;
    out.push({ text, count });
    i += count;
  }
  return out;
}

// Digits that stay digits under "rule": "sayfa 3", "3 Mart", "3 km", "3 milyon".
const KEEP_AFTER = new Set(["saat", "sayfa", "bölüm", "madde", "sezon", "numara", "no", "oda", "kat", "peron", "yüzde"]);
const KEEP_BEFORE = new Set([...MONTHS, "bin", "milyon", "milyar", "trilyon", "km", "m", "cm", "mm", "kg", "g", "lt", "ml", "tl", "lira", "kuruş", "dolar", "euro", "avro", "sterlin"]);
const SMALL_DIGIT = /^([1-9])(?:'(\p{L}+))?([,;:!?…]*)$/u;

/** 1-9 written in digits back in words: "3 kişi" -> "üç kişi", "4'ü" -> "dördü" (TDK writes small numbers in words). */
export function spellSmall(words: string[]): string[] {
  const bare = (w: string | undefined) => (w ? lower(w).replace(/[.,;:!?…]+$/, "") : "");
  return words.map((word, i) => {
    const m = SMALL_DIGIT.exec(word);
    if (!m || KEEP_AFTER.has(bare(words[i - 1])) || KEEP_BEFORE.has(bare(words[i + 1]))) return word;
    // A bare number next to it makes a range or a list: "3 4 kişi" stays as it is.
    if (/^\d+$/.test(words[i - 1] ?? "") || /^\d+$/.test(words[i + 1] ?? "")) return word;
    const [, digit, suffix = "", post] = m;
    let text = UNIT_WORDS[Number(digit)];
    if (suffix) text = (text === "dört" && /^[aeıioöuü]/.test(suffix) ? "dörd" : text) + suffix;
    const sentenceStart = i === 0 || /[.?!…]$/.test(words[i - 1]);
    if (sentenceStart) text = text[0].toLocaleUpperCase("tr-TR") + text.slice(1);
    return text + post;
  });
}

/** Write the transcript's numbers in the chosen way. Merged words span from the first one's start to the last one's end. */
export function writeNumbers(words: Word[], mode: NumberMode): Word[] {
  if (mode === "keep") return words;
  const out: Word[] = [];
  for (let k = 0; k < words.length; ) {
    // Each line of an imported subtitle is converted on its own.
    let end = k + 1;
    while (end < words.length && !words[end].cue) end++;
    const line = words.slice(k, end);
    const merged = digitize(line.map((w) => w.text), mode === "all" ? 1 : 10);
    const texts = mode === "rule" ? spellSmall(merged.map((o) => o.text)) : merged.map((o) => o.text);
    let j = 0;
    merged.forEach((o, n) => {
      const first = line[j];
      const text = texts[n];
      out.push(o.count === 1 && text === first.text ? first : { ...first, text, end: line[j + o.count - 1].end });
      j += o.count;
    });
    k = end;
  }
  return out;
}

const UNIT_WORDS = ["", "bir", "iki", "üç", "dört", "beş", "altı", "yedi", "sekiz", "dokuz"];
const TEN_WORDS = ["", "on", "yirmi", "otuz", "kırk", "elli", "altmış", "yetmiş", "seksen", "doksan"];

/** 1923 -> "bin dokuz yüz yirmi üç" (the reverse of digitize, for tests and turning it off). */
export function spellNumber(n: number): string {
  if (n === 0) return "sıfır";
  const words: string[] = [];
  const below1000 = (x: number) => {
    const h = Math.floor(x / 100);
    if (h) words.push(...(h > 1 ? [UNIT_WORDS[h], "yüz"] : ["yüz"]));
    if (Math.floor((x % 100) / 10)) words.push(TEN_WORDS[Math.floor((x % 100) / 10)]);
    if (x % 10) words.push(UNIT_WORDS[x % 10]);
  };
  for (const [name, scale] of [["trilyon", 1e12], ["milyar", 1e9], ["milyon", 1e6], ["bin", 1e3]] as const) {
    const part = Math.floor(n / scale) % 1000;
    if (!part) continue;
    if (!(name === "bin" && part === 1)) below1000(part);
    words.push(name);
  }
  below1000(n % 1000);
  return words.join(" ");
}

/** The ordinal word of a spelled number: "yirmi" -> "yirminci", "dört" -> "dördüncü". */
export function ordinalWord(spelled: string): string {
  const softened = spelled.replace(/dört$/, "dörd");
  const vowels = [...softened].filter((c) => "aeıioöuü".includes(c));
  const v = vowels[vowels.length - 1];
  const harmony = "aı".includes(v) ? "ı" : "ei".includes(v) ? "i" : "ou".includes(v) ? "u" : "ü";
  return /[aeıioöuü]$/.test(softened) ? `${softened}nc${harmony}` : `${softened}${harmony}nc${harmony}`;
}
