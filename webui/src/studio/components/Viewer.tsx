// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useEffect, useMemo, useRef, useState } from "react";
import { loadCaptionFont } from "../captions/fonts";
import { CaptionRenderer } from "../captions/renderer";
import type { CaptionSettings } from "../captions/style";
import type { Word } from "../engine";
import { clock } from "../lib/format";
import type { Player } from "../lib/usePlayer";
import { levelsAt, paletteById, type AuraFrame, type AuraLevels } from "../render/aura";
import { createCompositor, type Compositor } from "../render/compositor";
import { IconCollapse, IconExpand, IconPause, IconPlay } from "./icons";
import { RecDot } from "./Indicators";

/** The media element only decodes; the picture is drawn on the canvas. */
const MEDIA = "pointer-events-none absolute size-px opacity-0";
const HUD_BTN = "grid size-[30px] place-items-center rounded-full border-0 bg-white/14 text-white hover:bg-white/26";

/** Audio files get a 16:9 black frame so captions can still be previewed. */
const AUDIO_FRAME = { w: 1920, h: 1080 };

/**
 * The player. The media element only decodes and plays sound; the picture
 * and the caption are drawn by the same compositor that burns captions into
 * the exported video (WebGPU, with a 2D fallback). Going fullscreen enlarges
 * this whole stage, so captions stay visible.
 */
