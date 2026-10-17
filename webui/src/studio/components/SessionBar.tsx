// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// The session bar — the workspace's conversation mode
// (docs/merge-plan-2-integration.md, Aşama 9; docs/plan-3-server-first.md, Aşama A).
//
// One window, no second text box. "Oturum başlat" turns on live mode and starts
// the microphone with whatever provider the toolbar has selected, so a turn is
// the transcript the workspace is already writing. Live mode is independent of
// the agent session: the server session (n8n) is opened lazily by the first turn
// that is sent, and the bar reports the two states separately. A turn goes out
// with `POST /v1/sessions/{id}/turns`; the action that comes back is shown field
// by field, and "Seslendir" speaks it over the streaming TTS socket. Every value
// on screen came from the server — the turn count, the action kind, the
// first-audio time and the duration.

import { Badge, Button, IconButton } from "./ui";
import { IconClose, IconMic, IconSound, IconStop } from "./icons";
import { sessionBarStatus, type SessionTurn } from "../lib/useSession";
import type { SpeakVoice, useServerSpeak } from "../lib/useServerSpeak";

const ROW = "flex flex-wrap items-center gap-2 px-3 py-2 text-[12px] text-fg-2";

export interface SessionBarProps {
  /** Live mode is on: the workspace is a conversation (mic and turns available). */
  live: boolean;
  /** An agent session exists on the server (opened by the first sent turn). */
  sessionOpen: boolean;
  /** The turns sent so far, oldest first. */
  turns: SessionTurn[];
  busy: boolean;
  error: string | null;
  /** What "Seçileni gönder" would send: the current transcript selection. */
  selection: string;
  /** What "Son turu gönder" would send: the newest turn in the transcript. */
  lastTurn: string;
  /** The microphone is open (the live provider writes into the transcript). */
  recording: boolean;
  /** The reply speaker. */
  speak: ReturnType<typeof useServerSpeak>;
  /** The voice an answer is spoken with. */
  voice: SpeakVoice;
  /** Turn on live mode; an empty workspace also opens the microphone. */
  onStart: () => void;
  onEnd: () => void;
  onSend: (text: string) => void;
  /** Open or close the microphone; live mode stays on either way. */
  onRecord: () => void;
  onDismissError: () => void;
}

const ACTION_TONE = { speak: "ok", listen: "ok", transfer: "warn", fallback: "warn", hangup: "bad" } as const;

export function SessionBar({
  live,
  sessionOpen,
  turns,
  busy,
  error,
  selection,
  lastTurn,
  recording,
  speak,
  voice,
  onStart,
  onEnd,
  onSend,
  onRecord,
  onDismissError,
}: SessionBarProps) {
  const last = turns[turns.length - 1];
  const action = last?.action;
  const speaking = speak.state.phase !== "idle";
  const status = sessionBarStatus({ recording, sessionOpen, hasTranscript: !!lastTurn });
  // The action's own voice wins when the server named one; the model and speed
  // still come from the voice the user picked in the toolbar.
  const speakVoice: SpeakVoice = action?.voice ? { ...voice, voice: action.voice } : voice;

  return (
    <div className="flex-none border-b border-line-soft bg-pane">
      <div className={ROW}>
        {live ? (
          <>
            <span className="flex items-center gap-1.5 font-medium text-fg">
              <span
                className="size-[7px] rounded-full bg-cini shadow-[0_0_6px_rgba(71,109,230,0.6)]"
                aria-hidden
              />
              {status.live}
            </span>
            <span className="text-fg-3 tabular-nums">{turns.length} tur</span>
            <span
              className="text-fg-3"
              title="Ajan oturumu (n8n) ilk gönderilen turda açılır; canlı döküm ondan bağımsızdır."
            >
              {status.agent}
            </span>
            <IconButton
              onClick={onRecord}
              aria-pressed={recording}
              title={recording ? "Mikrofonu kapat" : "Mikrofonu aç"}
              aria-label={recording ? "Mikrofonu kapat" : "Mikrofonu aç"}
            >
              {recording ? <IconStop /> : <IconMic />}
            </IconButton>
            <span className="min-w-2 flex-1" />
            <Button
              disabled={busy || !selection}
              title={selection ? "Dökümde seçili metni gönder" : "Önce dökümden bir metin seç"}
              onClick={() => onSend(selection)}
            >
              Seçileni gönder
            </Button>
            <Button disabled={busy || !lastTurn} onClick={() => onSend(lastTurn)}>
              Son turu gönder
            </Button>
            <Button variant="danger" disabled={busy} onClick={onEnd}>
              Bitir
            </Button>
          </>
        ) : (
          <>
            <Button variant="primary" disabled={busy} onClick={onStart}>
              Oturum başlat
            </Button>
            <span className="text-fg-3">{status.hint}</span>
          </>
        )}
      </div>

      {error && (
        <div className="flex items-center gap-2 border-t border-line-soft bg-mercan/10 px-3 py-1.5 text-[12px] text-[#ff9b86]">
          <span className="min-w-0 flex-1">{error}</span>
          <IconButton onClick={onDismissError} aria-label="Hatayı kapat">
            <IconClose />
          </IconButton>
        </div>
      )}

      {live && action && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-3 py-2 text-[12px]">
          <Badge tone={ACTION_TONE[action.action] ?? "neutral"}>{action.action}</Badge>
          {action.text && (
            <span className="min-w-0 flex-1 truncate text-fg-2" title={action.text}>
              {action.text}
            </span>
          )}
          {action.text && (
            <Button
              onClick={() => (speaking ? speak.stop() : void speak.speak(action.text!, speakVoice))}
              title={speaking ? "Sesi durdur" : "Yanıtı sunucu sesiyle oku"}
            >
              <IconSound />
              {speaking ? "Durdur" : "Seslendir"}
            </Button>
          )}
          {speak.state.phase === "speaking" && speak.state.firstAudioMs !== null && (
            <span className="text-fg-3 tabular-nums">ilk ses {speak.state.firstAudioMs} ms</span>
          )}
          {speak.state.seconds !== null && (
            <span className="text-fg-3 tabular-nums">{speak.state.seconds.toFixed(1)} s</span>
          )}
        </div>
      )}
    </div>
  );
}
