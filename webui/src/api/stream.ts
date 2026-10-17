// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { loadSettings } from "../lib/settings";
import { pushLog } from "../lib/debug";

// WebSocket streaming clients for the gateway's custom protocols, verified against
// src/voxi/gateway.py and src/voxi/media.py. Frame/event names are NOT assumed here:
//   TTS  /v1/tts/stream              speak → meta → (>HH framed) PCM16 → done|cancelled
//   STT  /v1/realtime/transcriptions  session.start → raw PCM16 → partial/final (+VAD)

const HEADER_BYTES = 4; // big-endian uint16 generation_id + uint16 sequence

export type StreamSampleRate = 8000 | 16000 | 24000 | 48000;
export type SttSampleRate = 8000 | 16000;
export type ChunkMs = 20 | 40 | 60 | 100 | 120 | 200;

/**
 * Absolute ws(s) URL for a gateway route.
 *
 * F5 security: prefer `?ticket=<opaque>` minted via `mintSocketTicket()`.
 * The ticket is single-use and short-TTL, so seeing it in the URL is not a
 * credential leak. If no ticket is supplied (older gateway without
 * /v1/auth/socket, or a caller that skipped the mint), fall back to the
 * legacy `?token=` path so behaviour is unchanged; the nginx `voxi_safe`
 * log format suppresses the query string either way.
 */
