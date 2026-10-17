// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// What the single status bar says about the gateway (docs/merge-plan-2-integration.md, Aşama 8).
//
// The label is the only place the workspace states the server's health, so it has
// to be honest: "—" before the first answer, "erişilemedi" on a failure, and the
// real /healthz status and worker count otherwise. Nothing is guessed.

import { describe, expect, it } from "vitest";

import { gatewayLabel, type GatewayState } from "../src/lib/useGateway";

const base: GatewayState = { health: null, ready: null, failed: false, at: null };

describe("gatewayLabel", () => {
  it("says nothing was checked yet before the first answer", () => {
    expect(gatewayLabel(base)).toEqual({ text: "Sunucu —", tone: "neutral" });
  });

  it("says the gateway is unreachable when the call failed", () => {
    expect(gatewayLabel({ ...base, failed: true, at: 1 })).toEqual({
      text: "Sunucu erişilemedi",
      tone: "bad",
    });
  });

  it("reports a non-ok /healthz status as a warning", () => {
    expect(gatewayLabel({ ...base, health: "degraded", at: 1 })).toEqual({
      text: "Sunucu degraded",
      tone: "warn",
    });
  });

  it("counts the ready workers from /readyz", () => {
    const state: GatewayState = {
      ...base,
      health: "ok",
      ready: { workers: { "stt-whisper": true, "tts-ema": false } },
      at: 1,
    };
    expect(gatewayLabel(state)).toEqual({ text: "Sunucu çevrimiçi · 1/2 hazır", tone: "warn" });
  });

  it("is simply online when every worker is ready", () => {
    const state: GatewayState = {
      ...base,
      health: "ok",
      ready: { workers: { "stt-whisper": true, "tts-ema": true } },
      at: 1,
    };
    expect(gatewayLabel(state)).toEqual({ text: "Sunucu çevrimiçi · 2/2 hazır", tone: "ok" });
  });

  it("is simply online when /readyz carries no worker list", () => {
    const state: GatewayState = { ...base, health: "ok", ready: {}, at: 1 };
    expect(gatewayLabel(state)).toEqual({ text: "Sunucu çevrimiçi", tone: "ok" });
  });
});
