// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// One-time import of the Voxi IndexedDB projects into the studio store
// (docs/merge-plan-2-integration.md, Aşama 7).
//
// Voxi kept a project in the `voxi-webui` / `projects` store as
// `{ title, document, style, audioBlob, createdAt, updatedAt }` — a transcript in
// milliseconds, its subtitle style, and the media as a Blob. The studio keeps a
// project in `apeksis` / `projects` (+ `media`) with seconds, caption settings
// and a real waveform.
//
// This module reads the legacy records ONCE, converts them, writes them into the
// studio store and marks the import done, so it never runs twice. It is
// deliberately self-contained: the legacy modules (lib/idb.ts, lib/transcript.ts,
// lib/subtitles.ts, lib/studioStore.tsx …) are deleted in the same stage, so
// nothing here may import them.
//
// The legacy data is NOT deleted — the import only reads. If a conversion turns
// out wrong the old records are still there.

import { FONTS, type FontId } from "../captions/fonts";
import {
  DEFAULT_SETTINGS,
  presetById,
  settingsFor,
  type CaptionSettings,
  type PresetId,
  type StyleKey,
} from "../captions/style";
import type { Word } from "../engine";
import { PEAK_STEP } from "../worker/protocol";
import { mediaInfo, saveMedia, saveProject, type Project } from "./projectStore";

const LEGACY_DB = "voxi-webui";
const LEGACY_STORE = "projects";
/** Set once the import has run, so it never runs twice. */
const MARK = "apeksis.voxiImported";

export interface VoxiImportReport {
  /** Projects moved into the studio store. */
  imported: number;
  /** Legacy records that held neither a transcript nor media. */
  skipped: number;
  /** The import had already run; nothing was read. */
  alreadyDone: boolean;
}

// ---- The legacy shape, described locally (the old modules are gone) ----

interface LegacyWord {
  segmentId?: unknown;
  startMs?: unknown;
  endMs?: unknown;
  text?: unknown;
}

interface LegacySegment {
  startMs?: unknown;
  endMs?: unknown;
  text?: unknown;
}

interface LegacyDocument {
  durationMs?: unknown;
  words?: unknown;
  segments?: unknown;
}

