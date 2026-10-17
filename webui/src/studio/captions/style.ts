// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { CueRules } from "../lib/cues";
import type { AuraPaletteId } from "../render/aura";
import type { FontId } from "./fonts";

export type PresetId =
  | "klasik"
  | "karaoke"
  | "dolgu"
  | "akis"
  | "odak"
  | "vurgu"
  | "pop"
  | "tek"
  | "netles"
  | "sade"
  | "cam";

/** Families group the style picker: calm lines, word-by-word highlights, big words. */
export type PresetFamily = "sakin" | "vurgulu" | "iri";

export const FAMILIES: { id: PresetFamily; label: string }[] = [
  { id: "sakin", label: "Sakin" },
  { id: "vurgulu", label: "Vurgulu" },
  { id: "iri", label: "İri" },
];

/** How each word reacts while it is being spoken. */
/** "reveal" leaves words out until they are spoken; the line keeps its layout. */
/** "fill" paints the accent across each word, left to right, while it is spoken. */
export type WordEffect = "none" | "karaoke" | "fill" | "reveal" | "box" | "color";

export interface CaptionSettings {
  preset: PresetId;
  font: FontId;
  /** Font size relative to the shorter side of the frame. */
  size: number;
  position: "bottom" | "middle" | "top";
  textColor: string;
  accentColor: string;
  uppercase: boolean;
  /** "glass": the video behind the caption is blurred (WebGPU). */
  background: "box" | "outline" | "shadow" | "glass";
  /** Background for audio-only projects. */
  aura: AuraPaletteId;
  /** "Sesle vurgula": words said louder than those around them are larger and in the accent colour. */
  voiceEmphasis: boolean;
  /** Settings the user changed by hand: switching preset keeps them. Missing before there was this. */
  overrides?: StyleKey[];
}

/** The settings a preset brings with it. */
export type StyleKey = keyof Preset["defaults"];

export interface Preset {
  id: PresetId;
  label: string;
  note: string;
  family: PresetFamily;
  /** How words are grouped into what is on screen at once. */
  grouping: CueRules;
  maxLines: number;
  effect: WordEffect;
  /** Scale-in when a new group appears. */
  pop: boolean;
  /** How each word comes in as it is spoken: fade and grow, or out of blur (rising, or shrinking into place). */
  wordIn?: "grow" | "focus" | "sharpen";
  defaults: Omit<CaptionSettings, "preset" | "aura" | "voiceEmphasis" | "overrides">;
}

