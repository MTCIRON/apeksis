// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useCallback, useEffect, useRef, useState } from "react";
import type { DecodeOptions, Word } from "../engine";
import { DEFAULT_MODEL, isModelId, modelFileUrl, modelInfo, type ModelId } from "../models";
import { allCached } from "../worker/modelStore";
import {
  BAND_RATE,
  DEFAULT_STT_PROVIDER,
  PEAK_STEP,
  providerOrDefault,
  type FromWorker,
  type ProviderChoice,
  type SttProvider,
  type ToWorker,
} from "../worker/protocol";
import { decodeWithAudioContext } from "./decodeFallback";
import { TRANSCRIPT_LANG } from "./lang";
import { serverTranscribe } from "./serverEngine";
import { AUDIO_FRAMES_PER_BLOCK, startServerLive, type AudioBlock, type ServerLive } from "./serverLive";
import { LiveMeter, type AuraLevels } from "../render/aura";
import { MicError, startMicrophone, type Microphone } from "./microphone";
import type { Translation } from "./translation";

export type EngineState =
  | { phase: "idle" }
  | { phase: "downloading"; loaded: number; total: number; fromCache: boolean }
  | { phase: "compiling" }
  | { phase: "ready"; provider: "webgpu" | "wasm"; gpu: string | null; fallbackReason: string | null }
  | { phase: "error"; message: string };

export type JobStatus = "running" | "done" | "cancelled" | "error";

export type PunctState =
  | { phase: "idle" }
  | { phase: "download" | "run"; done: number; total: number }
  | { phase: "error"; message: string };

export interface Job {
  id: number;
  /** For live jobs, the recording; set once recording has stopped. */
  file: File | null;
  /** Microphone job: `recording` while the mic is open. */
  live: boolean;
  recording: boolean;
  /** The model that wrote the transcript. */
  model: ModelId;
  /** Name of the subtitle file the words came from; then no model wrote them. */
  imported?: string;
  /** The words came from the Voxi server, not from a browser model ("sunucu" provider). */
  server?: true;
  options: DecodeOptions;
  status: JobStatus;
  duration: number | null;
  decoded: number;
  words: Word[];
  tentative: Word[];
  peaks: Float32Array;
  /** Aura band levels (low, mid, high interleaved at BAND_RATE). */
  bands: Float32Array;
  /** Speech loudness at BAND_RATE, for "Sesle vurgula"; empty in projects saved before it. */
  loudness: Float32Array;
  speed: number;
  elapsed: number | null;
  error: string | null;
  translation?: Translation;
  /** Where the current run started in the file: 0, or where a stopped job was continued from. */
  startAt?: number;
}

/** A stopped file job can go on from where it stopped. A server run cannot: one request, no offset. */
export const canResume = (j: Job | null): j is Job & { file: File } =>
  !!j &&
  j.status === "cancelled" &&
  !j.live &&
  !j.server &&
  !!j.file &&
  !j.imported &&
  j.decoded < (j.duration ?? Infinity) - 0.5;

const PROVIDER_KEY = "apeksis.provider";
const MODEL_KEY = "apeksis.model";

