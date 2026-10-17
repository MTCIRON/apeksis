// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Operator-facing identity status, served by the nginx proxy at
// /ui/runtime.json (see integrations/nginx/voxi-entrypoint.sh). It is a tiny
// static file with NO secret and is NOT part of the /v1 API contract — it only
// lets the Settings screen explain whether this install auto-identifies local
// requests or requires a key, so a user who moves to LAN mode is not left
// staring at an unexplained 401.

export type RuntimeMode = "loopback" | "lan" | "lan-inject";

export interface RuntimeStatus {
  mode: RuntimeMode;
  /** True when the client must supply its own API key (LAN mode). */
  needKey: boolean;
  /** True when the proxy injects a local identity for same-origin calls. */
  autoIdentity: boolean;
}

/** Validate an untrusted runtime.json body. Throws on anything unexpected so
 *  the caller can fall back to "status unknown" instead of guessing. */
export function parseRuntimeStatus(raw: unknown): RuntimeStatus {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("runtime status: not an object");
  }
  const o = raw as Record<string, unknown>;
  if (o.mode !== "loopback" && o.mode !== "lan" && o.mode !== "lan-inject") {
    throw new Error(`runtime status: unknown mode ${String(o.mode)}`);
  }
  return {
    mode: o.mode,
    needKey: Boolean(o.needKey),
    autoIdentity: Boolean(o.autoIdentity),
  };
}

/** Human label + helper copy for the Settings badge (Turkish UI). */
export function describeRuntimeStatus(status: RuntimeStatus): { tone: "ok" | "warn"; text: string } {
  if (status.mode === "loopback" && status.autoIdentity) {
    return { tone: "ok", text: "Bu kurulum yerel otomatik kimlik kullanıyor — anahtar girmenize gerek yok." };
  }
  if (status.mode === "lan-inject" && status.autoIdentity) {
    return {
      tone: "ok",
      text: "Bu kurulum güvenilir LAN'da otomatik kimlik kullanıyor — anahtar girmenize gerek yok.",
    };
  }
  return { tone: "warn", text: "Bu kurulum anahtar istiyor — aşağıdaki API anahtarınızı girin." };
}