export const PRESETS: Preset[] = [
  {
    id: "klasik",
    label: "Klasik",
    note: "İki satır altyazı, koyu kutu içinde.",
    family: "sakin",
    grouping: { gap: 0.8, maxDuration: 6.5, maxChars: 84 },
    maxLines: 2,
    effect: "none",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.05,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "box",
    },
  },
  {
    id: "karaoke",
    label: "Karaoke",
    note: "Satır görünür, söylenen kelimeler belirginleşir.",
    family: "vurgulu",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 56 },
    maxLines: 2,
    effect: "karaoke",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.055,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "outline",
    },
  },
  {
    id: "dolgu",
    label: "Dolgu",
    note: "Söylenen kelime, konuşma hızında soldan sağa renkle dolar.",
    family: "vurgulu",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 56 },
    maxLines: 2,
    effect: "fill",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.055,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "outline",
    },
  },
  {
    id: "akis",
    label: "Akış",
    note: "Kelimeler söylendikçe yerinde belirir.",
    family: "vurgulu",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 56 },
    maxLines: 2,
    effect: "reveal",
    pop: false,
    wordIn: "grow",
    defaults: {
      font: "gsflex",
      size: 0.055,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "outline",
    },
  },
  {
    id: "odak",
    label: "Odak",
    note: "Kelimeler söylendikçe bulanıktan netleşir.",
    family: "vurgulu",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 56 },
    maxLines: 2,
    effect: "reveal",
    pop: false,
    wordIn: "focus",
    defaults: {
      font: "gsflex",
      size: 0.055,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "shadow",
    },
  },
  {
    id: "vurgu",
    label: "Vurgu",
    note: "Kısa ifadeler, konuşulan kelime renkli kutuda.",
    family: "vurgulu",
    grouping: { gap: 0.5, maxDuration: 2.4, maxChars: 24 },
    maxLines: 2,
    effect: "box",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.064,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: true,
      background: "outline",
    },
  },
  {
    id: "pop",
    label: "Pop",
    note: "Bir iki iri kelime, ortada, zıplayarak gelir.",
    family: "iri",
    grouping: { gap: 0.4, maxDuration: 1.3, maxChars: 13 },
    maxLines: 2,
    effect: "color",
    pop: true,
    defaults: {
      font: "gsflex",
      size: 0.1,
      position: "middle",
      textColor: "#ffffff",
      accentColor: "#5ce1e6",
      uppercase: true,
      background: "outline",
    },
  },
  {
    id: "tek",
    label: "Tek kelime",
    note: "Ortada tek iri kelime, söylendiği anda gelir.",
    family: "iri",
    grouping: { gap: 0.6, maxDuration: 2, maxChars: 40, maxWords: 1, minDuration: 0.25 },
    maxLines: 2,
    effect: "none",
    pop: true,
    defaults: {
      font: "gsflex",
      size: 0.11,
      position: "middle",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: true,
      background: "outline",
    },
  },
  {
    id: "netles",
    label: "Netleş",
    note: "Ortada tek iri kelime, bulanıktan netleşerek yerine oturur.",
    family: "iri",
    grouping: { gap: 0.6, maxDuration: 2, maxChars: 40, maxWords: 1, minDuration: 0.25 },
    maxLines: 2,
    effect: "none",
    pop: false,
    wordIn: "sharpen",
    defaults: {
      font: "gsflex",
      size: 0.11,
      position: "middle",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: true,
      background: "shadow",
    },
  },
  {
    id: "sade",
    label: "Sade",
    note: "Kutusuz, hafif gölgeli, sakin.",
    family: "sakin",
    grouping: { gap: 0.8, maxDuration: 5, maxChars: 64 },
    maxLines: 2,
    effect: "none",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.045,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "shadow",
    },
  },
  {
    id: "cam",
    label: "Cam",
    note: "İki satır altyazı, arkasındaki video buzlu camla bulanıklaşır.",
    family: "sakin",
    grouping: { gap: 0.8, maxDuration: 6.5, maxChars: 84 },
    maxLines: 2,
    effect: "none",
    pop: false,
    defaults: {
      font: "gsflex",
      size: 0.05,
      position: "bottom",
      textColor: "#ffffff",
      accentColor: "#ffd60a",
      uppercase: false,
      background: "glass",
    },
  },
];

export const presetById = (id: PresetId) => PRESETS.find((p) => p.id === id)!;

/** Switch preset: its look, except what the user changed by hand and choices that are not part of a look. */
export const settingsFor = (id: PresetId, prev?: CaptionSettings): CaptionSettings => {
  const overrides = prev?.overrides ?? [];
  return {
    preset: id,
    aura: prev?.aura ?? "cini",
    voiceEmphasis: prev?.voiceEmphasis ?? false,
    ...presetById(id).defaults,
    ...Object.fromEntries(overrides.map((k) => [k, prev![k]])),
    overrides,
  };
};

/** Mark the preset settings in `patch` as the user's own. */
export const withOverrides = (s: CaptionSettings, patch: Partial<CaptionSettings>): CaptionSettings => {
  const touched = Object.keys(patch).filter((k): k is StyleKey => k in presetById(s.preset).defaults);
  return { ...s, ...patch, overrides: [...new Set([...(s.overrides ?? []), ...touched])] };
};

export const DEFAULT_SETTINGS = settingsFor("karaoke");

export const TEXT_COLORS = ["#ffffff", "#ffd60a", "#16222b"];
export const ACCENT_COLORS = ["#ffd60a", "#5ce1e6", "#7ed957", "#ff5a5f", "#2347c5"];
