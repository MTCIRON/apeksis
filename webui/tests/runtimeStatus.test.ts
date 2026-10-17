// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Proxy identity status parser/labeler (vitest, node environment).
//
// Guards condition 9: the Settings badge must describe the runtime honestly and
// must never misreport a malformed body as "loopback keyless" (which would tell
// a LAN user no key is needed and leave them staring at a 401).

import { describe, expect, it } from "vitest";

import { describeRuntimeStatus, parseRuntimeStatus } from "../src/lib/runtimeStatus";

describe("parseRuntimeStatus", () => {
  it("accepts the loopback keyless shape", () => {
    const s = parseRuntimeStatus({ mode: "loopback", needKey: false, autoIdentity: true });
    expect(s).toEqual({ mode: "loopback", needKey: false, autoIdentity: true });
  });

  it("accepts the LAN key-required shape", () => {
    const s = parseRuntimeStatus({ mode: "lan", needKey: true, autoIdentity: false });
    expect(s.mode).toBe("lan");
    expect(s.needKey).toBe(true);
  });

  it("coerces missing booleans to false rather than undefined", () => {
    const s = parseRuntimeStatus({ mode: "lan" });
    expect(s.needKey).toBe(false);
    expect(s.autoIdentity).toBe(false);
  });

  it("rejects an unknown mode", () => {
    expect(() => parseRuntimeStatus({ mode: "public" })).toThrow();
  });

  it("rejects non-object bodies", () => {
    expect(() => parseRuntimeStatus(null)).toThrow();
    expect(() => parseRuntimeStatus("loopback")).toThrow();
  });
});

describe("describeRuntimeStatus", () => {
  it("reassures the local keyless install", () => {
    const d = describeRuntimeStatus({ mode: "loopback", needKey: false, autoIdentity: true });
    expect(d.tone).toBe("ok");
    expect(d.text).toContain("otomatik kimlik");
  });

  it("tells a LAN install it needs a key", () => {
    const d = describeRuntimeStatus({ mode: "lan", needKey: true, autoIdentity: false });
    expect(d.tone).toBe("warn");
    expect(d.text).toContain("anahtar");
  });
});
