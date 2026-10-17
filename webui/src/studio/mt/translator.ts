// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Turkish -> English translation with Helsinki-NLP/opus-mt-tc-big-tr-en (Marian, ONNX int8, exported by
// scripts/prepare_models.py). One sentence at a time, greedy, with the merged decoder's key/value cache.

import type { Ort } from "../engine/models";
import { SpmTokenizer, type SpmVocab } from "../punct/spm";

export interface MtConfig {
  decoderLayers: number;
  heads: number;
  headDim: number;
  maxLength: number;
  decoderStart: number;
  eos: number;
  pad: number;
  unk: number;
  files: Record<string, number>;
}

/** The source SentencePiece model, plus the shared vocabulary (id -> piece) the network reads and writes. */
export interface MtVocab extends SpmVocab {
  vocab: string[];
}

type Session = Awaited<ReturnType<Ort["InferenceSession"]["create"]>>;
type Tensor = InstanceType<Ort["Tensor"]>;

/** Longer input is cut: the sentences given are far shorter, this only guards the position table. */
const MAX_INPUT = 400;

export class Translator {
  private ids = new Map<string, number>();

  private constructor(
    private ort: Ort,
    private encoder: Session,
    private decoder: Session,
    private tok: SpmTokenizer,
    private vocab: string[],
    private cfg: MtConfig,
  ) {
    vocab.forEach((p, i) => this.ids.set(p, i));
  }

  /** On the CPU (wasm in the browser, "cpu" in Node): the merged decoder's If node is not for WebGPU. */
  static async create(
    ort: Ort,
    encoder: Uint8Array,
    decoder: Uint8Array,
    vocab: MtVocab,
    cfg: MtConfig,
    provider: "wasm" | "cpu" = "wasm",
  ): Promise<Translator> {
    const opts = { executionProviders: [provider], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
    // Sequential: the wasm runtime rejects concurrent initialisation.
    const enc = await ort.InferenceSession.create(encoder, opts);
    const dec = await ort.InferenceSession.create(decoder, opts);
    return new Translator(ort, enc, dec, new SpmTokenizer(vocab), vocab.vocab, cfg);
  }

  /** Text -> vocabulary ids ending in </s>, as MarianTokenizer gives them. */
  encode(text: string): number[] {
    // The model's normaliser is nmt_nfkc: NFKC, with a few more control characters dropped.
    const { ids } = this.tok.encodeWithSpans(text.normalize("NFKC"));
    const { unkId } = this.tok.vocab;
    const out = ids.map((id) => (id === unkId ? this.cfg.unk : (this.ids.get(this.tok.piece(id)) ?? this.cfg.unk)));
    return [...out.slice(0, MAX_INPUT - 1), this.cfg.eos];
  }

  /** Vocabulary ids -> text, without the special tokens. */
  decode(ids: number[]): string {
    const { eos, pad, unk } = this.cfg;
    return ids
      .filter((id) => id !== eos && id !== pad && id !== unk)
      .map((id) => this.vocab[id])
      .join("")
      .replaceAll("▁", " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async translate(text: string): Promise<string> {
    if (!text.trim()) return "";
    const { Tensor } = this.ort;
    const { decoderLayers, heads, headDim, decoderStart, eos, pad, maxLength } = this.cfg;
    const src = this.encode(text);
    const n = src.length;
    const ids = new Tensor("int64", BigInt64Array.from(src, BigInt), [1, n]);
    const mask = new Tensor("int64", new BigInt64Array(n).fill(1n), [1, n]);
    const { last_hidden_state: hidden } = await this.encoder.run({ input_ids: ids, attention_mask: mask });

    // The first step fills the cross-attention cache; later steps only add to the self-attention one.
    const past: Record<string, Tensor> = {};
    const empty = new Tensor("float32", new Float32Array(0), [1, heads, 0, headDim]);
    for (let l = 0; l < decoderLayers; l++)
      for (const kind of ["decoder", "encoder"])
        for (const kv of ["key", "value"]) past[`past_key_values.${l}.${kind}.${kv}`] = empty;

    const out: number[] = [];
    let token = decoderStart;
    const limit = Math.min(maxLength - 1, 2 * n + 10);
    for (let step = 0; step < limit; step++) {
      const r = await this.decoder.run({
        encoder_attention_mask: mask,
        input_ids: new Tensor("int64", BigInt64Array.of(BigInt(token)), [1, 1]),
        encoder_hidden_states: hidden,
        use_cache_branch: new Tensor("bool", [step > 0], [1]),
        ...past,
      });
      const logits = r.logits.data as Float32Array;
      let best = -1;
      for (let i = 0; i < logits.length; i++) if (i !== pad && (best < 0 || logits[i] > logits[best])) best = i;
      for (const name in r) {
        if (!name.startsWith("present.")) continue;
        if (step === 0 || name.includes(".decoder.")) past[name.replace("present.", "past_key_values.")] = r[name];
      }
      if (best === eos) break;
      out.push(best);
      token = best;
    }
    return this.decode(out);
  }
}
