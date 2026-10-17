// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { type DubState, type PreviewState } from "../lib/useDubber";
import {
  BROWSER_CHOICE,
  BROWSER_VOICES,
  serverChoice,
  useServerVoices,
  type VoiceChoice,
  type VoiceModel,
} from "../lib/voices";
import { STUDIO } from "./CaptionStudio";
import { Meter } from "./Indicators";
import {
  Button,
  Hint,
  Range,
  Row,
  RowGroup,
  RowLabel,
  RowValue,
  Section,
  SectionActions,
  Switch,
} from "./ui";

const MODELS: Record<
  VoiceModel,
  { name: string; size: string; link: string; note: string }
> = {
  ema: {
    name: "EMA Lightning",
    size: "36 MB",
    link: "https://huggingface.co/canberkkkkkk/ema-lightning",
    note: "Türkçe metin okuma modeli (Apache-2.0).",
  },
  mini: {
    name: "Antalia Mini",
    size: "23 MB",
    link: "https://huggingface.co/cloud0day3/antalia-mini",
    note: "Patientdesk.ai'nin Türkçe metin okuma modeli Antalia-2 Mini (Apache-2.0); tek ses, ekran kartı olmadan da hızlı.",
  },
};

const PITCHES = [
  { pitch: -2.5, label: "Kalın" },
  { pitch: 0, label: "Normal" },
  { pitch: 3, label: "İnce" },
];

const PRESET =
  "h-[26px] flex-1 rounded-ui border border-line bg-raised text-[12px] text-fg-2 hover:not-disabled:text-fg aria-pressed:border-cini aria-pressed:text-white disabled:opacity-45";

function previewLabel(p: PreviewState) {
  if (p.status === "download")
    return `Model %${Math.floor((p.loaded / (p.total || 1)) * 100)}`;
  if (p.status === "running") return "Hazırlanıyor";
  if (p.status === "playing") return "Durdur";
  return "Dinle";
}

/**
 * The inspector's dubbing tab: read the transcript aloud. The provider decides
 * where the speech is made (this computer or the Apeksis server); everything else —
 * the caption lines, the timings, the playback, the WAV download — is the same.
 */
