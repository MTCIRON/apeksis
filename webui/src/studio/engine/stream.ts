// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// What the worker needs from a speech model, whichever it is: feed 16 kHz
// audio, decode while ready, collect words. seda's Recognizer streams in
// 0.64 s chunks; Whisper decodes 30 s windows.

import type { DecodeOptions } from "./config";
import type { EncoderProvider } from "./models";
import type { Word } from "./tokens";

export interface SpeechStream {
  /** Called with every 80-dim log-mel frame (10 ms), e.g. for visualisation. */
  onFeature: ((f: Float32Array) => void) | null;
  /** Seconds of audio covered by decoded chunks so far. */
  readonly decodedSeconds: number;
  /** Milliseconds spent in the encoder and in the search, for diagnostics. */
  readonly timing: { encoder: number; search: number; chunks: number };
  acceptWaveform(samples: Float32Array): void;
  inputFinished(): void;
  isReady(): boolean;
  /** Decode one chunk. Call while isReady(). */
  decodeChunk(): Promise<void>;
  /** After the last decodeChunk() of a finished stream. */
  flush(): void;
  /** Words that are final, returned once. */
  takeCommitted(): Word[];
  /** Words that may still change. */
  tentative(): Word[];
}

export interface SpeechEngine {
  readonly provider: EncoderProvider;
  /** One stream at a time: streams share the model's buffers. */
  createRecognizer(opts: DecodeOptions): SpeechStream;
}
