// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The project file (.apeksis) and the file written under an earlier name.
//
// This guards both directions: what we write is the current format, and what we
// read still accepts the older `.voxi` export, so a project saved by that line of
// the product does not become unreadable.

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/studio/captions/style";
import {
  LEGACY_PROJECT_EXTS,
  PROJECT_EXT,
  isProjectFile,
  projectFromFile,
  projectToFile,
  type Project,
} from "../src/studio/lib/projectStore";

const project = (): Project => ({
  id: "p1",
  name: "Deneme",
  createdAt: 1,
  updatedAt: 2,
  live: false,
  method: "beam-lm",
  duration: 1,
  elapsed: 2,
  words: [{ text: "merhaba", start: 0, end: 0.5 }],
  peaks: new Float32Array([0.5, 0.25]),
  bands: new Float32Array(0),
  settings: DEFAULT_SETTINGS,
  media: null,
  storage: "none",
});

const file = () => JSON.parse(projectToFile(project()));

describe("project file format", () => {
  it("writes the current extension and format", () => {
    expect(PROJECT_EXT).toBe(".apeksis");
    const written = file();
    expect(written.format).toBe("apeksis-project");
    expect(written.version).toBe(1);
    expect(written.words).toEqual([{ text: "merhaba", start: 0, end: 0.5 }]);
  });

  it("reads a file written under an earlier format", () => {
    const read = projectFromFile(
      JSON.stringify({ ...file(), format: "voxi-project" }),
      DEFAULT_SETTINGS,
    );
    expect(read.name).toBe("Deneme");
    expect(read.words).toEqual([{ text: "merhaba", start: 0, end: 0.5 }]);
  });

  it("rejects anything that is not a project file", () => {
    expect(() => projectFromFile(JSON.stringify({ format: "other" }), DEFAULT_SETTINGS)).toThrow(
      /Apeksis proje dosyası/,
    );
    expect(() => projectFromFile("not json", DEFAULT_SETTINGS)).toThrow(/okunamadı/);
  });

  it("accepts the current extension and the earlier one", () => {
    expect(LEGACY_PROJECT_EXTS).toEqual([".voxi"]);
    expect(isProjectFile("film.apeksis")).toBe(true);
    expect(isProjectFile("film.APEKSIS")).toBe(true);
    for (const ext of LEGACY_PROJECT_EXTS) expect(isProjectFile(`film${ext}`)).toBe(true);
    expect(isProjectFile("film.mp4")).toBe(false);
    expect(isProjectFile("film")).toBe(false);
  });
});
