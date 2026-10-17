// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The single provider axis (docs/merge-plan-2-integration.md, Aşama 5 + 10).
//
// The default matters: the UI is served by the gateway deployment, so a first
// run must land on the server path (the browser packs are not downloaded yet),
// while a saved choice is always honoured verbatim.

import { describe, expect, it } from "vitest";

import { DEFAULT_STT_PROVIDER, providerOrDefault } from "../src/studio/worker/protocol";

describe("providerOrDefault", () => {
  it("defaults to the server", () => {
    expect(DEFAULT_STT_PROVIDER).toBe("sunucu");
    expect(providerOrDefault(null)).toBe("sunucu");
  });

  it("keeps every value the worker understands", () => {
    for (const v of ["auto", "webgpu", "wasm", "sunucu"] as const) {
      expect(providerOrDefault(v)).toBe(v);
    }
  });

  it("replaces anything else with the default", () => {
    expect(providerOrDefault("")).toBe("sunucu");
    expect(providerOrDefault("gpu")).toBe("sunucu");
    expect(providerOrDefault("SUNUCU")).toBe("sunucu");
  });
});