interface LegacyRecord {
  id?: unknown;
  title?: unknown;
  document?: unknown;
  style?: unknown;
  audioName?: unknown;
  audioBlob?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// ---- Conversion ----

const seconds = (ms: unknown): number | null =>
  typeof ms === "number" && Number.isFinite(ms) ? ms / 1000 : null;

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * The legacy transcript, in studio words (seconds).
 *
 * Voxi stored word timings in milliseconds; they are moved as they are. When a
 * document only has segments (no word timings), each segment becomes one timed
 * line — a real, timed unit, never split or guessed — and is marked as a line
 * boundary (`cue`), the same flag an imported subtitle file uses.
 */
export function toWords(document: unknown): Word[] {
  const doc = (document && typeof document === "object" ? document : {}) as LegacyDocument;

  const rawWords = Array.isArray(doc.words) ? (doc.words as LegacyWord[]) : [];
  const words: Word[] = [];
  for (const w of rawWords) {
    const t = text(w.text);
    const start = seconds(w.startMs);
    const end = seconds(w.endMs);
    if (!t || start === null || end === null || end < start) continue;
    words.push({ text: t, start, end });
  }
  if (words.length) return words;

  const rawSegments = Array.isArray(doc.segments) ? (doc.segments as LegacySegment[]) : [];
  const lines: Word[] = [];
  for (const s of rawSegments) {
    const t = text(s.text);
    const start = seconds(s.startMs);
    const end = seconds(s.endMs);
    if (!t || start === null || end === null || end < start) continue;
    lines.push({ text: t, start, end, cue: true });
  }
  return lines;
}

/** Voxi's five styles are the studio's five matching presets. */
const PRESET_OF: Record<string, PresetId> = {
  klasik: "klasik",
  karaoke: "karaoke",
  vurgu: "vurgu",
  pop: "pop",
  sade: "sade",
};

const isColor = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";

/** A legacy font name, when it names one of the studio's own fonts. */
function toFont(name: unknown): FontId | undefined {
  if (typeof name !== "string") return undefined;
  const key = name.trim().toLowerCase();
  const found = FONTS.find((f) => f.id === key || f.label.toLowerCase() === key);
  return found ? (found.id as FontId) : undefined;
}

/**
 * The legacy subtitle style, as studio caption settings.
 *
 * Only what maps one-to-one is moved (preset, position, uppercase, colours,
 * box/outline, a font that exists on both sides). Everything else keeps the
 * preset's own value: the legacy size is a pixel count and the studio's is
 * relative to the frame, so there is no honest conversion. What the import
 * changed by hand is recorded in `overrides`, the same rule the style picker
 * uses, so switching preset keeps it.
 */
export function toSettings(style: unknown): CaptionSettings {
  const s = (style && typeof style === "object" ? style : {}) as Record<string, unknown>;
  const preset = typeof s.kind === "string" ? PRESET_OF[s.kind] : undefined;
  const base = settingsFor(preset ?? DEFAULT_SETTINGS.preset);

  const patch: Partial<CaptionSettings> = {};
  if (s.position === "top") patch.position = "top";
  else if (s.position === "center") patch.position = "middle";
  else if (s.position === "bottom") patch.position = "bottom";
  if (typeof s.uppercase === "boolean") patch.uppercase = s.uppercase;
  if (isColor(s.color)) patch.textColor = s.color;
  if (isColor(s.highlightColor)) patch.accentColor = s.highlightColor;
  if (isColor(s.backgroundColor)) {
    patch.background = s.backgroundColor === "transparent" ? "outline" : "box";
  }
  const font = toFont(s.fontFamily);
  if (font) patch.font = font;

  const keys = Object.keys(presetById(base.preset).defaults) as StyleKey[];
  const overrides = keys.filter((k) => k in patch && base[k] !== patch[k as keyof CaptionSettings]);
  return { ...base, ...patch, overrides };
}

/**
 * The waveform, from the media itself: one peak per `PEAK_STEP` seconds, the
 * largest absolute sample in that window — the same unit the recognizer fills in
 * while it decodes, so the timeline reads it identically. An empty array (no
 * waveform) when the media cannot be decoded, e.g. a video container; nothing is
 * invented. Bands and loudness stay empty: they come from the studio's own log-mel
 * pass and Voxi never had them.
 */
async function peaksOf(file: File): Promise<Float32Array> {
  const Ctor = window.AudioContext;
  if (!Ctor) return new Float32Array(0);
  const ctx = new Ctor();
  try {
    const buffer = await ctx.decodeAudioData(await file.arrayBuffer());
    const channel = buffer.getChannelData(0);
    if (!channel.length) return new Float32Array(0);
    const buckets = Math.max(1, Math.ceil(buffer.duration / PEAK_STEP));
    const out = new Float32Array(buckets);
    const per = channel.length / buckets;
    for (let i = 0; i < buckets; i++) {
      const from = Math.floor(i * per);
      const to = Math.min(channel.length, Math.floor((i + 1) * per));
      let peak = 0;
      for (let j = from; j < to; j++) {
        const a = Math.abs(channel[j]);
        if (a > peak) peak = a;
      }
      out[i] = peak;
    }
    return out;
  } catch {
    return new Float32Array(0);
  } finally {
    void ctx.close().catch(() => {});
  }
}

const durationOf = (document: unknown): number | null => {
  const doc = (document && typeof document === "object" ? document : {}) as LegacyDocument;
  const ms = seconds(doc.durationMs);
  return ms !== null && ms > 0 ? ms : null;
};

/** One legacy record as a studio project, or null when it holds nothing. */
async function toProject(record: LegacyRecord): Promise<{ project: Project; file: File | null } | null> {
  const words = toWords(record.document);
  const blob = record.audioBlob instanceof Blob ? record.audioBlob : null;
  if (!words.length && !blob) return null;

  const name = text(record.audioName) || "ses";
  const file = blob ? new File([blob], name, { type: blob.type || "application/octet-stream" }) : null;
  const peaks = file ? await peaksOf(file) : new Float32Array(0);

  const created = Date.parse(text(record.createdAt)) || Date.now();
  const updated = Date.parse(text(record.updatedAt)) || created;
  const id = text(record.id) || crypto.randomUUID();

  const project: Project = {
    // Prefixed, so a re-run writes the same project again instead of a second copy.
    id: `voxi-${id}`,
    name: text(record.title) || "İçe aktarılan proje",
    createdAt: created,
    updatedAt: updated,
    live: false,
    // No model and no method are claimed: Voxi never ran a studio model.
    method: "beam-lm",
    duration: durationOf(record.document) ?? (peaks.length ? peaks.length * PEAK_STEP : null),
    elapsed: null,
    words,
    peaks,
    bands: new Float32Array(0),
    loudness: new Float32Array(0),
    settings: toSettings(record.style),
    media: file ? mediaInfo(file) : null,
    storage: file ? "copy" : "none",
  };
  return { project, file };
}

// ---- Reading the legacy store ----

function readLegacy(): Promise<LegacyRecord[]> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB yok"));
      return;
    }
    // Opening without a version creates the database when it is absent; ask the
    // browser whether it ever existed so an empty one is not left behind.
    const existed = indexedDB.databases?.();
    const open = () => {
      const req = indexedDB.open(LEGACY_DB);
      req.onerror = () => reject(req.error ?? new Error("Açılamadı"));
      req.onblocked = () => reject(new Error("Bloke edildi"));
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LEGACY_STORE)) {
          db.close();
          resolve([]);
          return;
        }
        const tx = db.transaction(LEGACY_STORE, "readonly");
        const all = tx.objectStore(LEGACY_STORE).getAll() as IDBRequest<LegacyRecord[]>;
        all.onsuccess = () => {
          db.close();
          resolve(all.result ?? []);
        };
        all.onerror = () => {
          db.close();
          reject(all.error ?? new Error("Okunamadı"));
        };
      };
    };
    if (!existed) {
      open();
      return;
    }
    existed
      .then((list) => {
        if (!list.some((d) => d.name === LEGACY_DB)) resolve([]);
        else open();
      })
      .catch(open);
  });
}

