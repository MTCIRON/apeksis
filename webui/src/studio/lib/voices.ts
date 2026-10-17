// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The single voice catalog — one list for every place a voice can come from
// (docs/merge-plan-2-integration.md, Aşama 6).
//
// The original studio app synthesized in the browser (EMA Lightning / Antalia Mini ONNX packs);
// Voxi synthesized on the server (`POST /v1/audio/speech`). They are the same
// capability with two execution paths, so this module gives both one shape: a
// `VoiceChoice` that carries ONLY the controls its provider really has. Nothing
// is faked — the browser exposes pitch/seed, the server exposes speed, and the
// UI renders what the chosen provider can actually do.

import { useEffect, useMemo, useState } from "react";
import { fetchModels, type ModelEntry } from "../../api/client";
import { VOICE_PACKS } from "../../lib/models";
import type { Voice, VoiceModel } from "../worker/tts.worker";

export type { Voice, VoiceModel };

/** Where the voice is synthesized. */
export type VoiceProvider = "tarayici" | "sunucu";

/** The user's choice: exactly the controls the chosen provider really has. */
export type VoiceChoice =
  | { provider: "tarayici"; model: VoiceModel; pitch: number; seed: number }
  | { provider: "sunucu"; model: string; voice: string; speed: number };

/** EMA Lightning in the browser, neutral pitch, seed 0. What the "Tarayıcı"
 *  button selects, and what an old browser-only saved choice migrates to. */
export const BROWSER_CHOICE: VoiceChoice = { provider: "tarayici", model: "ema", pitch: 0, seed: 0 };

/** The gateway's documented default voice; also the last-resort fallback below. */
export const DEFAULT_SERVER_VOICE = { model: "ema-lightning", voice: "ema-tr" } as const;

/**
 * The default choice: the Apeksis **server**. The UI is served by the gateway
 * deployment (nginx serves /ui and proxies /v1 on the same origin), so the
 * server path works on the very first run — while the browser packs still need a
 * download. "Tarayıcı" is one click away and the choice is remembered
 * (`apeksis.voice`).
 */
export const DEFAULT_CHOICE: VoiceChoice = {
  provider: "sunucu",
  model: DEFAULT_SERVER_VOICE.model,
  voice: DEFAULT_SERVER_VOICE.voice,
  speed: 1,
};

/** The worker's `Voice` for a browser choice. */
export function browserVoice(choice: VoiceChoice): Voice {
  if (choice.provider !== "tarayici") throw new Error("Tarayıcı sesi bekleniyordu.");
  return { model: choice.model, pitch: choice.pitch, seed: choice.seed };
}

/** True when both choices would synthesize the same audio. */
export function sameChoice(a: VoiceChoice, b: VoiceChoice): boolean {
  if (a.provider !== b.provider) return false;
  if (a.provider === "tarayici" && b.provider === "tarayici") {
    return a.model === b.model && a.pitch === b.pitch && a.seed === b.seed;
  }
  if (a.provider === "sunucu" && b.provider === "sunucu") {
    return a.model === b.model && a.voice === b.voice && a.speed === b.speed;
  }
  return false;
}

/** The browser packs, from the one model catalog (`lib/models.ts`). */
export const BROWSER_VOICES = (Object.keys(VOICE_PACKS) as VoiceModel[]).map((model) => ({
  model,
  name: VOICE_PACKS[model].name,
  note: VOICE_PACKS[model].note,
}));

/** Physical voice name for each server model the gateway serves. */
export const knownVoices: Record<string, string> = {
  "ema-lightning": "ema-tr",
  "antalia-mini": "antalia-tr",
  "tts-1": "ema-tr",
};

const SERVER_NAMES: Record<string, string> = {
  "ema-lightning": "EMA Lightning",
  "antalia-mini": "Antalia Mini",
  "tts-1": "EMA Lightning",
};

/**
 * OpenAI-compatible ids the gateway advertises next to the real model id. They
 * drive the very same physical voice (`tts-1` and `ema-lightning` both speak
 * `ema-tr`), so the real id is shown instead of a duplicate row.
 */
const MODEL_ALIASES = new Set(["tts-1"]);

