// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { loadSettings } from "../lib/settings";
import { pushLog } from "../lib/debug";
import { parseRuntimeStatus, type RuntimeStatus } from "../lib/runtimeStatus";

export interface ModelEntry {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  capabilities?: Record<string, unknown>;
}

export interface ModelList {
  object: string;
  data: ModelEntry[];
}

export interface HealthResponse {
  status: string;
}

export interface ReadinessResponse {
  status?: string;
  workers?: Record<string, boolean>;
  [key: string]: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly requestId: string,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call(path: string, init: RequestInit = {}, silent = false): Promise<Response> {
  const { apiKey, baseUrl } = loadSettings();
  const url = `${baseUrl}${path}`;
  const headers = new Headers(init.headers);
  if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
  const method = init.method ?? "GET";
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers });
  } catch (error) {
    // An aborted request is not a network failure: the caller cancelled it.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    if (!silent) pushLog({ kind: "error", method, path: redactPath(path), detail: String(error) });
    throw new ApiError(0, "network", "", `Ağ hatası: ${String(error)}`);
  }
  const ms = Math.round(performance.now() - started);
  const requestId = response.headers.get("x-request-id") ?? "";
  if (!silent) pushLog({ kind: "http", method, path: redactPath(path), status: response.status, ms, requestId });
  return response;
}

/** The log (Settings → Günlük) must never surface a full session id (it is
 *  effectively a capability handle for /v1/sessions/{id}/... ) or any
 *  transcript/action text. */
function redactPath(path: string): string {
  return path.replace(/(\/sessions\/)([0-9a-f]{6})[0-9a-f]+([0-9a-f]{4})/gi, "$1$2…$3");
}

async function errorFrom(response: Response): Promise<ApiError> {
  const requestId = response.headers.get("x-request-id") ?? "";
  let code = "http_error";
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    /* non-JSON error body */
  }
  return new ApiError(response.status, code, requestId, message);
}

export async function getJson<T>(path: string, init: RequestInit = {}, silent = false): Promise<T> {
  const response = await call(path, init, silent);
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as T;
}

export const fetchHealth = (silent = false): Promise<HealthResponse> => getJson<HealthResponse>("/healthz", {}, silent);
export const fetchReadiness = (silent = false): Promise<ReadinessResponse> => getJson<ReadinessResponse>("/readyz", {}, silent);
export interface EndpointEntry {
  method: string;
  path: string;
  service: string;
  /** The scope a key needs for this route; empty for public routes. Absent from
   * a gateway older than Plan 3 Aşama B, in which case nothing is shown. */
  scopes?: string[];
  purpose: string;
}

export interface EndpointCatalog {
  endpoints: EndpointEntry[];
}

export const fetchModels = (): Promise<ModelList> => getJson<ModelList>("/v1/models");
export const fetchEndpoints = (): Promise<EndpointCatalog> =>
  getJson<EndpointCatalog>("/v1/endpoints");

/**
 * Proxy identity status (loopback keyless vs LAN key). This is served by the
 * nginx proxy as a public static file, so — unlike /v1 calls — it is fetched
 * WITHOUT an Authorization header and never touches the /v1 contract. Returns
 * null when the status file is unavailable (e.g. pointed straight at the
 * gateway with no proxy), so callers can show "unknown" rather than guess.
 */
