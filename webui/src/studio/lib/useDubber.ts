// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCues, cueText, READING_RULES } from "./cues";
import type { Word } from "../engine";
import { dubWav, type DubClip } from "../tts/dub";
import { RATE } from "../tts/ema";
import type { FromTts, ToTts, Voice, VoiceModel } from "../worker/tts.worker";
import { serverDubLines, serverSpeech } from "./serverTts";
import { browserVoice, type VoiceChoice } from "./voices";

export type { Voice, VoiceModel };

/** Read when the transcript has no line yet. */
const SAMPLE = "Merhaba, seslendirme bu sesle yapılacak.";

/** A short sample of the voice: model download, then synthesis, then playback. */
export type PreviewState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running" }
  | { status: "playing" }
  | { status: "error"; message: string };

export type DubState =
  | { status: "idle" }
  | { status: "download"; loaded: number; total: number }
  | { status: "running"; done: number; total: number }
  /** `words` and `choice` are what it was made from, to tell when it is out of date. */
  | { status: "done"; clips: DubClip[]; url: string; words: Word[]; choice: VoiceChoice; elapsed: number }
  | { status: "error"; message: string };

/**
 * Reads the transcript aloud, one caption line at a time, in the chosen voice.
 *
 * The provider only decides WHERE the speech is made: the browser worker
 * (EMA Lightning / Antalia Mini) or the Voxi server (`/v1/audio/speech`). Both
 * produce the same `DubClip[]`, the same `dubWav` blob and the same playback.
 */