function loadModel(): ModelId {
  try {
    const v = localStorage.getItem(MODEL_KEY);
    return isModelId(v) ? v : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

/** True if the model's files are all in the cache, so loading costs no download. */
export function modelIsCached(id: ModelId) {
  const m = modelInfo(id);
  return allCached(m.files.map((f) => modelFileUrl(m, f)));
}

function loadProvider(): SttProvider {
  try {
    return providerOrDefault(localStorage.getItem(PROVIDER_KEY));
  } catch {
    return DEFAULT_STT_PROVIDER;
  }
}

const GPU_FAILED = "Ekran kartı (WebGPU) hata verdi, işlemci (WASM) kullanılıyor.";

/**
 * One 100 ms microphone block → the job's waveform.
 *
 * The server path has no worker to measure the audio, so peaks come straight
 * from the block and its band/loudness levels fill the `BAND_RATE` frames the
 * block covers (the meter resolves 100 ms, the timeline 20 ms). All of it is
 * measured from the microphone, none of it from the transcript.
 */
function withAudioBlock(j: Job, b: AudioBlock): Job {
  const bands = new Float32Array(AUDIO_FRAMES_PER_BLOCK * 3);
  const loud = new Float32Array(AUDIO_FRAMES_PER_BLOCK);
  for (let i = 0; i < AUDIO_FRAMES_PER_BLOCK; i++) {
    bands[i * 3] = b.low;
    bands[i * 3 + 1] = b.mid;
    bands[i * 3 + 2] = b.high;
    loud[i] = b.loudness;
  }
  return {
    ...j,
    decoded: j.decoded + PEAK_STEP,
    peaks: append(j.peaks, Float32Array.of(b.peak)),
    bands: append(j.bands, bands),
    loudness: append(j.loudness, loud),
  };
}

function append(a: Float32Array, b: Float32Array) {
  if (!b.length) return a;
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export function useTranscriber() {
  const workerRef = useRef<Worker | null>(null);
  const [engine, setEngine] = useState<EngineState>({ phase: "idle" });
  const engineRef = useRef<EngineState>(engine);
  /** Waiting for the model; each resolves with whether it became ready. */
  const readyWaiters = useRef<((ok: boolean) => void)[]>([]);
  const [job, setJob] = useState<Job | null>(null);
  const jobRef = useRef<Job | null>(null);
  const [punct, setPunct] = useState<PunctState>({ phase: "idle" });
  const punctWaiters = useRef(new Map<number, { resolve: (w: string[]) => void; reject: (e: Error) => void }>());
  const nextPunctId = useRef(1);
  const nextId = useRef(1);
  /** The user's choice; the worker may run on the CPU anyway after a GPU failure. */
  const [provider, setProviderState] = useState<SttProvider>(loadProvider);
  const providerRef = useRef<SttProvider>(provider);
  providerRef.current = provider;
  // What the worker should run on. "sunucu" never reaches the worker.
  const workerProvider = useRef<ProviderChoice>(provider === "sunucu" ? "auto" : provider);
  const [model, setModelState] = useState<ModelId>(loadModel);
  const workerModel = useRef<ModelId>(model);
  const cpuReason = useRef<string | undefined>(undefined);
  const onGpuFailure = useRef(() => {});

  const update = useCallback((id: number, fn: (j: Job) => Job) => {
    setJob((j) => {
      if (!j || j.id !== id) return j;
      const n = fn(j);
      jobRef.current = n;
      return n;
    });
  }, []);

  const send = useCallback((m: ToWorker, transfer: Transferable[] = []) => {
    workerRef.current?.postMessage(m, transfer);
  }, []);

  const setEngineState = useCallback((e: EngineState) => {
    engineRef.current = e;
    setEngine(e);
  }, []);

  /** Resolves once the model is ready (true) or failed to load (false). */
  const engineReady = useCallback(
    () =>
      engineRef.current.phase === "ready"
        ? Promise.resolve(true)
        : new Promise<boolean>((r) => readyWaiters.current.push(r)),
    [],
  );

  const spawn = useCallback(() => {
    const w = new Worker(new URL("../worker/asr.worker.ts", import.meta.url), { type: "module" });
    workerRef.current = w;
    const settle = (ok: boolean) => {
      const waiters = readyWaiters.current;
      readyWaiters.current = [];
      waiters.forEach((r) => r(ok));
    };
    w.onmessage = async (ev: MessageEvent<FromWorker>) => {
      // A replaced worker may still have messages in flight.
      if (workerRef.current !== w) return;
      const m = ev.data;
      switch (m.type) {
        case "download":
          setEngineState({ phase: "downloading", loaded: m.loaded, total: m.total, fromCache: m.fromCache });
          break;
        case "compiling":
          setEngineState({ phase: "compiling" });
          break;
        case "ready":
          console.debug(`[apeksis] encoder on ${m.provider}${m.gpu ? `, ${m.gpu}` : ""}`);
          setEngineState({ phase: "ready", provider: m.provider, gpu: m.gpu, fallbackReason: m.fallbackReason });
          settle(true);
          break;
        case "meta":
          update(m.jobId, (j) => ({ ...j, duration: m.duration }));
          break;
        case "progress":
          update(m.jobId, (j) => ({
            ...j,
            decoded: m.decoded,
            words: m.committed.length ? j.words.concat(m.committed) : j.words,
            tentative: m.tentative,
            peaks: append(j.peaks, m.peaks),
            bands: append(j.bands, m.bands),
            loudness: append(j.loudness, m.loudness),
            speed: m.speed,
          }));
          break;
        case "done": {
          const t = m.timing;
          console.debug(
            `[apeksis] ${m.decoded.toFixed(1)} s audio in ${m.elapsed.toFixed(2)} s; ` +
              `encoder ${(t.encoder / t.chunks).toFixed(1)} ms/chunk, search ${(t.search / t.chunks).toFixed(1)} ms/chunk, ${t.chunks} chunks`,
          );
          update(m.jobId, (j) => ({
            ...j,
            status: "done",
            decoded: j.duration ?? m.decoded,
            words: j.words.concat(m.committed),
            tentative: [],
            elapsed: m.elapsed,
            bands: append(j.bands, m.bands),
            loudness: append(j.loudness, m.loudness),
            speed: m.decoded / m.elapsed,
          }));
          break;
        }
        case "cancelled":
          update(m.jobId, (j) => ({ ...j, status: "cancelled", tentative: [] }));
          break;
        case "punct-progress":
          setPunct({ phase: m.phase, done: m.done, total: m.total });
          break;
        case "punctuated":
          setPunct({ phase: "idle" });
          punctWaiters.current.get(m.id)?.resolve(m.words);
          punctWaiters.current.delete(m.id);
          break;
        case "punct-error":
          setPunct({ phase: "error", message: m.message });
          punctWaiters.current.get(m.id)?.reject(new Error(m.message));
          punctWaiters.current.delete(m.id);
          break;
        case "error": {
          if (m.code === "gpu") {
            onGpuFailure.current();
            break;
          }
          if (m.jobId === null) {
            setEngineState({ phase: "error", message: m.message });
            settle(false);
            break;
          }
          const j = jobRef.current;
          if (m.code === "decode-unsupported" && j?.file && j.id === m.jobId) {
            // Let the browser's media stack decode the whole file instead.
            try {
              const pcm = await decodeWithAudioContext(j.file);
              send(
                { type: "transcribe-pcm", jobId: j.id, pcm, sampleRate: 16000, options: j.options, startAt: j.startAt },
                [pcm.buffer],
              );
              break;
            } catch {
              update(m.jobId, (x) => ({
                ...x,
                status: "error",
                error: "Bu dosyanın sesi tarayıcıda çözülemedi. MP4, WebM, MP3, M4A veya WAV olarak kaydedip yeniden dene.",
              }));
              break;
            }
          }
          update(m.jobId, (x) => ({ ...x, status: "error", error: m.message }));
          break;
        }
      }
    };
  }, [send, update, setEngineState]);

  useEffect(() => {
    spawn();
    return () => {
      workerRef.current?.terminate();
      workerRef.current = null;
    };
  }, [spawn]);

  /**
   * Replace the worker. The wasm runtime fixes its thread count when it
   * starts and GPU memory is only reliably freed with the worker, so a
   * provider change means a fresh worker (the model comes from the cache).
   */
  const restartWorker = useCallback(
    (p: ProviderChoice, reason?: string) => {
      workerRef.current?.terminate();
      workerProvider.current = p;
      cpuReason.current = reason;
      for (const w of punctWaiters.current.values()) w.reject(new Error("Yarıda kaldı"));
      punctWaiters.current.clear();
      setPunct({ phase: "idle" });
      setEngineState({ phase: "idle" });
      spawn();
    },
    [spawn, setEngineState],
  );

  const prepare = useCallback(() => {
    const e = engineRef.current;
    if (e.phase !== "idle" && e.phase !== "error") return;
    send({ type: "init", model: workerModel.current, provider: workerProvider.current, reason: cpuReason.current });
    if (e.phase === "error") setEngineState({ phase: "idle" });
  }, [send, setEngineState]);

  const mic = useRef<Microphone | null>(null);
  /** Real-time microphone meter (levels for the aura, peaks for the timeline). */
  const liveMeter = useRef<LiveMeter | null>(null);
  const liveLevels = useRef<AuraLevels | null>(null);
  /** The live server run, when the "sunucu" provider drives the microphone. */
  const serverLive = useRef<ServerLive | null>(null);

  /** End a live server run without touching the job (opening a file, loading one). */
  const endServerLive = useCallback(() => {
    const live = serverLive.current;
    serverLive.current = null;
    liveLevels.current = null;
    if (live) void live.stop();
  }, []);

  /** A microphone start waiting for the model; bumping the ticket abandons it. */
  const [liveWaiting, setLiveWaiting] = useState(false);
  const liveTicket = useRef(0);
  const cancelLiveWait = useCallback(() => {
    liveTicket.current++;
    setLiveWaiting(false);
  }, []);

  /** The server run in flight, so "Durdur" can abort the request. */
  const serverRun = useRef<{ jobId: number; ac: AbortController } | null>(null);

  /**
   * The "sunucu" provider: one request, one answer. It fills the SAME job a
   * local run would fill — words, duration, elapsed — so the transcript, the
   * timeline, undo and project saving all behave identically afterwards.
   */
  const runServer = useCallback(
    async (jobId: number, file: File) => {
      const ac = new AbortController();
      serverRun.current = { jobId, ac };
      const started = performance.now();
      try {
        const { words, duration } = await serverTranscribe(file, { signal: ac.signal });
        const elapsed = (performance.now() - started) / 1000;
        // `update` only touches the job with this id: a newer job is left alone.
        update(jobId, (j) => ({
          ...j,
          status: "done",
          words,
          tentative: [],
          duration: duration ?? j.duration,
          decoded: duration ?? j.decoded,
          elapsed,
          speed: duration ? duration / elapsed : 0,
        }));
      } catch (e) {
        if (ac.signal.aborted) {
          update(jobId, (j) => ({ ...j, status: "cancelled", tentative: [] }));
        } else {
          update(jobId, (j) => ({
            ...j,
            status: "error",
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      } finally {
        if (serverRun.current?.jobId === jobId) serverRun.current = null;
      }
    },
    [update],
  );

  const start = useCallback(
    (file: File, options: DecodeOptions) => {
      const prev = jobRef.current;
      if (prev?.status === "running") {
        const run = serverRun.current;
        if (run && run.jobId === prev.id) run.ac.abort();
        else send({ type: "cancel", jobId: prev.id });
      }
      // Opening a file while recording (or waiting to record) ends the recording.
      cancelLiveWait();
      endServerLive();
      void mic.current?.stop();
      mic.current = null;
      const server = providerRef.current === "sunucu";
      // The model is only needed when the browser transcribes.
      if (!server) prepare();
      const j: Job = {
        id: nextId.current++,
        file,
        live: false,
        recording: false,
        model: workerModel.current,
        options,
        status: "running",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        loudness: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
        ...(server ? { server: true as const } : {}),
      };
      jobRef.current = j;
      setJob(j);
      if (server) void runServer(j.id, file);
      else send({ type: "transcribe", jobId: j.id, file, options });
    },
    [prepare, send, cancelLiveWait, endServerLive, runServer],
  );

  /**
   * Open a saved transcript as a finished job; `file` may come later (attach).
   * `stoppedAt`: the transcription was stopped there, it can be continued.
   */
  const load = useCallback(
    (
      p: Pick<
        Job,
        "file" | "model" | "imported" | "options" | "duration" | "elapsed" | "words" | "peaks" | "bands" | "loudness" | "translation"
      > & { stoppedAt?: number | null },
    ) => {
      const prev = jobRef.current;
      if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
      cancelLiveWait();
      endServerLive();
      void mic.current?.stop();
      mic.current = null;
      const { stoppedAt, ...rest } = p;
      // Only a sane position counts (project files can be edited by hand).
      const stopped = typeof stoppedAt === "number" && stoppedAt >= 0;
      const j: Job = {
        ...rest,
        id: nextId.current++,
        live: false,
        recording: false,
        status: stopped ? "cancelled" : "done",
        decoded: stopped ? stoppedAt : (p.duration ?? p.words.at(-1)?.end ?? 0),
        tentative: [],
        speed: p.duration && p.elapsed ? p.duration / p.elapsed : 0,
        error: null,
      };
      jobRef.current = j;
      setJob(j);
      return j.id;
    },
    [send, cancelLiveWait, endServerLive],
  );

  /** Give a loaded job its media. */
  const attach = useCallback(
    (file: File) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(j.id, (x) => ({ ...x, file }));
    },
    [update],
  );

  /** Start transcribing the microphone. Rejects with a readable message. */
  const startLive = useCallback(
    async (options: DecodeOptions) => {
      const server = providerRef.current === "sunucu";
      const prev = jobRef.current;
      if (prev?.status === "running") send({ type: "cancel", jobId: prev.id });
      // The model is only needed when the browser transcribes.
      if (!server) prepare();
      // Open the microphone only once the recognizer is ready: speech captured
      // before that would pile up unseen and arrive as one late burst. The
      // server path has nothing to load — it waits for the socket handshake
      // inside `startServerLive`, so the same rule holds there.
      const ticket = ++liveTicket.current;
      if (!server && engineRef.current.phase !== "ready") {
        setLiveWaiting(true);
        const ok = await engineReady();
        if (ticket !== liveTicket.current) return;
        setLiveWaiting(false);
        if (!ok) return; // The status bar shows why.
      }
      const id = nextId.current++;
      const base: Job = {
        id,
        file: null,
        live: true,
        recording: true,
        model: workerModel.current,
        options,
        status: "running",
        duration: null,
        decoded: 0,
        words: [],
        tentative: [],
        peaks: new Float32Array(0),
        bands: new Float32Array(0),
        loudness: new Float32Array(0),
        speed: 0,
        elapsed: null,
        error: null,
      };
      if (server) {
        // The server writes the words; the waveform is measured here.
        const live = await startServerLive(
          {
            onPartial: (text, start, end) =>
              update(id, (x) => ({
                ...x,
                tentative: text ? [{ text, start, end: Math.max(start, end) }] : [],
              })),
            onFinal: (words) =>
              update(id, (x) => ({ ...x, words: x.words.concat(words), tentative: [] })),
            onAudio: (block) => update(id, (x) => withAudioBlock(x, block)),
            onMeter: (m) => {
              // The aura and the timeline read these refs every frame, so both
              // react while the server is still writing the words.
              liveMeter.current = m;
              liveLevels.current = m.levels;
            },
            onError: (message) => update(id, (x) => ({ ...x, error: message })),
          },
          { language: TRANSCRIPT_LANG },
        );
        if (ticket !== liveTicket.current) {
          void live.stop();
          return;
        }
        serverLive.current = live;
        const j: Job = { ...base, server: true };
        jobRef.current = j;
        setJob(j);
        return;
      }
      let meter: LiveMeter | null = null;
      const m = await startMicrophone((pcm) => {
        meter?.push(pcm);
        send({ type: "live-audio", jobId: id, pcm }, [pcm.buffer]);
      });
      meter = new LiveMeter(m.sampleRate);
      liveMeter.current = meter;
      liveLevels.current = meter.levels;
      mic.current = m;
      const j: Job = { ...base };
      jobRef.current = j;
      setJob(j);
      send({ type: "live-start", jobId: id, sampleRate: m.sampleRate, options });
    },
    [prepare, send, engineReady, update],
  );

  /** Stop the microphone; the recording becomes the job's file. */
  const stopLive = useCallback(async () => {
    cancelLiveWait();
    const j = jobRef.current;
    const live = serverLive.current;
    if (j?.live && live) {
      serverLive.current = null;
      liveLevels.current = null;
      liveMeter.current = null;
      update(j.id, (x) => ({ ...x, recording: false }));
      const decoded = live.decoded;
      const elapsed = live.elapsed;
      const file = await live.stop();
      update(j.id, (x) => ({
        ...x,
        file,
        duration: x.duration ?? decoded,
        status: "done",
        elapsed,
        speed: elapsed > 0 ? decoded / elapsed : 0,
        tentative: [],
      }));
      return;
    }
    const m = mic.current;
    if (!j?.live || !m) return;
    mic.current = null;
    liveLevels.current = null;
    liveMeter.current = null;
    send({ type: "live-stop", jobId: j.id });
    update(j.id, (x) => ({ ...x, recording: false }));
    const file = await m.stop();
    update(j.id, (x) => ({ ...x, file, duration: x.duration ?? x.decoded }));
  }, [send, update, cancelLiveWait]);

  const cancel = useCallback(() => {
    cancelLiveWait();
    const j = jobRef.current;
    const run = serverRun.current;
    // A server run is cancelled by aborting the request, not by the worker.
    if (run && j?.id === run.jobId && j.status === "running") {
      run.ac.abort();
      update(j.id, (x) => ({ ...x, status: "cancelled", tentative: [] }));
      return;
    }
    if (j?.live && j.recording) void stopLive();
    else if (j?.status === "running") send({ type: "cancel", jobId: j.id });
  }, [send, stopLive, cancelLiveWait, update]);

  const clear = useCallback(() => {
    cancel();
    jobRef.current = null;
    setJob(null);
  }, [cancel]);

  // Release the microphone and the socket if the page goes away mid-recording.
  useEffect(
    () => () => {
      void mic.current?.stop();
      void serverLive.current?.stop();
    },
    [],
  );

  /** Punctuate and true-case plain words; resolves with one written word per input word. */
  const punctuate = useCallback(
    (words: string[]) =>
      new Promise<string[]>((resolve, reject) => {
        const id = nextPunctId.current++;
        punctWaiters.current.set(id, { resolve, reject });
        setPunct({ phase: "run", done: 0, total: 1 });
        send({ type: "punctuate", id, words });
      }),
    [send],
  );

  /** Replace the transcript of a finished job (user edits). */
  const setWords = useCallback(
    (words: Word[]) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(j.id, (x) => ({ ...x, words }));
    },
    [update],
  );

  /** Set, edit or drop the translation of a job, if it is still open. */
  const setTranslation = useCallback(
    (jobId: number, translation: Translation | undefined) => {
      const j = jobRef.current;
      if (j && j.status !== "running") update(jobId, (x) => ({ ...x, translation }));
    },
    [update],
  );

  // WebGPU failed (loading or mid-file): go on with the CPU. A file starts
  // over there; a recording stops, since its audio so far went to the old worker.
  onGpuFailure.current = () => {
    const j = jobRef.current;
    const m = modelInfo(workerModel.current);
    if (m.gpuOnly) {
      // No CPU to fall back to: say so and leave the choice to the user.
      const message = `Ekran kartı hata verdi. ${m.name} işlemcide çalışmaz; Seda ile deneyebilirsin.`;
      restartWorker(workerProvider.current);
      setEngineState({ phase: "error", message });
      if (j?.status === "running") update(j.id, (x) => ({ ...x, status: "error", tentative: [], error: message }));
      return;
    }
    restartWorker("wasm", GPU_FAILED);
    if (j?.status === "running" && j.live) {
      void stopLive();
      update(j.id, (x) => ({
        ...x,
        status: "error",
        tentative: [],
        error: "Ekran kartı hata verdi, kayıt durduruldu. İşlemciyle yeniden kaydedebilirsin.",
      }));
    } else if (j?.status === "running" && j.file) {
      start(j.file, j.options);
      return;
    }
    prepare();
  };

  /** Choose where transcription runs; a browser choice reloads the model (from the cache) if it was loaded. */
  const setProvider = useCallback(
    (p: SttProvider) => {
      try {
        localStorage.setItem(PROVIDER_KEY, p);
      } catch {
        // Not remembered, still used for this visit.
      }
      setProviderState(p);
      // The server transcribes on its own; no browser model is involved.
      if (p === "sunucu") return;
      const was = engineRef.current.phase;
      restartWorker(p);
      if (was !== "idle") prepare();
    },
    [restartWorker, prepare],
  );

  /**
   * Choose the speech model; the next transcription uses it. Loads it right
   * away only if it was loaded before and costs no download.
   */
  const setModel = useCallback(
    (m: ModelId) => {
      try {
        localStorage.setItem(MODEL_KEY, m);
      } catch {
        // Not remembered, still used for this visit.
      }
      setModelState(m);
      workerModel.current = m;
      const was = engineRef.current.phase;
      // Back to the user's provider choice: a CPU fallback was for the old model.
      // The server never loads a browser model, so the worker keeps its own choice.
      restartWorker(provider === "sunucu" ? workerProvider.current : provider);
      if (was !== "idle") void modelIsCached(m).then((yes) => yes && workerModel.current === m && prepare());
    },
    [restartWorker, prepare, provider],
  );

  /**
   * Go on with a stopped job from where it stopped. The words so far stay;
   * the waveform and aura are cut back to that point, since the worker may
   * have read a little further than it wrote. The model that wrote the
   * job writes the rest, so the selected model switches back to it if needed.
   */
  const resume = useCallback(() => {
    const j = jobRef.current;
    if (!canResume(j)) return;
    if (workerModel.current !== j.model) setModel(j.model);
    prepare();
    const at = j.decoded;
    const bands = Math.floor(at * BAND_RATE);
    update(j.id, (x) => ({
      ...x,
      status: "running",
      startAt: at,
      error: null,
      tentative: [],
      speed: 0,
      elapsed: null,
      peaks: x.peaks.slice(0, Math.floor(at / PEAK_STEP)),
      bands: x.bands.slice(0, bands * 3),
      loudness: x.loudness.slice(0, bands),
    }));
    send({ type: "transcribe", jobId: j.id, file: j.file, options: j.options, startAt: at });
  }, [prepare, send, update, setModel]);

  return { engine, job, liveWaiting, provider, setProvider, model, setModel, prepare, start, load, attach, startLive, stopLive, cancel, resume, clear, setWords, setTranslation, liveLevels, liveMeter, punctuate, punct };
}

export { MicError };
