// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Antalia-2 Mini (cloud0day3/antalia-mini, Apache-2.0): a second dubbing voice, 7.6M parameters at 48 kHz. The
// engine and text frontend in antalia-mini/ are copied unchanged from the model's Space; this puts them behind
// Ema's speak().

import { createFrontend, decodeAsset, type Frontend } from "./antalia-mini/frontend";
import { Engine, speak, type MiniManifest } from "./antalia-mini/tts";
import { VOICE_PACKS } from "../models";

export type { MiniManifest };
/** File names under the model directory, in the order `load` takes them. */
export const MINI_FILES = VOICE_PACKS.mini.files;

export class Mini {
  private constructor(
    private engine: Engine,
    private frontend: Frontend,
  ) {}

  /** `files` as MINI_FILES lists them. */
  static async load(
    ort: typeof import("onnxruntime-web/webgpu"),
    manifest: MiniManifest,
    files: Uint8Array[],
    providers: string[],
  ): Promise<Mini> {
    const [text, cond, flow, vocoder, data] = files;
    const frontend = createFrontend(await decodeAsset(data));
    frontend.warmup();
    const engine = await Engine.create(ort, { text, cond, flow, vocoder }, manifest, providers);
    return new Mini(engine, frontend);
  }

  /** All of the text as one buffer of 48 kHz audio. `speed` above 1 speaks faster. */
  async speak(text: string, speed = 1, seed = 0): Promise<Float32Array> {
    const modelText = this.frontend.modelText(text);
    const out: Float32Array[] = [];
    // The release reads slightly slower than 1 by default; speed is relative to that.
    for await (const { audio } of speak(this.engine, modelText, { seed, speed: this.engine.defaults.speed * speed }))
      out.push(audio);
    const all = new Float32Array(out.reduce((n, c) => n + c.length, 0));
    let o = 0;
    for (const c of out) {
      all.set(c, o);
      o += c.length;
    }
    return all;
  }
}
