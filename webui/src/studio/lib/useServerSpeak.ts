// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Speaking a server answer out loud, over the streaming TTS socket
// (`WS /v1/tts/stream`).
//
// This is what speaks an answer: the same gateway capability the old "Canlı" TTS
// panel offered, with a real caller — the reply a session turn came back with —
// instead of a demo text box. The workspace's own media element is paused first,
// so two sounds are never heard at once. The numbers shown are the socket's own:
// the time to the first audio chunk, and the duration the server reported.

import { useCallback, useEffect, useRef, useState } from "react";
import { mintSocketTicket } from "../../api/client";
import { connectTts, type TtsConnection, type TtsSpeakRequest } from "../../api/stream";
import { PcmPlayer } from "../../lib/audio";

export interface SpeakState {
  phase: "idle" | "starting" | "speaking";
  /** The text being spoken, or the last one spoken. */
  text: string;
  /** Milliseconds until the first audio chunk, measured by the socket client. */
  firstAudioMs: number | null;
  /** Audio the server said it sent, in seconds. */
  seconds: number | null;
  error: string | null;
}

const IDLE: SpeakState = {
  phase: "idle",
  text: "",
  firstAudioMs: null,
  seconds: null,
  error: null,
};

export interface SpeakVoice {
  model: string;
  voice: string;
  speed?: number;
}

export function useServerSpeak(onStart?: () => void) {
  const [state, setState] = useState<SpeakState>(IDLE);
  const conn = useRef<TtsConnection | null>(null);
  const player = useRef<PcmPlayer | null>(null);
  const ctx = useRef<AudioContext | null>(null);
  const generation = useRef(0);

  const stop = useCallback(() => {
    conn.current?.cancel(generation.current);
    player.current?.stop();
    setState((s) => (s.phase === "idle" ? s : { ...s, phase: "idle" }));
  }, []);

  // Drop the socket and the output device when the workspace goes away.
  useEffect(
    () => () => {
      conn.current?.close();
      void ctx.current?.close().catch(() => {});
    },
    [],
  );

  const speak = useCallback(
    async (text: string, voice: SpeakVoice) => {
      const input = text.trim();
      if (!input) return;
      onStart?.();
      setState({ phase: "starting", text: input, firstAudioMs: null, seconds: null, error: null });
      try {
        const { ticket } = await mintSocketTicket("audio:write");
        const audio = ctx.current ?? (ctx.current = new AudioContext());
        if (audio.state === "suspended") void audio.resume().catch(() => {});
        const p =
          player.current ??
          (player.current = new PcmPlayer(audio, {
            onPlaybackEnd: () => setState((s) => ({ ...s, phase: "idle" })),
          }));
        generation.current += 1;
        const request: TtsSpeakRequest = {
          model: voice.model,
          input,
          voice: voice.voice,
          sampleRate: 48000,
          chunkMs: 100,
          generationId: generation.current,
          ...(voice.speed !== undefined ? { speed: voice.speed } : {}),
        };
        conn.current = connectTts(
          {
            // The socket must be open before a `speak` frame can go out.
            onOpen: () => conn.current?.speak(request),
            onMeta: (m) => p.begin(m.sampleRate),
            onAudio: (pcm) => p.feed(pcm),
            onDone: (_chunks, durationMs) => {
              p.armEnd();
              setState((s) => ({ ...s, seconds: durationMs / 1000 }));
            },
            onCancelled: () => setState((s) => ({ ...s, phase: "idle" })),
            onError: (code, message) => setState((s) => ({ ...s, phase: "idle", error: message || code })),
            onClose: () => setState((s) => ({ ...s, phase: "idle" })),
            onFirstAudio: (ms) => setState((s) => ({ ...s, phase: "speaking", firstAudioMs: ms })),
          },
          ticket,
        );
      } catch (e) {
        setState({ ...IDLE, text: input, error: e instanceof Error ? e.message : String(e) });
      }
    },
    [onStart],
  );

  return { state, speak, stop };
}
