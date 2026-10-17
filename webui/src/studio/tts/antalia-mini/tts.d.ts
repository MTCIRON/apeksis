// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Types for the parts of tts.js (copied unchanged from the cloud0day3/antalia-mini Space) that mini.ts uses.

export const SAMPLE_RATE: number;

export interface MiniManifest {
  defaults?: { steps?: number; cfg?: number; speed?: number; temperature?: number };
  /** Size of each file to download, as prepare_models.py writes it. */
  files: Record<string, number>;
}

export class Engine {
  static create(
    ort: typeof import("onnxruntime-web/webgpu"),
    buffers: Record<"text" | "cond" | "flow" | "vocoder", Uint8Array>,
    manifest: MiniManifest,
    providers?: string[],
  ): Promise<Engine>;
  defaults: { steps: number; cfg: number; speed: number; temperature: number };
}

export function speak(
  engine: Engine,
  modelText: string,
  options?: { seed?: number; steps?: number; cfg?: number; speed?: number; temperature?: number },
): AsyncGenerator<{ audio: Float32Array; index: number; count: number }>;
