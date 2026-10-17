// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The gateway's own health, for the ONE status bar (Aşama 8) and for
// Settings → Sunucu (Aşama 9b).
//
// It polls /healthz and /readyz SILENTLY: the log is for the calls the user
// makes, not for this poll, so the single log stays readable. The status bar and
// the settings section read the SAME state, so the app asks once and the two can
// never disagree.

import { useCallback, useEffect, useState } from "react";
import { fetchHealth, fetchReadiness, type ReadinessResponse } from "../api/client";

export interface GatewayState {
  /** /healthz status, or null when the last call failed. */
  health: string | null;
  /** /readyz body: the workers and whether they are ready. */
  ready: ReadinessResponse | null;
  /** The last call failed: the gateway is unreachable. */
  failed: boolean;
  /** When the last answer (or failure) arrived, ms. null = never checked. */
  at: number | null;
}

export interface GatewayHealth extends GatewayState {
  /** Check again right now; the silent poll keeps running on its own. */
  refresh: () => void;
}

const POLL_MS = 30_000;
const EMPTY: GatewayState = { health: null, ready: null, failed: false, at: null };

export function useGateway(): GatewayHealth {
  const [state, setState] = useState<GatewayState>(EMPTY);
  /** Bumped by `refresh`: the effect re-runs, so the check is immediate. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const [health, ready] = await Promise.all([fetchHealth(true), fetchReadiness(true)]);
        if (alive) setState({ health: health.status, ready, failed: false, at: Date.now() });
      } catch {
        if (alive) setState({ health: null, ready: null, failed: true, at: Date.now() });
      }
    };
    void check();
    const timer = setInterval(() => void check(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [round]);

  const refresh = useCallback(() => setRound((n) => n + 1), []);

  return { ...state, refresh };
}

export interface GatewayLabel {
  text: string;
  tone: "ok" | "warn" | "bad" | "neutral";
}

/** What the status bar says: short, and honest about not knowing yet. */
export function gatewayLabel(gateway: GatewayState): GatewayLabel {
  if (gateway.at === null) return { text: "Sunucu —", tone: "neutral" };
  if (gateway.failed) return { text: "Sunucu erişilemedi", tone: "bad" };
  if (gateway.health !== "ok") return { text: `Sunucu ${gateway.health ?? "?"}`, tone: "warn" };

  const workers = Object.values(gateway.ready?.workers ?? {});
  const ready = workers.filter(Boolean).length;
  if (!workers.length) return { text: "Sunucu çevrimiçi", tone: "ok" };
  return {
    text: `Sunucu çevrimiçi · ${ready}/${workers.length} hazır`,
    tone: ready < workers.length ? "warn" : "ok",
  };
}
