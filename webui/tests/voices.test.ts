// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The single voice catalog (docs/merge-plan-2-integration.md, Aşama 6 + 10).
//
// Guards the two things that could silently produce the wrong audio: telling a
// stale dub from a current one (`sameChoice`), and reading the saved choice —
// including the old browser-only `{model,pitch,seed}` shape, which must migrate
// to the browser provider rather than being dropped. It also pins the default:
// the server, so a first run needs no download, while a saved choice is always
// honoured verbatim.

import { describe, expect, it } from "vitest";

import {
  BROWSER_CHOICE,
  BROWSER_VOICES,
  DEFAULT_CHOICE,
  browserVoice,
  loadChoice,
  sameChoice,
  serverChoice,
  serverVoiceFor,
  uniqueServerVoices,
  type VoiceChoice,
} from "../src/studio/lib/voices";
import type { ModelEntry } from "../src/api/client";

const model = (over: Partial<ModelEntry>): ModelEntry => ({
  id: "ema-lightning",
  object: "model",
  created: 0,
  owned_by: "local",
  ...over,
});

const browser = (over: Partial<VoiceChoice & { provider: "tarayici" }> = {}): VoiceChoice => ({
  provider: "tarayici",
  model: "ema",
  pitch: 0,
  seed: 0,
  ...over,
});

const server = (over: Partial<VoiceChoice & { provider: "sunucu" }> = {}): VoiceChoice => ({
  provider: "sunucu",
  model: "ema-lightning",
  voice: "ema-tr",
  speed: 1,
  ...over,
});

describe("sameChoice", () => {
  it("matches equal browser choices", () => {
    expect(sameChoice(browser(), browser())).toBe(true);
    expect(sameChoice(browser({ pitch: 3 }), browser({ pitch: 3 }))).toBe(true);
  });

  it("separates browser choices that differ in any control", () => {
    expect(sameChoice(browser(), browser({ model: "mini" }))).toBe(false);
    expect(sameChoice(browser(), browser({ pitch: -2.5 }))).toBe(false);
    expect(sameChoice(browser(), browser({ seed: 7 }))).toBe(false);
  });

  it("matches equal server choices", () => {
    expect(sameChoice(server(), server())).toBe(true);
    expect(sameChoice(server({ speed: 1.5 }), server({ speed: 1.5 }))).toBe(true);
  });

  it("separates server choices that differ in any control", () => {
    expect(sameChoice(server(), server({ model: "antalia-mini" }))).toBe(false);
    expect(sameChoice(server(), server({ voice: "antalia-tr" }))).toBe(false);
    expect(sameChoice(server(), server({ speed: 0.5 }))).toBe(false);
  });

  it("never matches across providers, even with the same model name", () => {
    // The same pack name exists on both sides (EMA), but the audio is not the same.
    expect(sameChoice(browser({ model: "ema" }), server({ model: "ema" }))).toBe(false);
    expect(sameChoice(server(), browser())).toBe(false);
  });
});

describe("loadChoice", () => {
  it("falls back to the default on a missing value", () => {
    expect(loadChoice(null)).toEqual(DEFAULT_CHOICE);
  });

  it("falls back to the default on malformed JSON", () => {
    expect(loadChoice("{not json")).toEqual(DEFAULT_CHOICE);
  });

  it("migrates the old browser-only shape", () => {
    const saved = JSON.stringify({ model: "mini", pitch: 3, seed: 42 });
    expect(loadChoice(saved)).toEqual({
      provider: "tarayici",
      model: "mini",
      pitch: 3,
      seed: 42,
    });
  });

  it("keeps a browser choice as saved", () => {
    const saved = JSON.stringify(browser({ model: "mini", pitch: -2.5, seed: 9 }));
    expect(loadChoice(saved)).toEqual(browser({ model: "mini", pitch: -2.5, seed: 9 }));
  });

  it("keeps a server choice as saved", () => {
    const saved = JSON.stringify(server({ speed: 0.8 }));
    expect(loadChoice(saved)).toEqual(server({ speed: 0.8 }));
  });

  it("repairs non-numeric or unknown fields instead of trusting them", () => {
    const saved = JSON.stringify({ model: "nope", pitch: "high", seed: null });
    expect(loadChoice(saved)).toEqual(browser({ model: "ema", pitch: 0, seed: 0 }));
  });

  it("repairs a server entry that lost its voice name", () => {
    const saved = JSON.stringify({ provider: "sunucu", model: "ema-lightning" });
    expect(loadChoice(saved)).toEqual(server({ voice: "ema-tr", speed: 1 }));
  });
});

describe("browserVoice", () => {
  it("hands the worker only the controls the browser packs have", () => {
    expect(browserVoice(browser({ model: "mini", pitch: 1.5, seed: 3 }))).toEqual({
      model: "mini",
      pitch: 1.5,
      seed: 3,
    });
  });

  it("refuses a server choice", () => {
    expect(() => browserVoice(server())).toThrow();
  });
});