export async function fetchRuntimeStatus(): Promise<RuntimeStatus | null> {
  const { baseUrl } = loadSettings();
  try {
    const response = await fetch(`${baseUrl}/ui/runtime.json`, {
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return null;
    return parseRuntimeStatus(await response.json());
  } catch {
    return null;
  }
}

export type SpeechFormat = "mp3" | "wav" | "pcm";

export interface SpeechRequestBody {
  model: string;
  input: string;
  voice: string;
  response_format: SpeechFormat;
  sample_rate: number;
  speed?: number;
}

export interface SpeechResult {
  blob: Blob;
  requestId: string;
  engine: string;
}

export async function synthesizeSpeech(body: SpeechRequestBody): Promise<SpeechResult> {
  const response = await call("/v1/audio/speech", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw await errorFrom(response);
  return {
    blob: await response.blob(),
    requestId: response.headers.get("x-request-id") ?? "",
    engine: response.headers.get("x-engine") ?? "",
  };
}

export type TranscriptionFormat = "json" | "text" | "verbose_json" | "srt" | "vtt";

export interface WordTiming {
  word: string;
  start: number;
  end: number;
}

export interface SegmentTiming {
  id: number;
  start: number;
  end: number;
  text: string;
  words?: WordTiming[];
}

export interface VerboseTranscription {
  text: string;
  language: string | null;
  duration: number | null;
  segments: SegmentTiming[];
}

export interface TranscriptionOptions {
  file: File | Blob;
  model?: string;
  language?: string;
  prompt?: string;
  response_format?: TranscriptionFormat;
  temperature?: number;
  word_timestamps?: boolean;
  timestamp_granularities?: string[];
  /** Cancel the upload/request (the workspace's "Durdur"). */
  signal?: AbortSignal;
}

export interface TranscriptionResult {
  text?: string;
  verbose?: VerboseTranscription;
  raw?: string;
  requestId: string;
}

export async function transcribeAudio(options: TranscriptionOptions): Promise<TranscriptionResult> {
  const format = options.response_format ?? "json";
  const form = new FormData();
  const name = options.file instanceof File ? options.file.name : "audio";
  form.append("file", options.file, name);
  form.append("model", options.model ?? "whisper-1");
  form.append("response_format", format);
  if (options.language) form.append("language", options.language);
  if (options.prompt) form.append("prompt", options.prompt);
  if (options.temperature !== undefined) form.append("temperature", String(options.temperature));
  if (options.word_timestamps) form.append("word_timestamps", "true");
  options.timestamp_granularities?.forEach((value) =>
    form.append("timestamp_granularities[]", value)
  );
  // No explicit Content-Type: fetch sets the multipart boundary for FormData bodies.
  const response = await call("/v1/audio/transcriptions", {
    method: "POST",
    body: form,
    signal: options.signal,
  });
  if (!response.ok) throw await errorFrom(response);
  const requestId = response.headers.get("x-request-id") ?? "";
  if (format === "verbose_json") return { verbose: (await response.json()) as VerboseTranscription, requestId };
  if (format === "json") {
    const body = (await response.json()) as { text: string };
    return { text: body.text, requestId };
  }
  return { raw: await response.text(), requestId };
}

// ---------------------------------------------------------------------------
// Sessions / Turns (F4). Contract verified against gateway.py + n8n.py.
//   POST   /v1/sessions                        -> {session_id, call_id}         (201)
//   POST   /v1/sessions/{id}/turns             -> {generation_id, turn_id, action}
//   DELETE /v1/sessions/{id}                  -> (empty)                         (204)
// TurnInput and TurnAction are `extra="forbid"` on the server; the WebUI must
// send only the fields the contract allows and must never invent new ones.
// ---------------------------------------------------------------------------

export interface SessionCreated {
  session_id: string;
  call_id: string;
}

export interface TurnInputBody {
  transcript: string;
  language?: string;
  context?: Record<string, unknown>;
}

export type TurnActionKind = "speak" | "transfer" | "hangup" | "listen" | "fallback";

export interface TurnAction {
  schema_version: "1.0";
  action: TurnActionKind;
  text?: string;
  language?: string;
  voice?: string | null;
  transfer_target?: string | null;
  metadata?: Record<string, unknown>;
  idempotency_key: string;
}

export interface TurnDelivered {
  generation_id: number;
  turn_id: string;
  action: TurnAction;
}

export async function createSession(): Promise<SessionCreated> {
  return getJson<SessionCreated>("/v1/sessions", { method: "POST" });
}

export async function deliverTurn(
  sessionId: string,
  body: TurnInputBody
): Promise<TurnDelivered> {
  const path = `/v1/sessions/${sessionId}/turns`;
  const response = await call(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      transcript: body.transcript,
      ...(body.language ? { language: body.language } : {}),
      ...(body.context ? { context: body.context } : {}),
    }),
  });
  if (!response.ok) throw await errorFrom(response);
  return (await response.json()) as TurnDelivered;
}

export async function terminateSession(sessionId: string): Promise<void> {
  const response = await call(`/v1/sessions/${sessionId}`, { method: "DELETE" });
  // 204 has no body; anything else is a real error worth surfacing.
  if (!response.ok) throw await errorFrom(response);
}

// ---------------------------------------------------------------------------
// F5 · Short-lived single-use WebSocket handshake ticket.
// The browser mints one per socket via the normal Bearer header, then dials
// wss://…/v1/tts/stream?ticket=<opaque> instead of putting the long-lived
// API key in the URL. See src/voxi/auth.py::SocketTicketStore.
// ---------------------------------------------------------------------------

export type SocketScope = "audio:write" | "audio:read" | "realtime:connect";

export interface SocketTicket {
  ticket: string;
  expires_in: number;
}

export async function mintSocketTicket(scope: SocketScope): Promise<SocketTicket> {
  return getJson<SocketTicket>("/v1/auth/socket", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scope }),
  });
}