// One fetch of installed models, split into TTS/STT by the (truthful) capability flags.
// (Moved here from the removed Voxi `audio.tsx`, so voices and the live panels
// read the same source.)
export function useInstalledModels() {
  const [models, setModels] = useState<ModelEntry[]>([]);
  useEffect(() => {
    let alive = true;
    fetchModels()
      .then((list) => alive && setModels(list.data))
      .catch(() => alive && setModels([]));
    return () => {
      alive = false;
    };
  }, []);
  const tts = useMemo(
    () => models.filter((m) => m.capabilities?.stt !== true).map((m) => m.id),
    [models],
  );
  const stt = useMemo(
    () => models.filter((m) => m.capabilities?.stt === true).map((m) => m.id),
    [models],
  );
  return {
    models,
    tts: tts.length ? tts : ["ema-lightning"],
    stt: stt.length ? stt : ["whisper-1"],
  };
}

export interface ServerVoice {
  model: string;
  /** The physical voice the gateway accepts for this model. */
  voice: string;
  name: string;
}

/** The gateway's documented default, used only when `/v1/models` tells us nothing. */
const FALLBACK_SERVER_VOICE: ServerVoice = {
  model: DEFAULT_SERVER_VOICE.model,
  voice: DEFAULT_SERVER_VOICE.voice,
  name: "EMA Lightning",
};

/**
 * The voice for one server model: what the model itself declares in its
 * capabilities (`voices`), else the known map. `null` when neither knows, so a
 * model is left out rather than guessed — the gateway rejects a wrong voice 400.
 */
export function serverVoiceFor(model: ModelEntry): ServerVoice | null {
  const declared = model.capabilities?.voices;
  const first = Array.isArray(declared) ? declared.find((v) => typeof v === "string" && v) : undefined;
  const voice = (typeof first === "string" ? first : null) ?? knownVoices[model.id];
  if (!voice) return null;
  return { model: model.id, voice, name: SERVER_NAMES[model.id] ?? model.id };
}

/**
 * The server voices to offer: one entry per physical voice. `/v1/models` may
 * list an OpenAI alias next to the real model id (`tts-1` + `ema-lightning`);
 * the real id wins, so the menu never shows the same voice twice. Pure, so the
 * rule is unit-tested (`tests/voices.test.ts`).
 */
export function uniqueServerVoices(models: ModelEntry[]): ServerVoice[] {
  const byVoice = new Map<string, ServerVoice>();
  for (const model of models) {
    if (model.capabilities?.stt === true) continue;
    const voice = serverVoiceFor(model);
    if (!voice) continue;
    const kept = byVoice.get(voice.voice);
    if (!kept || (MODEL_ALIASES.has(kept.model) && !MODEL_ALIASES.has(voice.model))) {
      byVoice.set(voice.voice, voice);
    }
  }
  return [...byVoice.values()];
}

/**
 * Server voices we can actually drive, from the one model list. Never empty: with
 * no model list (offline, not signed in) the gateway's own default is offered.
 */
export function useServerVoices(): ServerVoice[] {
  const { models } = useInstalledModels();
  return useMemo(() => {
    const found = uniqueServerVoices(models);
    return found.length ? found : [FALLBACK_SERVER_VOICE];
  }, [models]);
}

/** The server choice for a voice entry. */
export const serverChoice = (voice: ServerVoice, speed = 1): VoiceChoice => ({
  provider: "sunucu",
  model: voice.model,
  voice: voice.voice,
  speed,
});

/** Read the saved choice, migrating the old browser-only `{model,pitch,seed}` shape. */
export function loadChoice(raw: string | null): VoiceChoice {
  // Nothing stored (first run): the default — the server, not a browser pack the
  // user would have to download before the first dub.
  if (!raw) return DEFAULT_CHOICE;
  let saved: Record<string, unknown>;
  try {
    saved = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return DEFAULT_CHOICE;
  }
  const num = (v: unknown, fallback: number) => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  if (saved.provider === "sunucu" && str(saved.model)) {
    return {
      provider: "sunucu",
      model: str(saved.model)!,
      voice: str(saved.voice) ?? "ema-tr",
      speed: num(saved.speed, 1),
    };
  }
  return {
    provider: "tarayici",
    model: saved.model === "mini" ? "mini" : "ema",
    pitch: num(saved.pitch, 0),
    seed: num(saved.seed, 0),
  };
}
