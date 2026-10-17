// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The session bar reports two independent states
// (docs/plan-3-server-first.md, Aşama A): live mode — the microphone and the
// turns, which work with no agent backend — and the agent session (n8n), which is
// opened lazily by the first turn that is sent. The wording is pinned here so the
// bar cannot quietly go back to implying that starting live mode opens an n8n
// session.

import { describe, expect, it } from "vitest";

import { sessionBarStatus } from "../src/studio/lib/useSession";

describe("sessionBarStatus", () => {
  it("labels live mode by the microphone, not by the agent session", () => {
    const base = { sessionOpen: false, hasTranscript: false };
    expect(sessionBarStatus({ ...base, recording: true }).live).toBe("Canlı");
    expect(sessionBarStatus({ ...base, recording: false }).live).toBe("Konuşma modu");
  });

  it("says the agent session opens on the first send until it exists", () => {
    const base = { recording: false, hasTranscript: false };
    expect(sessionBarStatus({ ...base, sessionOpen: false }).agent).toBe(
      "ajan oturumu ilk gönderimde açılır",
    );
    expect(sessionBarStatus({ ...base, sessionOpen: true }).agent).toBe("ajan oturumu açık");
  });

  it("names the agent session in the hint before live mode is on", () => {
    const base = { recording: false, sessionOpen: false };
    expect(sessionBarStatus({ ...base, hasTranscript: false }).hint).toContain("mikrofonu başlatır");
    expect(sessionBarStatus({ ...base, hasTranscript: true }).hint).toContain("bu dökümden gider");
    for (const hasTranscript of [false, true]) {
      expect(sessionBarStatus({ ...base, hasTranscript }).hint).toContain(
        "Ajan oturumu ilk gönderimde açılır",
      );
    }
  });
});
