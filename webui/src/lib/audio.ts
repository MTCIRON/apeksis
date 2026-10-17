// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Browser audio plumbing for the live paths. No mocks: every buffer here is real
// PCM produced by the Web Audio API or received from the gateway.

/** Convert a mono Float32 block (-1..1) to clamped 16-bit little-endian samples. */
export function floatTo16BitPcm(input: Float32Array, output: Int16Array, offset = 0): void {
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[offset + i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
}

/** Linear-interpolation resample of a mono Float32 buffer from inRate to outRate. */
export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const ratio = inRate / outRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const frac = position - index;
    const a = input[index] ?? 0;
    const b = input[index + 1] ?? a;
    output[i] = a + (b - a) * frac;
  }
  return output;
}

/** Wrap an Int16 mono PCM chunk into a Float32 AudioBuffer for playback. */
export function pcm16ToAudioBuffer(
  ctx: AudioContext,
  pcm: Int16Array,
  sampleRate: number
): AudioBuffer {
  const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
  return buffer;
}

export interface PcmPlayerEvents {
  onPlaybackEnd: () => void;
}

/**
 * Gapless sequential PCM16 playout. Chunks scheduled back-to-back from a running
 * cursor so audio begins playing from the first chunk, before the stream ends.
 */
export class PcmPlayer {
  private readonly ctx: AudioContext;
  private readonly events: PcmPlayerEvents;
  private nextTime = 0;
  private sampleRate = 16000;
  private readonly sources: AudioBufferSourceNode[] = [];
  private endWatchdog: AudioBufferSourceNode | null = null;

  constructor(ctx: AudioContext, events: PcmPlayerEvents) {
    this.ctx = ctx;
    this.events = events;
  }

  begin(sampleRate: number): void {
    this.stop();
    this.sampleRate = sampleRate;
    this.nextTime = 0;
  }

  feed(pcm: Int16Array): void {
    if (pcm.length === 0) return;
    const source = this.ctx.createBufferSource();
    source.buffer = pcm16ToAudioBuffer(this.ctx, pcm, this.sampleRate);
    source.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.nextTime);
    source.start(startAt);
    this.nextTime = startAt + source.buffer.duration;
    this.sources.push(source);
    source.onended = () => {
      const at = this.sources.indexOf(source);
      if (at >= 0) this.sources.splice(at, 1);
    };
  }

  /** Called when the stream reports all chunks delivered; fires when playout drains. */
  armEnd(): void {
    if (this.nextTime <= this.ctx.currentTime) {
      this.events.onPlaybackEnd();
      return;
    }
    const watchdog = this.ctx.createBufferSource();
    watchdog.buffer = this.ctx.createBuffer(1, 1, this.sampleRate);
    watchdog.onended = () => this.events.onPlaybackEnd();
    watchdog.start(this.nextTime);
    this.endWatchdog = watchdog;
  }

  stop(): void {
    for (const source of this.sources.splice(0)) {
      try {
        source.onended = null;
        source.stop();
      } catch {
        /* already finished */
      }
    }
    if (this.endWatchdog) {
      try {
        this.endWatchdog.onended = null;
        this.endWatchdog.stop();
      } catch {
        /* already finished */
      }
      this.endWatchdog = null;
    }
    this.nextTime = 0;
  }

  get bufferedSeconds(): number {
    return Math.max(0, this.nextTime - this.ctx.currentTime);
  }
}

