// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

export interface Settings {
  /** Bearer key used for all /v1 calls. Stored only in this browser (localStorage). */
  apiKey: string;
  /** API base; empty means same-origin (the nginx TLS proxy routes /v1 to the gateway). */
  baseUrl: string;
}

const KEY = "voxi.apiKey";
const BASE = "voxi.baseUrl";

export function loadSettings(): Settings {
  return {
    apiKey: localStorage.getItem(KEY) ?? "",
    baseUrl: localStorage.getItem(BASE) ?? "",
  };
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(KEY, settings.apiKey.trim());
  localStorage.setItem(BASE, settings.baseUrl.trim().replace(/\/$/, ""));
}

/** True when a bearer key is already stored in this browser: Settings → Sunucu
 *  says so instead of asking again. */
export function hasStoredKey(): boolean {
  return Boolean((localStorage.getItem(KEY) ?? "").trim());
}
