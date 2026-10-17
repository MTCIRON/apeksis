// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Server transcription — the "sunucu" provider (see docs/merge-plan-2-integration.md).
//
// The gateway's `POST /v1/audio/transcriptions` answers OpenAI-style verbose JSON
// with REAL segment/word timings (`src/voxi/transcripts.py` resolves the
// granularity; the whisper provider emits words only for `verbose_json`). This
// adapter turns that answer into the very same `Word[]` the browser recognizer
// produces, so a server transcript lands in the same job, the same editable
// Transcript and the same Timeline as a local one. Nothing is fabricated: if the
// server reports no timings at all, the run fails and says so.
//
// The request/response also shows up in Settings → Günlük: `api/client` pushes a
// log line for every call.

import {
  ApiError,
  transcribeAudio,
  type SegmentTiming,
  type VerboseTranscription,
} from "../../api/client";
import type { Word } from "../engine";

export interface ServerResult {
  words: Word[];
  /** The server's own audio duration in seconds, when it reports one. */
  duration: number | null;
}

/** A message the status bar can show as-is (401/403 get an actionable hint). */
function describe(error: unknown): string {
  if (error instanceof ApiError) {
    const req = error.requestId ? ` · ${error.requestId}` : "";
    if (error.status === 401 || error.status === 403) {
      return `Sunucu anahtarı reddedildi (${error.status}); Ayarlar → Sunucu'dan geçerli anahtarı gir.${req}`;
    }
    if (error.status === 0) return `Sunucuya ulaşılamadı: ${error.message}${req}`;
    return `Sunucu ${error.status} · ${error.code}: ${error.message}${req}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** One segment → words. Word timings when the server sent them, else the segment's span. */
function segmentWords(segment: SegmentTiming): Word[] {
  const words = (segment.words ?? [])
    .map((w) => ({ text: w.word.trim(), start: w.start, end: Math.max(w.start, w.end) }))
    .filter((w) => w.text.length > 0);
  if (words.length) return words;
  const text = segment.text.trim();
  if (!text) return [];
  return [{ text, start: segment.start, end: Math.max(segment.start, segment.end) }];
}

/** Verbose JSON → transcript words, in the order the server reported them. */
export function wordsFromVerbose(verbose: VerboseTranscription): Word[] {
  const words: Word[] = [];
  for (const segment of verbose.segments ?? []) words.push(...segmentWords(segment));
  if (!words.length) {
    // Some providers set only `text`; keep it as one cue rather than losing it.
    const text = verbose.text?.trim();
    if (text) words.push({ text, start: 0, end: Math.max(0, verbose.duration ?? 0) });
  }
  return words;
}

/**
 * Transcribe a media file on the Voxi server. Throws with a readable message;
 * an aborted call rejects with the abort error untouched, so the caller can
 * tell "stopped" from "failed".
 */
export async function serverTranscribe(
  file: File,
  options: { language?: string; signal?: AbortSignal } = {},
): Promise<ServerResult> {
  let result;
  try {
    result = await transcribeAudio({
      file,
      response_format: "verbose_json",
      timestamp_granularities: ["segment", "word"],
      signal: options.signal,
      ...(options.language ? { language: options.language } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new Error(describe(error));
  }

  const verbose = result.verbose;
  if (!verbose) throw new Error("Sunucu ayrıntılı (verbose_json) yanıt döndürmedi.");
  const words = wordsFromVerbose(verbose);
  if (!words.length) throw new Error("Sunucu hiç kelime döndürmedi.");
  return { words, duration: verbose.duration ?? words[words.length - 1].end };
}
