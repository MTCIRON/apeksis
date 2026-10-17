// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Duyu-small as a SpeechEngine. The model decodes whole utterances (its
// encoder sees the full context), so audio is cut into pieces of at most
// 15 s, every ~12 s at the quietest 20 ms nearby. Its own engine cuts at
// 25 s, but the decoder has no KV cache: a step re-runs the whole prefix, so
// the search costs grow with the square of a piece's length. Each piece is
// decoded with the attention beam search; word times come from aligning the
// result to the CTC head (25 frames a second).

import { OnlineFbank } from "../engine/fbank";
import type { Ort } from "../engine/models";
import type { SpeechEngine, SpeechStream } from "../engine/stream";
import type { Word } from "../engine/tokens";
import { DuyuFbank } from "./features";
import { DuyuModel, type DuyuConfig, type DuyuGraphs } from "./model";
import { beamSearch, ctcAlign } from "./search";

export type { DuyuConfig } from "./model";

export interface DuyuFiles extends DuyuGraphs {
  config: DuyuConfig;
  /** fbank.bin: float32 window and mel filters. */
  fbank: Uint8Array;
  /** tokens.json: SentencePiece pieces by id. */
  pieces: string[];
}

const SAMPLE_RATE = 16000;
/** Up to this much audio is decoded in one piece... */
const LIMIT = 15 * SAMPLE_RATE;
/** ...longer audio is cut near every MAX_PIECE, within ±SEARCH. */
const MAX_PIECE = 12 * SAMPLE_RATE;
const SEARCH = 3 * SAMPLE_RATE;
/** Silence after each piece: the decoder needs it after the last word. */
const TAIL_PAD = Math.round(0.4 * SAMPLE_RATE);
/** A finished stream's leftover shorter than this is not decoded. */
const MIN_TAIL = SAMPLE_RATE / 10;
/** A word lasts at most this long after its last CTC spike (spikes mark onsets, not ends). */
const WORD_HOLD = 0.3;
const MIN_WORD = 0.08;
/** The engine's default is 5; 3 is much faster for little accuracy. */
const BEAM = 3;
const CTC_WEIGHT = 0.3;
/** Turkish, like the other models; "mix" would also take English sentences. */
const LANG = "tr";

/** Pieces to text, with SentencePiece's byte fallback (<0x..>). */
class Pieces {
  private bytes: (number | null)[];
  private text: string[];
  private utf8 = new TextDecoder();

  constructor(pieces: string[]) {
    // Special pieces (<unk>, <s>, ...) write nothing.
    this.text = pieces.map((p) => (/^<.+>$/.test(p) ? "" : p.replaceAll("▁", " ")));
    this.bytes = pieces.map((p) => (/^<0x[0-9A-F]{2}>$/.test(p) ? parseInt(p.slice(3, 5), 16) : null));
  }

  startsWord(id: number) {
    return this.text[id].startsWith(" ");
  }

  decode(ids: number[]): string {
    let out = "";
    let pending: number[] = [];
    const flush = () => {
      if (pending.length) out += this.utf8.decode(Uint8Array.from(pending));
      pending = [];
    };
    for (const id of ids) {
      const b = this.bytes[id];
      if (b !== null) {
        pending.push(b);
      } else {
        flush();
        out += this.text[id];
      }
    }
    flush();
    return out.trim();
  }
}

export class DuyuEngine implements SpeechEngine {
  readonly provider = "wasm" as const;

  private constructor(
    private model: DuyuModel,
    private fbank: DuyuFbank,
    private pieces: Pieces,
  ) {}

  static async create(ort: Ort, files: DuyuFiles, provider: "wasm" | "cpu" = "wasm"): Promise<DuyuEngine> {
    const model = await DuyuModel.create(ort, files.config, files, provider);
    const tables = new Float32Array(files.fbank.buffer.slice(files.fbank.byteOffset, files.fbank.byteOffset + files.fbank.byteLength));
    return new DuyuEngine(model, new DuyuFbank(tables), new Pieces(files.pieces));
  }

  createRecognizer(): SpeechStream {
    return new DuyuRecognizer(this.model, this.fbank, this.pieces);
  }
}

/** Where to end a piece of audio that is longer than LIMIT: the quietest 20 ms near MAX_PIECE. */
function cutPoint(audio: Float32Array, length: number): number {
  const lo = Math.max(SAMPLE_RATE, MAX_PIECE - SEARCH);
  const hi = Math.min(length - SAMPLE_RATE, MAX_PIECE + SEARCH);
  if (hi <= lo) return MAX_PIECE;
  // Energy of the 20 ms around each sample, as a running sum.
  const half = SAMPLE_RATE / 100;
  let sum = 0;
  for (let i = lo - half; i < lo + half; i++) sum += audio[i] * audio[i];
  let best = lo;
  let bestSum = sum;
  for (let i = lo + 1; i < hi; i++) {
    sum += audio[i + half - 1] ** 2 - audio[i - half - 1] ** 2;
    if (sum < bestSum) {
      bestSum = sum;
      best = i;
    }
  }
  return best;
}

