/// <reference lib="webworker" />
// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Writes captions into a video.
//
// Video files: mediabunny decodes and re-encodes (WebCodecs, hardware H.264
// or HEVC where available, at the bitrate chosen in the export menu), the WebGPU compositor draws every frame with its caption,
// and the audio track is copied over untouched.
//
// Audio files and recordings: the picture is the audio-reactive aura (the
// same one the player shows), rendered at 1080p30; the audio is re-encoded
// to AAC (or Opus) for the MP4.
//
// With a dub, the sound in either case is the synthetic voice instead of the
// file's own audio.
//
// The MP4 is written to disk as it is encoded (sink.ts): into the file the
// user picked, or onto the browser's private disk, so hours of video never
// sit in memory.

import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  Conversion,
  getFirstEncodableAudioCodec,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  QUALITY_HIGH,
} from "mediabunny";
import { levelsAt, paletteById } from "../render/aura";
import { addUserFont, loadCaptionFont, type UserFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import type { CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { AUDIO_VIDEO, type Encoder, type OutputCodec } from "../lib/videoOutput";
import { createCompositor } from "../render/compositor";
import { DUB_RATE, dubSlice, type DubClip } from "../tts/dub";
import { clearRenders, openSink, type Sink } from "./sink";

declare const self: DedicatedWorkerGlobalScope;

export type ToRender =
  | {
      type: "burn";
      jobId: number;
      file: File;
      words: Word[];
      settings: CaptionSettings;
      /** The caption font, when the user added it (the worker has no access to their fonts). */
      userFont: UserFont | null;
      bands: Float32Array;
      /** Speech loudness, for "Sesle vurgula". */
      loudness: Float32Array;
      /** Language of the words; decides how they are uppercased. */
      lang: string;
      dub: DubClip[] | null;
      encode: Encode;
      /** The file the user picked to save into; null renders to the private disk (or memory). */
      handle: FileSystemFileHandle | null;
    }
  | { type: "cancel"; jobId: number };

export type FromRender =
  | { type: "progress"; jobId: number; progress: number; fps: number }
  | {
      type: "done";
      jobId: number;
      /** The video to download; null when it was saved into the picked file (`saved`). */
      file: File | null;
      saved: string | null;
      size: number;
      elapsed: number;
    }
  | { type: "cancelled"; jobId: number }
  | { type: "error"; jobId: number; message: string };

/**
 * Video codec, bitrate, encoder and size. No bitrate (the file could not be read
 * beforehand) is mediabunny's high quality; no known encoder lets the browser pick.
 */
export interface Encode {
  codec: OutputCodec;
  bitrate: number | null;
  encoder: Encoder;
  /** Picture size of the output; null keeps the file's own (1080p for auras). */
  size: { width: number; height: number } | null;
}

// The browser's own choice when the hardware encoder is not there: the processor's.
const acceleration = (encode: Encode) => (encode.encoder === "hardware" ? "prefer-hardware" : "no-preference");

const quality = (encode: Encode) => (encode.bitrate ? new Quality({ bitrate: encode.bitrate }) : QUALITY_HIGH);

const post = (m: FromRender) => self.postMessage(m);

const running = new Map<number, { cancel(): Promise<void> }>();
const sinks = new Map<number, Sink>();
const cancelled = new Set<number>();

/** Closes the output on disk and reports it. */
async function finish(jobId: number, sink: Sink, handle: FileSystemFileHandle | null, started: number) {
  const file = await sink.finish();
  const size = file?.size ?? (await handle!.getFile()).size;
  post({ type: "done", jobId, file, saved: file ? null : handle!.name, size, elapsed: (performance.now() - started) / 1000 });
}

const dubSample = (dub: DubClip[], timestamp: number, frames: number) =>
  new AudioSample({
    data: dubSlice(dub, timestamp, frames),
    format: "f32",
    numberOfChannels: 1,
    sampleRate: DUB_RATE,
    timestamp,
  });

async function burn(
  jobId: number,
  file: File,
  words: Word[],
  settings: CaptionSettings,
  bands: Float32Array,
  loudness: Float32Array,
  lang: string,
  dub: DubClip[] | null,
  encode: Encode,
  sink: Sink,
  handle: FileSystemFileHandle | null,
) {
  const started = performance.now();
  // The 2D canvas in a worker only sees fonts registered on the worker.
  await loadCaptionFont(settings.font, self.fonts);
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const track = await input.getPrimaryVideoTrack();
  if (!track) return burnAudio(jobId, input, words, settings, bands, loudness, lang, dub, encode, sink, handle, started);
  if (!(await track.canDecode())) throw new Error(`Videonun kodlaması (${track.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);

  // Rotation is baked into the frames (allowRotationMetadata: false below),
  // so the canvas uses the displayed size, or the chosen smaller one
  // (mediabunny resizes the frames before process). Encoders want even dimensions.
  const width = encode.size?.width ?? track.displayWidth & ~1;
  const height = encode.size?.height ?? track.displayHeight & ~1;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas, false);
  const captions = new CaptionRenderer(words, settings, width, height, loudness, lang);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  let frames = 0;
  const conversion = await Conversion.init({
    input,
    output,
    tracks: "primary",
    video: {
      codec: encode.codec,
      bitrate: quality(encode),
      forceTranscode: true,
      allowRotationMetadata: false,
      hardwareAcceleration: acceleration(encode),
      width,
      height,
      fit: "fill",
      processedWidth: width,
      processedHeight: height,
      process: (sample) => {
        const frame = sample.toVideoFrame();
        try {
          compositor.render(frame, captions.frame(sample.timestamp));
        } finally {
          frame.close();
        }
        frames++;
        return canvas;
      },
    },
    // The file's audio, resampled to the dub's rate, only sets the pace; each sample is replaced by the dub.
    audio: dub
      ? {
          numberOfChannels: 1,
          sampleRate: DUB_RATE,
          forceTranscode: true,
          process: (sample) => dubSample(dub, sample.timestamp, sample.numberOfFrames),
        }
      : undefined,
  });
  if (!conversion.isValid) {
    const why = conversion.discardedTracks.map((d) => d.reason).join(", ");
    compositor.destroy();
    throw new Error(`Bu video dönüştürülemiyor (${why}).`);
  }
  conversion.onProgress = (progress) => {
    const sec = (performance.now() - started) / 1000;
    post({ type: "progress", jobId, progress, fps: frames / sec });
  };
  running.set(jobId, conversion);
  if (cancelled.has(jobId)) await conversion.cancel();
  try {
    await conversion.execute();
  } finally {
    running.delete(jobId);
    compositor.destroy();
    input.dispose();
  }
  if (conversion.state === "canceled") {
    await sink.discard();
    post({ type: "cancelled", jobId });
    return;
  }
  await finish(jobId, sink, handle, started);
}

async function burnAudio(
  jobId: number,
  input: Input,
  words: Word[],
  settings: CaptionSettings,
  bands: Float32Array,
  loudness: Float32Array,
  lang: string,
  dub: DubClip[] | null,
  encode: Encode,
  sink: Sink,
  handle: FileSystemFileHandle | null,
  started: number,
) {
  const audio = await input.getPrimaryAudioTrack();
  if (!audio) throw new Error("Bu dosyada ses yok.");
  if (!(await audio.canDecode())) throw new Error(`Sesin kodlaması (${audio.codec ?? "bilinmiyor"}) bu tarayıcıda çözülemiyor.`);
  const codec = await getFirstEncodableAudioCodec(["aac", "opus"], {
    numberOfChannels: dub ? 1 : audio.numberOfChannels,
    sampleRate: dub ? DUB_RATE : audio.sampleRate,
  });
  if (!codec) throw new Error("Bu tarayıcı MP4 için ses kodlayamıyor (AAC veya Opus gerekli).");

  const { width, height } = encode.size ?? AUDIO_VIDEO;
  const { fps } = AUDIO_VIDEO;
  const canvas = new OffscreenCanvas(width, height);
  const compositor = await createCompositor(canvas, false);
  const captions = new CaptionRenderer(words, settings, width, height, loudness, lang);
  const palette = paletteById(settings.aura).colors;
  const duration = await input.computeDuration();

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: sink.fastStart }), target: sink.target });
  const video = new CanvasSource(canvas, {
    codec: encode.codec,
    bitrate: quality(encode),
    keyFrameInterval: 2,
    hardwareAcceleration: acceleration(encode),
  });
  const sound = new AudioSampleSource({ codec, bitrate: QUALITY_HIGH });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(sound);
  let stop = false;
  running.set(jobId, {
    cancel: async () => {
      stop = true;
    },
  });

  let frame = 0;
  const totalFrames = Math.ceil(duration * fps);
  const renderUntil = async (t: number) => {
    for (; frame < totalFrames && frame / fps < t && !stop; frame++) {
      const time = frame / fps;
      compositor.render(
        { kind: "aura", time, levels: levelsAt(bands, time), palette },
        captions.frame(time),
      );
      await video.add(time, 1 / fps);
    }
    const sec = (performance.now() - started) / 1000;
    post({ type: "progress", jobId, progress: Math.min(1, frame / totalFrames), fps: frame / sec });
  };

  try {
    await output.start();
    // Interleave: draw the frames up to the end of each audio sample.
    if (dub) {
      // A second of dub at a time, over the file's length.
      for (let t = 0; t < duration && !stop; t++) {
        const sample = dubSample(dub, t, Math.round(Math.min(1, duration - t) * DUB_RATE));
        await sound.add(sample);
        sample.close();
        await renderUntil(t + 1);
      }
    } else {
      for await (const sample of new AudioSampleSink(audio).samples()) {
        const end = sample.timestamp + sample.duration;
        if (!stop) await sound.add(sample);
        sample.close();
        if (stop) break;
        await renderUntil(end);
      }
    }
    if (!stop) await renderUntil(Infinity);
    if (stop) {
      await output.cancel();
      await sink.discard();
      post({ type: "cancelled", jobId });
      return;
    }
    await output.finalize();
  } finally {
    running.delete(jobId);
    compositor.destroy();
    input.dispose();
  }
  await finish(jobId, sink, handle, started);
}

self.onmessage = (ev: MessageEvent<ToRender>) => {
  const m = ev.data;
  if (m.type === "cancel") {
    cancelled.add(m.jobId);
    // Before the encoder stops, so the half-written file is thrown away rather than saved.
    sinks.get(m.jobId)?.cancel();
    void running.get(m.jobId)?.cancel();
    return;
  }
  const run = async () => {
    // The previous render's download link is gone once a new one starts.
    await clearRenders();
    const sink = await openSink(m.handle);
    sinks.set(m.jobId, sink);
    if (cancelled.has(m.jobId)) sink.cancel();
    if (m.userFont) addUserFont(m.userFont);
    await burn(m.jobId, m.file, m.words, m.settings, m.bands, m.loudness, m.lang, m.dub, m.encode, sink, m.handle);
  };
  run()
    .catch(async (e) => {
      await sinks.get(m.jobId)?.discard();
      if (cancelled.has(m.jobId)) post({ type: "cancelled", jobId: m.jobId });
      else post({ type: "error", jobId: m.jobId, message: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      cancelled.delete(m.jobId);
      sinks.delete(m.jobId);
    });
};