describe("serverVoiceFor", () => {
  it("prefers the voice the model itself declares", () => {
    const entry = model({ capabilities: { tts: true, voices: ["ema-tr"] } });
    expect(serverVoiceFor(entry)).toEqual({
      model: "ema-lightning",
      voice: "ema-tr",
      name: "EMA Lightning",
    });
  });

  it("falls back to the known map when the model declares nothing", () => {
    const entry = model({ id: "antalia-mini", capabilities: { tts: true } });
    expect(serverVoiceFor(entry)).toEqual({
      model: "antalia-mini",
      voice: "antalia-tr",
      name: "Antalia Mini",
    });
  });

  it("leaves an unknown model out rather than guessing a voice", () => {
    expect(serverVoiceFor(model({ id: "mystery-tts", capabilities: { tts: true } }))).toBeNull();
  });

  it("ignores a declaration that is not a usable string", () => {
    expect(serverVoiceFor(model({ id: "mystery-tts", capabilities: { voices: [42] } }))).toBeNull();
  });

  it("names an unknown model by its own id", () => {
    const entry = model({ id: "mystery-tts", capabilities: { voices: ["x-tr"] } });
    expect(serverVoiceFor(entry)).toEqual({ model: "mystery-tts", voice: "x-tr", name: "mystery-tts" });
  });
});

describe("uniqueServerVoices", () => {
  it("shows one row per physical voice, never the OpenAI alias", () => {
    const models = [
      model({ id: "tts-1", capabilities: { tts: true, voices: ["ema-tr"] } }),
      model({ id: "ema-lightning", capabilities: { tts: true, voices: ["ema-tr"] } }),
    ];
    expect(uniqueServerVoices(models)).toEqual([
      { model: "ema-lightning", voice: "ema-tr", name: "EMA Lightning" },
    ]);
  });

  it("keeps the real id whatever order the gateway lists them in", () => {
    const models = [
      model({ id: "ema-lightning", capabilities: { tts: true, voices: ["ema-tr"] } }),
      model({ id: "tts-1", capabilities: { tts: true, voices: ["ema-tr"] } }),
    ];
    expect(uniqueServerVoices(models).map((v) => v.model)).toEqual(["ema-lightning"]);
  });

  it("keeps distinct voices apart", () => {
    const models = [
      model({ id: "tts-1", capabilities: { tts: true, voices: ["ema-tr"] } }),
      model({ id: "ema-lightning", capabilities: { tts: true, voices: ["ema-tr"] } }),
      model({ id: "antalia-mini", capabilities: { tts: true, voices: ["antalia-tr"] } }),
    ];
    expect(uniqueServerVoices(models)).toEqual([
      { model: "ema-lightning", voice: "ema-tr", name: "EMA Lightning" },
      { model: "antalia-mini", voice: "antalia-tr", name: "Antalia Mini" },
    ]);
  });

  it("still offers the alias when it is the only id advertised", () => {
    const models = [model({ id: "tts-1", capabilities: { tts: true, voices: ["ema-tr"] } })];
    expect(uniqueServerVoices(models)).toEqual([
      { model: "tts-1", voice: "ema-tr", name: "EMA Lightning" },
    ]);
  });

  it("ignores speech-to-text models", () => {
    const models = [
      model({ id: "whisper-1", capabilities: { stt: true } }),
      model({ id: "ema-lightning", capabilities: { tts: true, voices: ["ema-tr"] } }),
    ];
    expect(uniqueServerVoices(models).map((v) => v.model)).toEqual(["ema-lightning"]);
  });

  it("leaves a model with no known voice out rather than guessing", () => {
    const models = [
      model({ id: "mystery-tts", capabilities: { tts: true } }),
      model({ id: "ema-lightning", capabilities: { tts: true, voices: ["ema-tr"] } }),
    ];
    expect(uniqueServerVoices(models).map((v) => v.model)).toEqual(["ema-lightning"]);
  });
});

describe("the catalog itself", () => {
  it("lists exactly the browser packs the worker can load", () => {
    expect(BROWSER_VOICES.map((v) => v.model).sort()).toEqual(["ema", "mini"]);
  });

  it("builds a server choice from a server voice", () => {
    expect(serverChoice({ model: "antalia-mini", voice: "antalia-tr", name: "Antalia Mini" })).toEqual({
      provider: "sunucu",
      model: "antalia-mini",
      voice: "antalia-tr",
      speed: 1,
    });
  });
});

describe("the default choice", () => {
  it("is the server, so a first run needs no download", () => {
    expect(DEFAULT_CHOICE).toEqual({
      provider: "sunucu",
      model: "ema-lightning",
      voice: "ema-tr",
      speed: 1,
    });
  });

  it("keeps the browser default separate for the Tarayıcı button", () => {
    expect(BROWSER_CHOICE).toEqual({ provider: "tarayici", model: "ema", pitch: 0, seed: 0 });
    expect(sameChoice(BROWSER_CHOICE, DEFAULT_CHOICE)).toBe(false);
  });

  it("never overrides a choice the user already saved", () => {
    expect(loadChoice(JSON.stringify(BROWSER_CHOICE))).toEqual(BROWSER_CHOICE);
    expect(loadChoice(JSON.stringify(server({ speed: 1.4 })))).toEqual(server({ speed: 1.4 }));
  });
});
