// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  SETTINGS_SECTIONS,
  settingsSection,
} from "../src/studio/lib/settingsSections";

// Aşama 9b: the settings sections, and the guard that keeps a stale remembered
// id from opening a blank window.

describe("settings sections", () => {
  it("lists the four sections, the gateway first", () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual(["server", "models", "log", "about"]);
    expect(DEFAULT_SETTINGS_SECTION).toBe("server");
  });

  it("accepts every id it lists", () => {
    for (const section of SETTINGS_SECTIONS) expect(isSettingsSection(section.id)).toBe(true);
  });

  it("rejects an id no section has", () => {
    expect(isSettingsSection("canli")).toBe(false);
    expect(isSettingsSection("drawer")).toBe(false);
    expect(isSettingsSection("")).toBe(false);
    expect(isSettingsSection("Server")).toBe(false);
    expect(isSettingsSection(" server")).toBe(false);
  });

  it("falls back to the gateway when the remembered id is stale", () => {
    expect(settingsSection("canli")).toBe("server");
    expect(settingsSection("drawer")).toBe("server");
    expect(settingsSection("")).toBe("server");
  });

  it("keeps a remembered id that still exists", () => {
    for (const section of SETTINGS_SECTIONS) expect(settingsSection(section.id)).toBe(section.id);
  });

  it("has no duplicate id or label", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    const labels = SETTINGS_SECTIONS.map((s) => s.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(label.trim()).toBe(label);
  });
});
