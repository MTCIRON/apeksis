// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useEffect, useState } from "react";
import type { canEncodeVideo as CanEncodeVideo } from "mediabunny";
import { AUDIO_VIDEO, resolutionSizes, type Encoder, type OutputCodec, type SourceInfo } from "./videoOutput";

/** The hardware encoder when there is one, else the processor's. */
async function encoder(
  canEncodeVideo: typeof CanEncodeVideo,
  codec: OutputCodec,
  width: number,
  height: number,
): Promise<Encoder> {
  const can = (hardwareAcceleration: "prefer-hardware" | "prefer-software") =>
    canEncodeVideo(codec, { width, height, hardwareAcceleration }).catch(() => false);
  if (await can("prefer-hardware")) return "hardware";
  return (await can("prefer-software")) ? "software" : null;
}

/** Reads the file once (size, frame rate and bitrates from its index) and asks which encoders the browser has at each size on offer. */
export function useSourceInfo(file: File | null): SourceInfo | null {
  const [info, setInfo] = useState<SourceInfo | null>(null);
  useEffect(() => {
    setInfo(null);
    if (!file) return;
    let stale = false;
    void (async () => {
      const { ALL_FORMATS, BlobSource, Input, canEncodeVideo } = await import("mediabunny");
      const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
      try {
        const [track, audio, duration] = await Promise.all([
          input.getPrimaryVideoTrack(),
          input.getPrimaryAudioTrack(),
          input.computeDuration(),
        ]);
        // The render uses the displayed size, rounded to even numbers.
        const width = track ? track.displayWidth & ~1 : AUDIO_VIDEO.width;
        const height = track ? track.displayHeight & ~1 : AUDIO_VIDEO.height;
        // A few thousand packets are enough for an average and stay quick on files without an index.
        const sizes = resolutionSizes(width, height, !!track);
        const [videoStats, decodes, audioStats, resolutions] = await Promise.all([
          track?.computePacketStats(3000),
          track?.canDecode().catch(() => false),
          audio?.computePacketStats(3000),
          Promise.all(
            sizes.map(async (r) => {
              const [avc, hevc] = await Promise.all([
                encoder(canEncodeVideo, "avc", r.width, r.height),
                encoder(canEncodeVideo, "hevc", r.width, r.height),
              ]);
              return { ...r, encoders: { avc, hevc } };
            }),
          ),
        ]);
        if (stale) return;
        setInfo({
          width,
          height,
          // For video, packets per second is the frame rate.
          fps: videoStats?.averagePacketRate || AUDIO_VIDEO.fps,
          duration,
          video:
            track && videoStats ? { bitrate: videoStats.averageBitrate, codec: track.codec, decodes: !!decodes } : null,
          // Recordings and audio files are re-encoded to AAC at about 192 kbps.
          audioBitrate: track ? (audioStats?.averageBitrate ?? 0) : 192_000,
          resolutions,
        });
      } catch {
        // Unreadable here: the menu shows no estimate and the render reports the problem.
      } finally {
        input.dispose();
      }
    })();
    return () => {
      stale = true;
    };
  }, [file]);
  return info;
}
