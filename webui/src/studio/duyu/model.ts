// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Duyu-small's four graphs: encoder front end, one Conformer pass run three
// times with learned gates (shared refinement), the CTC head, and the
// attention decoder (no KV cache: every step runs the whole prefix).

import type * as OrtWeb from "onnxruntime-web";
import type { Ort } from "../engine/models";
import { FEATURE_DIM } from "./features";

type Session = OrtWeb.InferenceSession;
type Tensor = OrtWeb.Tensor;

export interface DuyuConfig {
  name: string;
  pad: number;
  bos: number;
  eos: number;
  lang: Record<string, number>;
  style: Record<string, number>;
  maxPositions: number;
  vocabSize: number;
  dModel: number;
  frameHz: number;
  /** Per pass: how far the pass moves its input (the first replaces it). */
  gates: number[];
  /** Per pass: added to the input of the shared pass. */
  passEmbed: number[][];
  files: Record<string, number>;
}

export interface DuyuGraphs {
  pre: Uint8Array;
  pass: Uint8Array;
  post: Uint8Array;
  decoder: Uint8Array;
}

export interface Encoded {
  /** Encoder output [1, frames, dModel], the decoder's memory. */
  memory: Tensor;
  /** CTC log-probabilities, frames x vocabSize. */
  logp: Float32Array;
  frames: number;
}

export class DuyuModel {
  private constructor(
    private ort: Ort,
    readonly config: DuyuConfig,
    private pre: Session,
    private pass: Session,
    private post: Session,
    private decoder: Session,
  ) {}

  /** The int8 graphs (MatMulInteger) run on the CPU: wasm in the browser, "cpu" in Node. */
  static async create(ort: Ort, config: DuyuConfig, graphs: DuyuGraphs, provider: "wasm" | "cpu" = "wasm") {
    const opts = { executionProviders: [provider], graphOptimizationLevel: "all" as const, logSeverityLevel: 3 as const };
    // Sequential: onnxruntime-web rejects concurrent initialisation.
    const pre = await ort.InferenceSession.create(graphs.pre, opts);
    const pass = await ort.InferenceSession.create(graphs.pass, opts);
    const post = await ort.InferenceSession.create(graphs.post, opts);
    const decoder = await ort.InferenceSession.create(graphs.decoder, opts);
    return new DuyuModel(ort, config, pre, pass, post, decoder);
  }

  async encode(feats: Float32Array, featFrames: number): Promise<Encoded> {
    const { ort, config } = this;
    const d = config.dModel;
    const pre = await this.pre.run({ feats: new ort.Tensor("float32", feats, [1, featFrames, FEATURE_DIM]) });
    let x = pre.x.data as Float32Array;
    const frames = x.length / d;
    for (let p = 0; p < config.gates.length; p++) {
      const embed = config.passEmbed[p];
      const input = new Float32Array(x.length);
      for (let i = 0; i < x.length; i++) input[i] = x[i] + embed[i % d];
      const out = await this.pass.run({ x: new ort.Tensor("float32", input, [1, frames, d]) });
      const y = out.y.data as Float32Array;
      if (p === 0) {
        x = y;
      } else {
        const g = config.gates[p];
        const next = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) next[i] = x[i] + g * (y[i] - x[i]);
        x = next;
      }
    }
    const memory = new ort.Tensor("float32", x, [1, frames, d]);
    const post = await this.post.run({ x: memory });
    return { memory, logp: post.log_probs.data as Float32Array, frames };
  }

  /**
   * Logits for the next token of each of `rows` prefixes of length `len`
   * (tokens row-major). The memory stays batch 1: the graph broadcasts it.
   */
  async next(tokens: BigInt64Array, rows: number, len: number, memory: Tensor): Promise<Float32Array> {
    const out = await this.decoder.run({ tokens: new this.ort.Tensor("int64", tokens, [rows, len]), memory });
    const logits = out.logits.data as Float32Array;
    const V = this.config.vocabSize;
    const last = new Float32Array(rows * V);
    for (let k = 0; k < rows; k++) last.set(logits.subarray((k * len + len - 1) * V, (k * len + len) * V), k * V);
    return last;
  }
}
