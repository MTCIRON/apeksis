// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The settings window's sections (Aşama 9b).
//
// Aşama 8 made Settings the ONE surface for the gateway's models; Aşama 9b folded
// the full-screen "Sunucu" panel into it, so the gateway has one surface too
// (connection + status + endpoints + log). The list lives here, outside the
// component, because the visible section is remembered in localStorage and the
// status bar deep-links into it.
//
// A remembered id must never open a blank panel: `settingsSection()` falls back
// to the default when the stored value names no section any more (the same guard
// the old drawer used for its tab).

export type SettingsSectionId = "server" | "models" | "log" | "about";

/** Where the window opens: the gateway, the thing that can be broken. */
export const DEFAULT_SETTINGS_SECTION: SettingsSectionId = "server";

export const SETTINGS_SECTIONS: readonly { id: SettingsSectionId; label: string }[] = [
  { id: "server", label: "Sunucu" },
  { id: "models", label: "Modeller" },
  { id: "log", label: "Günlük" },
  { id: "about", label: "Hakkında" },
];

export function isSettingsSection(value: string): value is SettingsSectionId {
  return SETTINGS_SECTIONS.some((section) => section.id === value);
}

/** The remembered id, or the default when it names no section any more. */
export function settingsSection(value: string): SettingsSectionId {
  return isSettingsSection(value) ? value : DEFAULT_SETTINGS_SECTION;
}