export function useDubber() {
  const worker = useRef<Worker | null>(null);
  const jobId = useRef(0);
  const pending = useRef<{ words: Word[]; duration: number; choice: VoiceChoice } | null>(null);
  const [state, setState] = useState<DubState>({ status: "idle" });
  // Previews run alongside a finished dub without touching it, so they count their own jobs; the worker sees
  // them as negative ids.
  const previewId = useRef(0);
  const sample = useRef<HTMLAudioElement | null>(null);
  const [preview, setPreview] = useState<PreviewState>({ status: "idle" });
  /** The server run in flight, so "Durdur" can abort its requests. */
  const serverRun = useRef<AbortController | null>(null);

  const stopSample = useCallback(() => {
    const a = sample.current;
    if (!a) return;
    a.pause();
    URL.revokeObjectURL(a.src);
    sample.current = null;
  }, []);

  /** Play one synthetic clip on its own, replacing whatever preview was playing. */
  const playSample = useCallback(
    (audio: Float32Array) => {
      stopSample();
      const a = new Audio(URL.createObjectURL(dubWav([{ start: 0, audio }], audio.length / RATE)));
      a.onended = () => {
        stopSample();
        setPreview({ status: "idle" });
      };
      sample.current = a;
      setPreview({ status: "playing" });
      void a.play().catch(() => a.onended?.(new Event("ended")));
    },
    [stopSample],
  );

  const ensureWorker = useCallback(() => {
    if (worker.current) return worker.current;
    const w = new Worker(new URL("../worker/tts.worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (ev: MessageEvent<FromTts>) => {
      const m = ev.data;
      if (m.jobId < 0) {
        if (m.jobId !== -previewId.current) return;
        if (m.type === "download") setPreview({ status: "download", loaded: m.loaded, total: m.total });
        else if (m.type === "error") setPreview({ status: "error", message: m.message });
        else if (m.type === "preview") playSample(m.audio);
        return;
      }
      if (m.jobId !== jobId.current) return;
      switch (m.type) {
        case "download":
          setState({ status: "download", loaded: m.loaded, total: m.total });
          break;
        case "progress":
          setState({ status: "running", done: m.done, total: m.total });
          break;
        case "done": {
          const { words, duration, choice } = pending.current!;
          const url = URL.createObjectURL(dubWav(m.clips, duration));
          setState({ status: "done", clips: m.clips, url, words, choice, elapsed: m.elapsed });
          break;
        }
        case "cancelled":
          setState({ status: "idle" });
          break;
        case "error":
          setState({ status: "error", message: m.message });
          break;
      }
    };
    worker.current = w;
    return w;
  }, [playSample]);

  useEffect(
    () => () => {
      worker.current?.terminate();
      serverRun.current?.abort();
      stopSample();
    },
    [stopSample],
  );

  // Free the previous result when it is replaced.
  const url = state.status === "done" ? state.url : null;
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);

  const dub = useCallback(
    (words: Word[], duration: number, choice: VoiceChoice) => {
      const id = ++jobId.current;
      serverRun.current?.abort();
      serverRun.current = null;
      pending.current = { words, duration, choice };
      setState({ status: "running", done: 0, total: 0 });
      const lines = buildCues(words, READING_RULES).map((c) => ({ start: c.start, end: c.end, text: cueText(c) }));

      if (choice.provider === "sunucu") {
        const ac = new AbortController();
        serverRun.current = ac;
        const started = performance.now();
        void (async () => {
          try {
            const clips = await serverDubLines(lines, {
              model: choice.model,
              voice: choice.voice,
              speed: choice.speed,
              signal: ac.signal,
              onProgress: (done, total) => {
                if (jobId.current === id) setState({ status: "running", done, total });
              },
            });
            if (jobId.current !== id) return;
            const url = URL.createObjectURL(dubWav(clips, duration));
            setState({
              status: "done",
              clips,
              url,
              words,
              choice,
              elapsed: (performance.now() - started) / 1000,
            });
          } catch (e) {
            if (jobId.current !== id) return;
            if (ac.signal.aborted) setState({ status: "idle" });
            else setState({ status: "error", message: e instanceof Error ? e.message : String(e) });
          } finally {
            if (serverRun.current === ac) serverRun.current = null;
          }
        })();
        return;
      }

      ensureWorker().postMessage({
        type: "dub",
        jobId: id,
        lines,
        duration,
        voice: browserVoice(choice),
      } satisfies ToTts);
    },
    [ensureWorker],
  );

  /**
   * Reads the first line of the transcript with `choice`; a second call while one
   * runs stops it. `media` (the project player) pauses first: one sound at a time.
   */
  const listen = useCallback(
    (words: Word[], choice: VoiceChoice, media?: HTMLMediaElement | null) => {
      media?.pause();
      stopSample();
      const id = ++previewId.current;
      // A sample already on its way is dropped when it arrives: its id is out of date.
      if (preview.status !== "idle") {
        setPreview({ status: "idle" });
        return;
      }
      const first = buildCues(words, READING_RULES)[0];
      const text = (first && cueText(first).trim()) || SAMPLE;
      setPreview({ status: "running" });

      if (choice.provider === "sunucu") {
        void serverSpeech(text, choice)
          .then((audio) => {
            if (previewId.current === id) playSample(audio);
          })
          .catch((e: unknown) => {
            if (previewId.current !== id) return;
            setPreview({ status: "error", message: e instanceof Error ? e.message : String(e) });
          });
        return;
      }

      ensureWorker().postMessage({ type: "preview", jobId: -id, text, voice: browserVoice(choice) } satisfies ToTts);
    },
    [ensureWorker, stopSample, preview.status, playSample],
  );

  const cancel = useCallback(() => {
    serverRun.current?.abort();
    serverRun.current = null;
    worker.current?.postMessage({ type: "cancel", jobId: jobId.current } satisfies ToTts);
    jobId.current++;
    setState({ status: "idle" });
  }, []);

  const reset = useCallback(() => {
    jobId.current++;
    setState({ status: "idle" });
  }, []);

  return { state, dub, cancel, reset, preview, listen };
}

/**
 * Plays the dub in step with the media element, which goes silent meanwhile. The media element stays the clock:
 * the dub follows its play, pause, seek, rate and mute.
 */
export function useDubPlayback(el: HTMLMediaElement | null, url: string | null, on: boolean) {
  useEffect(() => {
    if (!el || !url || !on) return;
    const dub = new Audio(url);
    const sync = () => {
      dub.playbackRate = el.playbackRate;
      dub.muted = el.muted;
      if (Math.abs(dub.currentTime - el.currentTime) > 0.15) dub.currentTime = el.currentTime;
      if (el.paused) dub.pause();
      else void dub.play().catch(() => {});
    };
    const events = ["play", "pause", "ended", "seeked", "ratechange", "volumechange", "timeupdate"];
    events.forEach((e) => el.addEventListener(e, sync));
    el.volume = 0;
    sync();
    return () => {
      events.forEach((e) => el.removeEventListener(e, sync));
      dub.pause();
      dub.removeAttribute("src");
      el.volume = 1;
    };
  }, [el, url, on]);
}