function wsUrl(route: string, ticket?: string): string {
  const { apiKey, baseUrl } = loadSettings();
  const origin =
    baseUrl && /^https?:\/\//.test(baseUrl) ? baseUrl : `${location.protocol}//${location.host}`;
  const url = new URL(route, origin.endsWith("/") ? origin : `${origin}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  if (ticket) {
    url.searchParams.set("ticket", ticket);
  } else if (apiKey) {
    url.searchParams.set("token", apiKey);
  }
  return url.toString();
}

// Only safe metadata is logged: never transcript text, audio bytes or the token.
function logWs(route: string, summary: string, extra: { ms?: number; status?: number } = {}): void {
  pushLog({ kind: "ws", method: "WS", path: route, detail: summary, ...extra });
}

export interface TtsMeta {
  generationId: number;
  sampleRate: number;
  channels: number;
  encoding: string;
  chunkMs: number;
}

export interface TtsSpeakRequest {
  model: string;
  input: string;
  voice: string;
  sampleRate: StreamSampleRate;
  chunkMs: ChunkMs;
  speed?: number;
  seed?: number;
  generationId: number;
}

export interface TtsCallbacks {
  onOpen: () => void;
  onMeta: (meta: TtsMeta) => void;
  onAudio: (pcm: Int16Array) => void;
  onDone: (chunks: number, durationMs: number) => void;
  onCancelled: (chunks: number) => void;
  onError: (code: string, message: string) => void;
  onClose: (code: number, reason: string) => void;
  onFirstAudio: (ms: number) => void;
}

export interface TtsConnection {
  speak: (request: TtsSpeakRequest) => void;
  cancel: (generationId: number) => void;
  ping: () => void;
  close: () => void;
  readonly ready: boolean;
}

/** Open a TTS streaming socket. The connection is reusable across sequential speak requests. */
export function connectTts(callbacks: TtsCallbacks, ticket?: string): TtsConnection {
  const route = "/v1/tts/stream";
  const ws = new WebSocket(wsUrl(route, ticket));
  ws.binaryType = "arraybuffer";
  let sentAt: number | null = null;
  let firstAudioSeen = false;

  ws.onopen = () => {
    logWs(route, "connected");
    callbacks.onOpen();
  };
  ws.onclose = (event) => {
    logWs(route, `closed code=${event.code}`);
    callbacks.onClose(event.code, event.reason);
  };
  ws.onerror = () => logWs(route, "socket error");
  ws.onmessage = (event) => {
    if (typeof event.data !== "string") {
      const buffer = event.data as ArrayBuffer;
      if (buffer.byteLength <= HEADER_BYTES) return;
      if (sentAt !== null && !firstAudioSeen) {
        firstAudioSeen = true;
        const ms = Math.round(performance.now() - sentAt);
        logWs(route, "first audio", { ms });
        callbacks.onFirstAudio(ms);
      }
      callbacks.onAudio(new Int16Array(buffer, HEADER_BYTES));
      return;
    }
    const payload = JSON.parse(event.data) as Record<string, unknown>;
    switch (payload.type) {
      case "meta":
        callbacks.onMeta({
          generationId: Number(payload.generation_id ?? 0),
          sampleRate: Number(payload.sample_rate ?? 16000),
          channels: Number(payload.channels ?? 1),
          encoding: String(payload.encoding ?? "pcm_s16le"),
          chunkMs: Number(payload.chunk_ms ?? 100),
        });
        break;
      case "done":
        logWs(route, `done chunks=${payload.chunks}`, {
          ms: Number(payload.duration_ms ?? 0),
        });
        callbacks.onDone(Number(payload.chunks ?? 0), Number(payload.duration_ms ?? 0));
        break;
      case "cancelled":
        logWs(route, `cancelled chunks=${payload.chunks}`);
        callbacks.onCancelled(Number(payload.chunks ?? 0));
        break;
      case "error":
        logWs(route, `error ${payload.code}`);
        callbacks.onError(String(payload.code ?? "stream_error"), String(payload.message ?? ""));
        break;
      case "pong":
        logWs(route, "pong");
        break;
      default:
        break;
    }
  };

  return {
    speak(request) {
      if (ws.readyState !== WebSocket.OPEN) return;
      sentAt = performance.now();
      firstAudioSeen = false;
      const frame: Record<string, unknown> = {
        type: "speak",
        model: request.model,
        input: request.input,
        voice: request.voice,
        sample_rate: request.sampleRate,
        chunk_ms: request.chunkMs,
        generation_id: request.generationId,
      };
      if (request.speed !== undefined) frame.speed = request.speed;
      if (request.seed !== undefined) frame.seed = request.seed;
      ws.send(JSON.stringify(frame));
      logWs(route, `speak gen=${request.generationId}`);
    },
    cancel(generationId) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "cancel", generation_id: generationId }));
        logWs(route, "cancel");
      }
    },
    ping() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Client closed");
      }
    },
    get ready() {
      return ws.readyState === WebSocket.OPEN;
    },
  };
}

export interface SttVad {
  startMs: number;
  endMs: number;
  minSpeechMs: number;
  maxUtteranceMs: number;
  partialIntervalMs: number;
}

export interface SttStartRequest {
  model: string;
  language: string;
  sampleRate: SttSampleRate;
  prompt?: string;
  startMs?: number;
  endMs?: number;
  minSpeechMs?: number;
  partialIntervalMs?: number;
  maxUtteranceMs?: number;
}

export interface SttFinalEvent {
  utteranceId: string;
  text: string;
  revision: number;
  durationMs: number;
  truncated: boolean;
}

export interface SttCallbacks {
  onOpen: () => void;
  onStarted: (sessionId: string, sampleRate: number, vad: SttVad) => void;
  onSpeechStarted: (utteranceId: string, startedMs: number) => void;
  onPartial: (utteranceId: string, text: string, revision: number) => void;
  onSpeechEnded: (utteranceId: string, info: { endedMs: number; durationMs?: number; rejectedMs?: number }) => void;
  onFinal: (event: SttFinalEvent) => void;
  onError: (code: string, message: string) => void;
  onSessionEnded: () => void;
  onClose: (code: number, reason: string) => void;
}

export interface SttConnection {
  sendPcm: (chunk: ArrayBuffer) => boolean;
  flush: () => void;
  stop: () => void;
  close: () => void;
  ping: () => void;
  readonly started: boolean;
}

/**
 * Open a realtime transcription socket and send the mandatory session.start handshake
 * as the first frame. sendPcm is ignored until the server acknowledges with session.started.
 */
export function connectStt(
  request: SttStartRequest,
  callbacks: SttCallbacks,
  ticket?: string,
): SttConnection {
  const route = "/v1/realtime/transcriptions";
  const ws = new WebSocket(wsUrl(route, ticket));
  ws.binaryType = "arraybuffer";
  let started = false;

  ws.onopen = () => {
    logWs(route, "connected");
    const frame: Record<string, unknown> = {
      type: "session.start",
      model: request.model,
      language: request.language,
      sample_rate: request.sampleRate,
    };
    if (request.prompt) frame.prompt = request.prompt;
    if (request.startMs !== undefined) frame.start_ms = request.startMs;
    if (request.endMs !== undefined) frame.end_ms = request.endMs;
    if (request.minSpeechMs !== undefined) frame.min_speech_ms = request.minSpeechMs;
    if (request.partialIntervalMs !== undefined) frame.partial_interval_ms = request.partialIntervalMs;
    if (request.maxUtteranceMs !== undefined) frame.max_utterance_ms = request.maxUtteranceMs;
    ws.send(JSON.stringify(frame));
    logWs(route, "session.start sent");
    callbacks.onOpen();
  };
  ws.onclose = (event) => {
    started = false;
    logWs(route, `closed code=${event.code}`);
    callbacks.onClose(event.code, event.reason);
  };
  ws.onerror = () => logWs(route, "socket error");
  ws.onmessage = (event) => {
    // Downlink transcription frames are always JSON events.
    if (typeof event.data !== "string") return;
    const payload = JSON.parse(event.data) as Record<string, unknown>;
    switch (payload.type) {
      case "session.started": {
        started = true;
        const vad = (payload.vad ?? {}) as Record<string, number>;
        logWs(route, `session.started mode=${payload.mode}`);
        callbacks.onStarted(String(payload.session_id ?? ""), Number(payload.sample_rate ?? 16000), {
          startMs: vad.start_ms ?? 0,
          endMs: vad.end_ms ?? 0,
          minSpeechMs: vad.min_speech_ms ?? 0,
          maxUtteranceMs: vad.max_utterance_ms ?? 0,
          partialIntervalMs: vad.partial_interval_ms ?? 0,
        });
        break;
      }
      case "speech.started":
        // Event text is never logged; it is delivered to callbacks only.
        callbacks.onSpeechStarted(String(payload.utterance_id ?? ""), Number(payload.started_ms ?? 0));
        break;
      case "transcript.partial":
        callbacks.onPartial(
          String(payload.utterance_id ?? ""),
          String(payload.text ?? ""),
          Number(payload.revision ?? 0)
        );
        break;
      case "speech.ended":
        callbacks.onSpeechEnded(String(payload.utterance_id ?? ""), {
          endedMs: Number(payload.ended_ms ?? 0),
          durationMs: payload.duration_ms === undefined ? undefined : Number(payload.duration_ms),
          rejectedMs: payload.rejected_ms === undefined ? undefined : Number(payload.rejected_ms),
        });
        break;
      case "transcript.final":
        logWs(route, `final rev=${payload.revision}`);
        callbacks.onFinal({
          utteranceId: String(payload.utterance_id ?? ""),
          text: String(payload.text ?? ""),
          revision: Number(payload.revision ?? 0),
          durationMs: Number(payload.duration_ms ?? 0),
          truncated: Boolean(payload.truncated ?? false),
        });
        break;
      case "error":
        logWs(route, `error ${payload.code}`);
        callbacks.onError(String(payload.code ?? "stream_error"), String(payload.message ?? ""));
        break;
      case "session.ended":
        logWs(route, "session.ended");
        callbacks.onSessionEnded();
        break;
      case "pong":
        break;
      default:
        break;
    }
  };

  return {
    sendPcm(chunk) {
      if (started && ws.readyState === WebSocket.OPEN) {
        ws.send(chunk);
        return true;
      }
      return false;
    },
    flush() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "flush" }));
    },
    stop() {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "session.stop" }));
      }
    },
    close() {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, "Client closed");
      }
    },
    ping() {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
    },
    get started() {
      return started && ws.readyState === WebSocket.OPEN;
    },
  };
}