/**
 * Move the Voxi projects into the studio store, once.
 *
 * Safe to call on every load: the mark in localStorage short-circuits it, and
 * concurrent callers share one run. When IndexedDB or localStorage is
 * unavailable (private windows) it simply does nothing and tries again next time
 * — ids are stable, so a re-run overwrites rather than duplicates.
 */
export async function importVoxiProjects(): Promise<VoxiImportReport> {
  // StrictMode mounts effects twice in dev: one run, shared.
  inFlight ??= runImport();
  return inFlight;
}

/** The one run, shared by every caller. */
let inFlight: Promise<VoxiImportReport> | null = null;

async function runImport(): Promise<VoxiImportReport> {
  try {
    if (localStorage.getItem(MARK)) return { imported: 0, skipped: 0, alreadyDone: true };
  } catch {
    /* No localStorage: fall through, the stable ids keep it idempotent. */
  }

  let records: LegacyRecord[];
  try {
    records = await readLegacy();
  } catch {
    return { imported: 0, skipped: 0, alreadyDone: false };
  }

  let imported = 0;
  let skipped = 0;
  for (const record of records) {
    try {
      const converted = await toProject(record);
      if (!converted) {
        skipped += 1;
        continue;
      }
      const { project, file } = converted;
      if (file) await saveMedia(project, { kind: "copy", file });
      else await saveProject(project);
      imported += 1;
    } catch {
      skipped += 1;
    }
  }

  try {
    localStorage.setItem(MARK, new Date().toISOString());
  } catch {
    /* Private mode: the stable ids make a second run harmless. */
  }
  return { imported, skipped, alreadyDone: false };
}