export function DubPanel({
  state,
  stale,
  canDub,
  busy,
  onDub,
  onCancel,
  on,
  onOn,
  fileName,
  voice,
  onVoice,
  preview,
  onListen,
}: {
  state: DubState;
  /** The transcript changed after the dub was made. */
  stale: boolean;
  canDub: boolean;
  /** A video export is running. */
  busy: boolean;
  onDub: () => void;
  onCancel: () => void;
  on: boolean;
  onOn: (on: boolean) => void;
  fileName: string;
  voice: VoiceChoice;
  onVoice: (v: VoiceChoice) => void;
  preview: PreviewState;
  onListen: () => void;
}) {
  const working = state.status === "download" || state.status === "running";
  const serverVoices = useServerVoices();
  const browser = voice.provider === "tarayici" ? voice : null;
  const server = voice.provider === "sunucu" ? voice : null;
  const meta = browser ? MODELS[browser.model] : null;
  const serverName = server
    ? (serverVoices.find((v) => v.model === server.model)?.name ?? server.model)
    : null;

  return (
    <div className={STUDIO}>
      <Section title="Yapay sesle seslendirme">
        <RowGroup role="radiogroup" aria-label="Seslendirme nerede çalışsın">
          <RowLabel>Sağlayıcı</RowLabel>
          <button
            type="button"
            className={PRESET}
            role="radio"
            aria-checked={voice.provider === "tarayici"}
            aria-pressed={voice.provider === "tarayici"}
            disabled={working}
            onClick={() => onVoice(BROWSER_CHOICE)}
          >
            Tarayıcı
          </button>
          <button
            type="button"
            className={PRESET}
            role="radio"
            aria-checked={voice.provider === "sunucu"}
            aria-pressed={voice.provider === "sunucu"}
            disabled={working || serverVoices.length === 0}
            onClick={() => serverVoices[0] && onVoice(serverChoice(serverVoices[0]))}
          >
            Sunucu (Apeksis)
          </button>
        </RowGroup>
        <Hint>
          {browser
            ? `Transkript yapay bir sesle yeniden okunur. Her altyazı satırı kendi zamanında başlar; yerine sığmayan satırlar biraz hızlı okunur. Ses bu bilgisayarda üretilir ve ilk kullanımda yaklaşık ${meta!.size} indirir.`
            : "Transkript yapay bir sesle yeniden okunur. Her altyazı satırı kendi zamanında başlar. Ses Apeksis sunucusunda üretilir: satır başına bir istek gider ve dalga biçimi indirilmez."}
        </Hint>
        {state.status === "download" && (
          <div className="flex items-center gap-2.5 text-[12px] text-fg-2">
            <span className="flex-1">
              Model indiriliyor %
              {Math.floor((state.loaded / (state.total || 1)) * 100)}
            </span>
            <Meter value={state.loaded / (state.total || 1)} />
          </div>
        )}
        {state.status === "running" && (
          <div className="flex items-center gap-2.5 text-[12px] text-fg-2">
            <span className="flex-1">
              {state.total
                ? `Seslendiriliyor ${state.done} / ${state.total}`
                : "Model hazırlanıyor"}
            </span>
            <Meter value={state.total ? state.done / state.total : 0} />
          </div>
        )}
        {state.status === "error" && (
          <Hint>Seslendirilemedi: {state.message}</Hint>
        )}
        {state.status === "done" && stale && (
          <Hint>
            Transkript ya da ses ayarları seslendirmeden sonra değişti.
          </Hint>
        )}
        <SectionActions>
          {working ? (
            <Button onClick={onCancel}>Durdur</Button>
          ) : (
            <Button
              variant={
                state.status === "done" && !stale ? "default" : "primary"
              }
              disabled={!canDub || busy}
              onClick={onDub}
            >
              {state.status === "done" ? "Yeniden seslendir" : "Seslendir"}
            </Button>
          )}
          {state.status === "done" && (
            <a
              className="inline-flex h-7.25 items-center rounded-ui border border-line bg-raised px-3 text-[12.5px] font-medium text-fg no-underline hover:border-[#3f4752] hover:bg-raised-hover hover:text-white"
              href={state.url}
              download={fileName}
            >
              WAV indir
            </a>
          )}
        </SectionActions>
        {!canDub && state.status === "idle" && (
          <Hint>Önce bir dosyayı yazıya dök.</Hint>
        )}
      </Section>

      <Section title="Ses">
        {browser && (
          <>
            <RowGroup role="radiogroup" aria-label="Ses modeli">
              <RowLabel>Model</RowLabel>
              {BROWSER_VOICES.map((v) => (
                <button
                  key={v.model}
                  type="button"
                  className={PRESET}
                  role="radio"
                  aria-checked={browser.model === v.model}
                  aria-pressed={browser.model === v.model}
                  disabled={working}
                  onClick={() => onVoice({ ...browser, model: v.model })}
                >
                  {MODELS[v.model].name}
                </button>
              ))}
            </RowGroup>
            <RowGroup role="group" aria-label="Hazır ses tonları">
              <RowLabel>Ton</RowLabel>
              {PITCHES.map((p) => (
                <button
                  key={p.pitch}
                  type="button"
                  className={PRESET}
                  aria-pressed={browser.pitch === p.pitch}
                  disabled={working}
                  onClick={() => onVoice({ ...browser, pitch: p.pitch })}
                >
                  {p.label}
                </button>
              ))}
            </RowGroup>
            <Row>
              <RowLabel>Yarım ton</RowLabel>
              <Range
                min={-4}
                max={4}
                step={0.5}
                value={browser.pitch}
                disabled={working}
                onChange={(e) => onVoice({ ...browser, pitch: Number(e.target.value) })}
                onDoubleClick={() => onVoice({ ...browser, pitch: 0 })}
              />
              <RowValue>
                {browser.pitch > 0 ? `+${browser.pitch}` : browser.pitch}
              </RowValue>
            </Row>
            <Hint>
              Sesin perdesi değişir, hızı ve satırların zamanlaması aynı kalır.
              ±3'ün ötesi yapay duyulur.
            </Hint>
            <RowGroup>
              <RowLabel>Seed</RowLabel>
              <input
                type="number"
                min={0}
                className="h-6.5 w-0 min-w-0 flex-1 rounded-ui border border-line bg-bg px-2 text-[12.5px] text-fg tabular-nums"
                value={browser.seed}
                disabled={working}
                aria-label="Seed"
                onChange={(e) =>
                  onVoice({
                    ...browser,
                    seed: Math.max(0, Math.floor(Number(e.target.value) || 0)),
                  })
                }
              />
              <Button
                disabled={working}
                onClick={() =>
                  onVoice({ ...browser, seed: Math.floor(Math.random() * 100000) })
                }
              >
                Rastgele
              </Button>
            </RowGroup>
            <Hint>
              Aynı seed aynı okumayı verir; değiştirince aynı ses biraz farklı bir
              vurguyla okur.
            </Hint>
          </>
        )}

        {server && (
          <>
            <RowGroup role="radiogroup" aria-label="Sunucu ses modeli">
              <RowLabel>Model</RowLabel>
              {serverVoices.map((v) => (
                <button
                  key={v.model}
                  type="button"
                  className={PRESET}
                  role="radio"
                  aria-checked={server.model === v.model}
                  aria-pressed={server.model === v.model}
                  disabled={working}
                  onClick={() => onVoice({ ...server, model: v.model, voice: v.voice })}
                >
                  {v.name}
                </button>
              ))}
            </RowGroup>
            <Row>
              <RowLabel>Hız</RowLabel>
              <Range
                min={0.5}
                max={2}
                step={0.05}
                value={server.speed}
                disabled={working}
                onChange={(e) => onVoice({ ...server, speed: Number(e.target.value) })}
                onDoubleClick={() => onVoice({ ...server, speed: 1 })}
              />
              <RowValue>{server.speed.toFixed(2)}×</RowValue>
            </Row>
            <Hint>
              Sunucu hızı sesi çeker; bir satır kendi aralığına sığmazsa taşar
              (tarayıcı sesi satırı hızlandırarak sığdırır).
            </Hint>
          </>
        )}

        <SectionActions>
          <Button disabled={working || busy} onClick={onListen}>
            {previewLabel(preview)}
          </Button>
        </SectionActions>
        {preview.status === "error" && <Hint>Dinlenemedi: {preview.message}</Hint>}
      </Section>

      <Section title="Dinleme ve dışa aktarma">
        <Row>
          <RowLabel wide>Yapay sesi kullan</RowLabel>
          <Switch
            checked={on}
            disabled={state.status !== "done" || busy}
            onChange={(e) => onOn(e.target.checked)}
          />
        </Row>
        <Hint>
          Açıkken oynatıcı ve altyazılı video orijinal ses yerine yapay sesi
          kullanır. Müzik ve ortam sesi de kalkar.
        </Hint>
      </Section>

      <Section title="Model">
        {browser && meta ? (
          <Hint>
            <a href={meta.link}>{meta.name}</a>, {meta.note} Ses bu
            bilgisayarda üretilir. Paylaşırken sesin yapay zekâyla üretildiğini
            belirtmeyi unutma.
          </Hint>
        ) : (
          <Hint>
            {serverName} ({server?.voice}), Apeksis sunucusunda üretilir. Paylaşırken
            sesin yapay zekâyla üretildiğini belirtmeyi unutma.
          </Hint>
        )}
      </Section>
    </div>
  );
}
