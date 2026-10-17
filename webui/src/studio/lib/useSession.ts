// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The gateway conversation: one session, the turns sent to it and the action
// each turn is answered with (docs/merge-plan-2-integration.md, Aşama 9).
//
// The panel this replaces (`sessions.tsx`) carried its own text box and its own
// list. A session is a mode of the workspace instead: the turn text is the
// transcript the workspace already holds, and the answer comes back into the
// same window. Nothing is stored locally — the session lives on the server, and
// the log already records every request (`api/client.ts`).
//
// The agent session is opened lazily by `send`, not by live mode: the microphone
// and the live transcript work with no agent backend configured, so a missing
// n8n surfaces only when a turn is actually sent.

import { useCallback, useState } from "react";
import {
  createSession,
  deliverTurn,
  terminateSession,
  type SessionCreated,
  type TurnAction,
  type TurnInputBody,
} from "../../api/client";

export interface SessionTurn {
  turnId: string;
  generationId: number;
  /** The text that was sent. */
  text: string;
  /** What the server answered, shown exactly as it came. */
  action: TurnAction;
}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useSession() {
  const [session, setSession] = useState<SessionCreated | null>(null);
  const [turns, setTurns] = useState<SessionTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const s = await createSession();
      setSession(s);
      setTurns([]);
      return s;
    } catch (e) {
      setError(reason(e));
      return null;
    } finally {
      setBusy(false);
    }
  }, []);

  const end = useCallback(async () => {
    const s = session;
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      await terminateSession(s.session_id);
    } catch (e) {
      setError(reason(e));
    } finally {
      setSession(null);
      setBusy(false);
    }
  }, [session]);

  const send = useCallback(
    async (text: string, body: Omit<TurnInputBody, "transcript"> = {}) => {
      const transcript = text.trim();
      if (!transcript) return null;
      setBusy(true);
      setError(null);
      try {
        // The agent session is opened lazily, on the first turn that is actually
        // sent. Live transcription never depends on it, so an unconfigured agent
        // backend (n8n) is reported here and nowhere else.
        let s = session;
        if (!s) {
          s = await createSession();
          setSession(s);
          setTurns([]);
        }
        const r = await deliverTurn(s.session_id, { transcript, ...body });
        const row: SessionTurn = {
          turnId: r.turn_id,
          generationId: r.generation_id,
          text: transcript,
          action: r.action,
        };
        setTurns((x) => [...x, row]);
        return row;
      } catch (e) {
        setError(reason(e));
        return null;
      } finally {
        setBusy(false);
      }
    },
    [session],
  );

  return {
    session,
    turns,
    busy,
    error,
    start,
    end,
    send,
    dismissError: useCallback(() => setError(null), []),
  };
}

export interface SessionBarStatus {
  /** The live-mode label: the microphone state, never the agent session. */
  live: string;
  /** What the bar says about the agent session (n8n), which is opened lazily. */
  agent: string;
  /** The hint shown before live mode is on; it names both independent states. */
  hint: string;
}

/**
 * The session bar reports two independent things: live mode (microphone and
 * turns, which work with no agent backend) and the agent session (n8n), which is
 * opened lazily by the first turn that is sent — never by starting live mode.
 * Pure so the wording can be pinned by a test (`tests/sessionBar.test.ts`).
 */
export function sessionBarStatus(opts: {
  recording: boolean;
  sessionOpen: boolean;
  hasTranscript: boolean;
}): SessionBarStatus {
  return {
    live: opts.recording ? "Canlı" : "Konuşma modu",
    agent: opts.sessionOpen ? "ajan oturumu açık" : "ajan oturumu ilk gönderimde açılır",
    hint: opts.hasTranscript
      ? "Canlı modu açar; turlar bu dökümden gider, yanıtı burada okunur. Ajan oturumu ilk gönderimde açılır."
      : "Canlı modu açar ve mikrofonu başlatır; konuştukların döküme yazılır. Ajan oturumu ilk gönderimde açılır.",
  };
}
