// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useEffect, useRef, useState } from "react";
import type { Word } from "../engine";
import type { Player } from "./usePlayer";
import type { Job } from "./useTranscriber";

/** How often the preview moves on. */
const TICK_MS = 400;
/** Each tick covers this share of the way to the newest word, at least STEP_MIN seconds... */
const STEP_SHARE = 0.3;
const STEP_MIN = 0.6;

/**
 * While a file is transcribed, the preview follows the writing: a few times
 * a second it moves toward the newest word, by seeking only (no playback, no
 * sound), so the picture and the caption show what is being written. Models
 * that write a piece at a time (Duyu, Whisper) are walked through word by
 * word instead of jumping. Playing or seeking hands the player back to the
 * user until the job ends. A job that finishes while followed goes back to
 * the start, ready to play.
 *
 * Returns whether the preview is following now.
 */
export function useFollow(player: Player, job: Job | null): boolean {
  const [following, setFollowing] = useState(false);
  const words = useRef<Word[]>([]);
  words.current = job?.words ?? [];
  const followed = useRef<number | null>(null);

  const { el, preview, touches } = player;
  const active = job?.status === "running" && !job.live && !!job.file && !!el;
  const jobId = job?.id;
  const startAt = job?.startAt ?? 0;

  useEffect(() => {
    // Not when the user is already watching.
    if (!active || !el || !el.paused) return;
    const start = touches.current;
    // A continued job starts where it stopped.
    let cursor = Math.max(el.currentTime, startAt);
    if (cursor !== el.currentTime) preview(cursor);
    followed.current = jobId ?? null;
    setFollowing(true);
    const stop = () => {
      clearInterval(timer);
      followed.current = null;
      setFollowing(false);
    };
    const timer = window.setInterval(() => {
      if (touches.current !== start || !el.paused) {
        stop();
        return;
      }
      const ws = words.current;
      const target = ws.length ? ws[ws.length - 1].start : 0;
      const gap = target - cursor;
      if (gap <= 0.05) return;
      cursor += Math.min(gap, Math.max(STEP_MIN, gap * STEP_SHARE));
      preview(cursor);
    }, TICK_MS);
    return () => {
      clearInterval(timer);
      setFollowing(false);
    };
  }, [active, el, preview, touches, jobId, startAt]);

  // Finished while followed: back to the start. Stopped: a later run
  // (continuing the job) decides afresh.
  const done = job?.status === "done";
  const stopped = job?.status === "cancelled";
  if (stopped && followed.current === jobId) followed.current = null;
  useEffect(() => {
    if (done && jobId !== undefined && followed.current === jobId) {
      followed.current = null;
      preview(0);
    }
  }, [done, jobId, preview]);

  return following;
}