export function Viewer({
  player,
  words,
  settings,
  liveTime = null,
  liveLevels,
  bands,
  loudness,
  children,
  notice,
  lang,
  following = false,
}: {
  /** Raw microphone levels while recording (updated in place). */
  liveLevels?: React.RefObject<AuraLevels | null>;
  /** Aura band levels, for audio-only projects. */
  bands: Float32Array;
  /** Speech loudness, for "Sesle vurgula". */
  loudness: Float32Array;
  player: Player;
  words: Word[];
  settings: CaptionSettings;
  /** Live microphone: show the caption at this time, with no media element. */
  liveTime?: number | null;
  /** Shown instead of the picture when no file is open. */
  children?: React.ReactNode;
  /** Shown over the picture when it cannot be shown (a codec this browser cannot decode). */
  notice?: React.ReactNode;
  /** Language of the words; decides how they are uppercased. */
  lang: string;
  /** The preview follows a running transcription (see useFollow). */
  following?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [compositor, setCompositor] = useState<Compositor | null>(null);
  const [frame, setFrame] = useState(AUDIO_FRAME);
  const [fontTick, setFontTick] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [idle, setIdle] = useState(false);
  const { el, isVideo, url } = player;
  const live = !url && liveTime !== null;
  const active = !!url || live;
  const liveRef = useRef(0);
  liveRef.current = liveTime ?? 0;
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const paletteRef = useRef(paletteById(settings.aura).colors);
  paletteRef.current = paletteById(settings.aura).colors;

  // One compositor per canvas.
  useEffect(() => {
    if (!active) return;
    let c: Compositor | null = null;
    let live = true;
    createCompositor(canvas.current!).then((x) => {
      if (live) setCompositor((c = x));
      else x.destroy();
    });
    return () => {
      live = false;
      c?.destroy();
      setCompositor(null);
    };
  }, [active, url]);

  useEffect(() => {
    let live = true;
    loadCaptionFont(settings.font, document.fonts).then(() => live && setFontTick((n) => n + 1));
    return () => {
      live = false;
    };
  }, [settings.font]);

  useEffect(() => {
    if (!el || !isVideo) {
      setFrame(AUDIO_FRAME);
      return;
    }
    const v = el as HTMLVideoElement;
    const update = () => v.videoWidth && setFrame({ w: v.videoWidth, h: v.videoHeight });
    update();
    v.addEventListener("loadedmetadata", update);
    return () => v.removeEventListener("loadedmetadata", update);
  }, [el, isVideo]);

  const captions = useMemo(
    () =>
      words.length
        ? new CaptionRenderer(words, settings, frame.w, frame.h, settings.voiceEmphasis ? loudness : null, lang)
        : null,
    // fontTick: lay out again once the font file has loaded. Loudness only matters with voiceEmphasis.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [words, settings, frame, fontTick, settings.voiceEmphasis ? loudness : null, lang],
  );

  // The loop reads these through refs, so new words (every progress update)
  // never restart it; restarting would reset the aura's clock and stutter.
  const captionsRef = useRef(captions);
  captionsRef.current = captions;
  const auraClock = useRef(performance.now());
  const smooth = useRef<AuraLevels>({ low: 0, mid: 0, high: 0 });

  // Render loop: redraw only when the picture, caption or size changed.
  useEffect(() => {
    const c = canvas.current;
    const st = stage.current;
    if (!compositor || !c || !st || (!el && !live)) return;
    let raf = 0;
    let last = "";
    /** A video frame has been drawn: from then on a seek keeps it up until the new one is decoded. */
    let drawn = false;
    const loop = () => {
      const dpr = window.devicePixelRatio || 1;
      const fit = Math.min(1, (st.clientWidth * dpr) / frame.w, (st.clientHeight * dpr) / frame.h);
      const w = Math.max(2, Math.round(frame.w * fit));
      const h = Math.max(2, Math.round(frame.h * fit));
      const t = el && !live ? el.currentTime : liveRef.current;
      const cap = captionsRef.current?.frame(t) ?? null;
      // Audio-only: the aura. It follows the media clock (so the export
      // matches); while recording it drifts with the wall clock instead.
      let aura: AuraFrame | null = null;
      if (!isVideo || live) {
        let levels = levelsAt(bandsRef.current, t);
        const raw = live ? liveLevels?.current : null;
        if (raw) {
          // Mic levels arrive every ~100 ms; ease towards them every frame.
          const sm = smooth.current;
          for (const k of ["low", "mid", "high"] as const) {
            sm[k] += (raw[k] - sm[k]) * (raw[k] > sm[k] ? 0.35 : 0.08);
          }
          levels = { ...sm };
        }
        aura = {
          kind: "aura",
          time: live ? (performance.now() - auraClock.current) / 1000 : t,
          levels,
          palette: paletteRef.current,
        };
      }
      const key = aura
        ? `${w}x${h}|${aura.time}|${aura.palette}|${bandsRef.current.length}|${cap ? `${cap.key}|${cap.scale}` : ""}`
        : `${w}x${h}|${t}|${el?.readyState}|${cap ? `${cap.key}|${cap.scale}` : ""}`;
      const video = !aura && isVideo && el ? (el as HTMLVideoElement) : null;
      // While scrubbing, the element has no frame (readyState < 2) until the
      // seek lands; drawing then would flash black, so the last frame stays.
      const waiting = !!video && drawn && video.readyState < 2;
      if (key !== last && !waiting) {
        last = key;
        compositor.resize(w, h);
        compositor.render(aura ?? video, cap);
        if (video && video.readyState >= 2) drawn = true;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [compositor, el, isVideo, frame, live, liveLevels]);

  useEffect(() => {
    const on = () => setFullscreen(document.fullscreenElement === stage.current);
    document.addEventListener("fullscreenchange", on);
    return () => document.removeEventListener("fullscreenchange", on);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stage.current?.requestFullscreen();
  };

  // Keyboard: space play/pause, arrows seek, F fullscreen.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (!url || t.closest("input, textarea, select, [contenteditable], dialog") || e.metaKey || e.ctrlKey) return;
      if (e.key === " " && !t.closest("button")) player.toggle();
      else if (e.key === "ArrowLeft" && !t.closest("[role=slider]")) player.seek(player.time - 5);
      else if (e.key === "ArrowRight" && !t.closest("[role=slider]")) player.seek(player.time + 5);
      else if (e.key === "f" || e.key === "F") toggleFullscreen();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Hide the fullscreen controls while the pointer rests.
  useEffect(() => {
    if (!fullscreen) return;
    let timer = 0;
    const wake = () => {
      setIdle(false);
      clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2200);
    };
    wake();
    const st = stage.current!;
    st.addEventListener("pointermove", wake);
    return () => {
      clearTimeout(timer);
      st.removeEventListener("pointermove", wake);
    };
  }, [fullscreen]);

  const hidden = fullscreen && idle && player.playing;
  // Controls fade in on hover; always shown in fullscreen until the pointer rests.
  const hud = hidden
    ? "opacity-0"
    : fullscreen
      ? "px-6 pt-10 pb-5 opacity-100"
      : "px-3 pt-6 pb-2.5 opacity-0 group-hover/stage:opacity-100 focus-within:opacity-100";
  const canvasClass = `absolute inset-0 size-full object-contain ${hidden ? "cursor-none" : ""}`;

  return (
    <div
      ref={stage}
      className={`group/stage relative grid min-h-0 min-w-0 flex-1 place-items-center overflow-hidden bg-black group-data-dragging/shell:outline-2 group-data-dragging/shell:-outline-offset-8 group-data-dragging/shell:outline-cini group-data-dragging/shell:outline-dashed ${
        fullscreen ? "rounded-none" : "rounded-ui"
      } ${hidden ? "cursor-none" : ""}`}
    >
      {live ? (
        <>
          <canvas ref={canvas} className={canvasClass} aria-label="Canlı altyazı" />
          {!words.length && (
            <p className="absolute m-0 inline-flex items-center gap-2 text-fg-2">
              <RecDot /> Dinleniyor, konuşmaya başlayabilirsin
            </p>
          )}
        </>
      ) : url ? (
        <>
          {isVideo ? (
            <video ref={player.ref} src={url} className={MEDIA} playsInline preload="auto" />
          ) : (
            <audio ref={player.ref} src={url} className={MEDIA} preload="auto" />
          )}
          <canvas
            ref={canvas}
            className={canvasClass}
            onClick={player.toggle}
            onDoubleClick={toggleFullscreen}
            aria-label={player.playing ? "Duraklat" : "Oynat"}
          />
          <div
            className={`absolute inset-x-0 bottom-0 flex items-center gap-2.5 bg-linear-to-b from-transparent to-black/60 transition-opacity duration-200 ease-[ease] motion-reduce:transition-none ${hud}`}
          >
            <button className={HUD_BTN} onClick={player.toggle} aria-label={player.playing ? "Duraklat" : "Oynat"}>
              {player.playing ? <IconPause /> : <IconPlay />}
            </button>
            <span className="text-[12px] text-white tabular-nums">
              {clock(player.time)} / {clock(player.duration)}
            </span>
            {fullscreen && (
              <input
                className="flex-1 accent-cini"
                type="range"
                min={0}
                max={player.duration || 1}
                step={0.01}
                value={player.time}
                onChange={(e) => player.seek(Number(e.target.value))}
                aria-label="Konum"
              />
            )}
            <button
              className={`${HUD_BTN} ml-auto`}
              onClick={toggleFullscreen}
              aria-label={fullscreen ? "Tam ekrandan çık" : "Tam ekran"}
              title="Tam ekran (F)"
            >
              {fullscreen ? <IconCollapse /> : <IconExpand />}
            </button>
          </div>
        </>
      ) : (
        children
      )}
      {url && following && !notice && (
        <p
          className="pointer-events-none absolute top-2.5 left-2.5 m-0 inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/85"
          role="status"
        >
          <span className="size-1.5 animate-pulse rounded-full bg-cini motion-reduce:animate-none" aria-hidden />
          Yazılanı takip ediyor · oynatınca durur
        </p>
      )}
      {url && notice && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center p-6">
          <p className="m-0 max-w-[400px] rounded-ui border border-line bg-pane/95 px-4 py-3 text-center text-[13px] leading-[1.55] text-fg-2 shadow-[0_8px_24px_rgba(0,0,0,0.4)]">
            {notice}
          </p>
        </div>
      )}
    </div>
  );
}
