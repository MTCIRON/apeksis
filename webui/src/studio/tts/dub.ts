// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The dubbed voice: one clip of synthetic speech per caption line, each placed at its own start time.

import { RATE } from "./ema";

export { RATE as DUB_RATE };

export interface DubClip {
  /** Seconds from the start of the media. */
  start: number;
  /** Mono audio at DUB_RATE. */
  audio: Float32Array;
}

/** The dub from `from` seconds on, `frames` samples long, silence between clips. Clips are sorted by start. */
export function dubSlice(clips: DubClip[], from: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  const first = Math.round(from * RATE);
  for (const c of clips) {
    const at = Math.round(c.start * RATE) - first;
    if (at >= frames) break;
    if (at + c.audio.length <= 0) continue;
    const src = Math.max(0, -at);
    out.set(c.audio.subarray(src, Math.min(c.audio.length, frames - at)), at + src);
  }
  return out;
}

/** The whole dub as a 16-bit WAV, for the player and for download. */
export function dubWav(clips: DubClip[], duration: number): Blob {
  const last = clips.at(-1);
  const end = Math.max(duration, last ? last.start + last.audio.length / RATE : 0);
  const n = Math.ceil(end * RATE);
  const head = new DataView(new ArrayBuffer(44));
  const str = (o: number, s: string) => [...s].forEach((c, i) => head.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  head.setUint32(4, 36 + 2 * n, true);
  str(8, "WAVEfmt ");
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true);
  head.setUint16(22, 1, true);
  head.setUint32(24, RATE, true);
  head.setUint32(28, RATE * 2, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  str(36, "data");
  head.setUint32(40, 2 * n, true);
  // A minute at a time, so an hour of dub never needs one big buffer.
  const parts: BlobPart[] = [head];
  const step = 60 * RATE;
  for (let i = 0; i < n; i += step) {
    const f = dubSlice(clips, i / RATE, Math.min(step, n - i));
    const pcm = new Int16Array(f.length);
    for (let j = 0; j < f.length; j++) pcm[j] = Math.round(Math.max(-1, Math.min(1, f[j])) * 32767);
    parts.push(pcm);
  }
  return new Blob(parts, { type: "audio/wav" });
}
