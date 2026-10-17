// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

export interface Player {
  /** Attach to the (invisible) <video>/<audio> that does decoding and sound. */
  ref: (el: HTMLMediaElement | null) => void;
  el: HTMLMediaElement | null;
  url: string | null;
  isVideo: boolean;
  time: number;
  duration: number;
  playing: boolean;
  muted: boolean;
  toggle: () => void;
  seek: (t: number) => void;
  /** Seek for the app itself (e.g. following a transcription): not counted in `touches`. */
  preview: (t: number) => void;
  /** How often the user played, paused or sought; changes mean they took over. */
  touches: RefObject<number>;
  setMuted: (m: boolean) => void;
}

/** Might have a picture. Containers like WebM/MP4 can also be audio-only;
 *  usePlayer settles that once the metadata has loaded. */
export const isVideoFile = (f: File) =>
  f.type ? f.type.startsWith("video/") : /\.(mp4|mov|mkv|webm|m4v)$/i.test(f.name);

/** Media element state for the custom WebGPU player. */
export function usePlayer(file: File | null): Player {
  const [el, setEl] = useState<HTMLMediaElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [muted, setMutedState] = useState(false);
  /** null until metadata says whether the file has a picture. */
  const [hasPicture, setHasPicture] = useState<boolean | null>(null);
  /** Where a scrub wants to be once the running seek lands. */
  const pending = useRef<number | null>(null);
  /** The scrub's latest time, shown at the next frame (see seek). */
  const scrubTo = useRef(0);
  const scrubFrame = useRef(0);
  const touches = useRef(0);

  // Object URL tied to the effect, so StrictMode's re-run cannot revoke one in use.
  useEffect(() => {
    setTime(0);
    setDuration(0);
    setPlaying(false);
    setHasPicture(null);
    if (!file) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(file);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [file]);

  useEffect(() => {
    pending.current = null;
    if (!el) return;
    const on = (type: string, fn: () => void) => {
      el.addEventListener(type, fn);
      return () => el.removeEventListener(type, fn);
    };
    const offs = [
      on("timeupdate", () => setTime(el.currentTime)),
      on("seeked", () => {
        // A scrub moved on while this seek ran: go there now.
        const t = pending.current;
        pending.current = null;
        if (t !== null && t !== el.currentTime) el.currentTime = t;
        else setTime(el.currentTime);
      }),
      on("durationchange", () => setDuration(Number.isFinite(el.duration) ? el.duration : 0)),
      on("play", () => setPlaying(true)),
      on("pause", () => setPlaying(false)),
      on("ended", () => setPlaying(false)),
      on("volumechange", () => setMutedState(el.muted)),
      on("loadedmetadata", () => setHasPicture(el instanceof HTMLVideoElement && el.videoWidth > 0)),
    ];
    // timeupdate fires ~4×/s; follow playback more closely for word
    // highlights, but not faster than ~25 updates/s (React re-renders).
    let raf = 0;
    let last = -1;
    const tick = () => {
      if (!el.paused && Math.abs(el.currentTime - last) >= 0.04) {
        last = el.currentTime;
        setTime(last);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      offs.forEach((f) => f());
      cancelAnimationFrame(raf);
      cancelAnimationFrame(scrubFrame.current);
      scrubFrame.current = 0;
    };
  }, [el]);

  const toggle = useCallback(() => {
    if (!el) return;
    touches.current++;
    if (el.paused) void el.play();
    else el.pause();
  }, [el]);

  // Scrubbing sets a new time on every pointer move. Each one cancels the seek
  // before it, so no frame is ever decoded; while one runs, keep only the latest.
  const preview = useCallback(
    (t: number) => {
      if (!el) return;
      const to = Math.max(0, t);
      if (el.seeking) pending.current = to;
      else el.currentTime = to;
      // Pointer moves can come faster than the screen redraws, and each time
      // re-renders the app: show only the latest, once per frame.
      scrubTo.current = to;
      scrubFrame.current ||= requestAnimationFrame(() => {
        scrubFrame.current = 0;
        setTime(scrubTo.current);
      });
    },
    [el],
  );

  const seek = useCallback(
    (t: number) => {
      touches.current++;
      preview(t);
    },
    [preview],
  );

  const setMuted = useCallback((m: boolean) => el && (el.muted = m), [el]);

  return {
    ref: setEl,
    el,
    url,
    // A video container without a video track is treated as audio (aura).
    isVideo: !!file && isVideoFile(file) && hasPicture !== false,
    time,
    duration,
    playing,
    muted,
    toggle,
    seek,
    preview,
    touches,
    setMuted,
  };
}