class DuyuRecognizer implements SpeechStream {
  onFeature: ((f: Float32Array) => void) | null = null;
  readonly timing = { encoder: 0, search: 0, chunks: 0 };
  /** Only for onFeature (the aura and "Sesle vurgula"); Duyu has its own features. */
  private auraFbank = new OnlineFbank(80);
  /** Audio from the current piece's start on. */
  private audio = new Float32Array(LIMIT * 2);
  private length = 0;
  private pieceStart = 0;
  private finished = false;
  private committed: Word[] = [];

  constructor(
    private model: DuyuModel,
    private fbank: DuyuFbank,
    private pieces: Pieces,
  ) {}

  get decodedSeconds() {
    return this.pieceStart / SAMPLE_RATE;
  }

  acceptWaveform(samples: Float32Array) {
    if (this.length + samples.length > this.audio.length) {
      const next = new Float32Array(Math.max(this.audio.length * 2, this.length + samples.length));
      next.set(this.audio.subarray(0, this.length));
      this.audio = next;
    }
    this.audio.set(samples, this.length);
    this.length += samples.length;
    this.auraFbank.acceptWaveform(samples);
    this.auraFbank.compute((f) => this.onFeature?.(f));
  }

  inputFinished() {
    if (this.finished) return;
    this.finished = true;
    this.auraFbank.inputFinished();
    this.auraFbank.compute((f) => this.onFeature?.(f));
  }

  isReady() {
    return this.length > LIMIT || (this.finished && this.length >= MIN_TAIL);
  }

  async decodeChunk() {
    const n = this.length > LIMIT ? cutPoint(this.audio, this.length) : this.length;
    const piece = new Float32Array(n + TAIL_PAD);
    piece.set(this.audio.subarray(0, n));

    const t0 = performance.now();
    const feats = this.fbank.compute(piece);
    const enc = await this.model.encode(feats.data, feats.frames);
    const t1 = performance.now();
    const { config } = this.model;
    const V = config.vocabSize;
    const ids = await beamSearch(config, (tokens, rows, len) => this.model.next(tokens, rows, len, enc.memory), enc.logp, enc.frames, {
      beam: BEAM,
      lang: LANG,
      ctcWeight: CTC_WEIGHT,
    });
    const align = ctcAlign(enc.logp, enc.frames, V, ids, config.pad);
    this.commit(ids, align, n);
    this.timing.encoder += t1 - t0;
    this.timing.search += performance.now() - t1;
    this.timing.chunks++;
    this.consume(n);
  }

  flush() {
    this.consume(this.length);
  }

  takeCommitted(): Word[] {
    const w = this.committed;
    this.committed = [];
    return w;
  }

  tentative(): Word[] {
    return [];
  }

  /** Group the pieces into words and time them from the alignment. */
  private commit(ids: number[], align: { first: Int32Array; last: Int32Array } | null, samples: number) {
    const offset = this.pieceStart / SAMPLE_RATE;
    const pieceEnd = offset + samples / SAMPLE_RATE;
    const frameSec = 1 / this.model.config.frameHz;
    const words: { ids: number[]; from: number; to: number }[] = [];
    ids.forEach((id, k) => {
      if (!words.length || this.pieces.startsWord(id)) words.push({ ids: [], from: k, to: k });
      const w = words[words.length - 1];
      w.ids.push(id);
      w.to = k;
    });

    const out: Word[] = [];
    const at = (sec: number) => Math.min(offset + sec, pieceEnd);
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const text = this.pieces.decode(w.ids);
      if (!text) continue;
      // A lone punctuation piece belongs to the word before it.
      if (out.length && !/[\p{L}\p{N}]/u.test(text)) {
        out[out.length - 1].text += text;
        continue;
      }
      let start: number;
      let end: number;
      if (align) {
        start = at(align.first[w.from] * frameSec);
        end = at((align.last[w.to] + 1) * frameSec + WORD_HOLD);
      } else {
        // No alignment (should not happen): spread the words over the piece.
        start = offset + ((pieceEnd - offset) * i) / words.length;
        end = offset + ((pieceEnd - offset) * (i + 1)) / words.length;
      }
      out.push({ text, start, end });
    }
    // Words do not overlap; each lasts at least a moment.
    for (let i = 0; i < out.length; i++) {
      const w = out[i];
      if (i + 1 < out.length) w.end = Math.min(w.end, out[i + 1].start);
      w.end = Math.max(w.end, Math.min(w.start + MIN_WORD, pieceEnd));
    }
    this.committed.push(...out);
  }

  private consume(samples: number) {
    const k = Math.min(samples, this.length);
    this.audio.copyWithin(0, k, this.length);
    this.length -= k;
    this.pieceStart += k;
  }
}
