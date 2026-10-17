// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useMemo, useState } from "react";
import type { CaptionSettings } from "../captions/style";
import type { DecodingMethod } from "../engine";
import { writeNumbers, type NumberMode } from "../lib/numbers";
import type { DubState, PreviewState } from "../lib/useDubber";
import type { VoiceChoice } from "../lib/voices";
import type { EngineState, Job } from "../lib/useTranscriber";
import type { TranslateState } from "../lib/useTranslator";
import { modelInfo, type ModelId } from "../models";
import { CaptionStudio, STUDIO } from "./CaptionStudio";
import { DubPanel } from "./DubPanel";
import { Meter } from "./Indicators";
import { MethodPicker, methodTitle } from "./MethodPicker";
import { OPT, OPT_NOTE, OPT_TEXT, OPT_TITLE, Select } from "./Select";
import {
  Button,
  Hint,
  Pane,
  PaneBody,
  Row,
  RowLabel,
  Section,
  SectionActions,
  Switch,
} from "./ui";

const TAB =
  "h-[26px] flex-1 rounded-[5px] border-0 bg-transparent text-[12px] font-medium tracking-[-0.01em] text-fg-2 transition-all duration-150 ease-[ease] hover:not-aria-selected:text-fg aria-selected:bg-raised aria-selected:font-[550] aria-selected:text-white aria-selected:shadow-[0_1px_3px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.06)]";

type Tab = "captions" | "transcribe" | "dub";

// Each option shows its result rather than its rule.
const NUMBER_MODES: { value: NumberMode; label: string; sample: string }[] = [
  {
    value: "rule",
    label: "Kurala göre",
    sample: "Saat 15.30'da 15 kişi geldi, üç kişi kaldı.",
  },
  {
    value: "all",
    label: "Hepsi rakamla",
    sample: "Saat 15.30'da 15 kişi geldi, 3 kişi kaldı.",
  },
  {
    value: "keep",
    label: "Dokunma",
    sample: "Sayılara dokunulmaz. Önceki düzenleme ⌘Z ile geri alınır.",
  },
];

export function Inspector({
  settings,
  onSettings,
  burning,
  model,
  method,
  onMethod,
  job,
  engine,
  onRestart,
  onResume,
  onCancel,
  autoPunct,
  onAutoPunct,
  onPunctuate,
  punctBusy,
  numberMode,
  onNumberMode,
  onNumbers,
  dub,
  dubStale,
  canDub,
  onDub,
  onCancelDub,
  dubOn,
  onDubOn,
  dubName,
  voice,
  onVoice,
  preview,
  onListen,
  translate,
  translation,
  translationStale,
  canTranslate,
  onTranslate,
  onCancelTranslate,
  serverProvider = false,
}: {
  settings: CaptionSettings;
  onSettings: (s: CaptionSettings) => void;
  burning: boolean;
  model: ModelId;
  method: DecodingMethod;
  onMethod: (m: DecodingMethod) => void;
  /** The "sunucu" provider decodes on the server, so the browser decoding controls do not apply. */
  serverProvider?: boolean;
  job: Job | null;
  engine: EngineState;
  onRestart: () => void;
  /** Go on with a stopped transcription; missing when it cannot. */
  onResume?: () => void;
  onCancel: () => void;
  autoPunct: boolean;
  onAutoPunct: (on: boolean) => void;
  onPunctuate: () => void;
  punctBusy: boolean;
  numberMode: NumberMode;
  onNumberMode: (m: NumberMode) => void;
  onNumbers: () => void;
  dub: DubState;
  dubStale: boolean;
  canDub: boolean;
  onDub: () => void;
  onCancelDub: () => void;
  dubOn: boolean;
  onDubOn: (on: boolean) => void;
  dubName: string;
  voice: VoiceChoice;
  onVoice: (v: VoiceChoice) => void;
  preview: PreviewState;
  onListen: () => void;
  translate: TranslateState;
  /** The job has a translation. */
  translation: boolean;
  /** The transcript changed after it was translated. */
  translationStale: boolean;
  canTranslate: boolean;
  onTranslate: () => void;
  onCancelTranslate: () => void;
}) {
  const [tab, setTab] = useState<Tab>("captions");
  const running = job?.status === "running";
  const info = modelInfo(model);
  // Whisper punctuates by itself: the section is for Seda, or for a Seda transcript that is open.
  const sedaJob = !!job && !modelInfo(job.model).punctuates;
  const showPunct = !info.punctuates || sedaJob;
  // A dry run on the open transcript: how many words "Şimdi uygula" would change.
  const numberChanges = useMemo(() => {
    if (!job || job.status !== "done" || numberMode === "keep") return 0;
    const before = new Set(job.words);
    return writeNumbers(job.words, numberMode).filter((w) => !before.has(w))
      .length;
  }, [job, numberMode]);
  // What a new run would change: the model, or (seda only) the method.
  const differs =
    job &&
    (model !== job.model ||
      (model === "seda" && method !== job.options.method));
  const restartLabel = !differs
    ? "Yeniden yazıya dök"
    : model !== job.model
      ? `${info.name} ile yeniden dök`
      : `${methodTitle(method)} ile yeniden dök`;

  return (
    <Pane side="right">
      <div
        className="mx-3 mt-2.5 mb-1.5 flex gap-0.5 rounded-lg border border-line-soft bg-[#101316] p-0.75"
        role="tablist"
      >
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "captions"}
          onClick={() => setTab("captions")}
        >
          Altyazı
        </button>
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "transcribe"}
          onClick={() => setTab("transcribe")}
        >
          Yazıya döküm
        </button>
        <button
          className={TAB}
          role="tab"
          aria-selected={tab === "dub"}
          onClick={() => setTab("dub")}
        >
          Seslendirme
        </button>
      </div>
      <PaneBody>
        {tab === "captions" ? (
          <CaptionStudio
            settings={settings}
            onChange={onSettings}
            disabled={burning}
          />
        ) : tab === "dub" ? (
          <DubPanel
            state={dub}
            stale={dubStale}
            canDub={canDub}
            busy={burning}
            onDub={onDub}
            onCancel={onCancelDub}
            on={dubOn}
            onOn={onDubOn}
            fileName={dubName}
            voice={voice}
            onVoice={onVoice}
            preview={preview}
            onListen={onListen}
          />
        ) : (
          <div className={STUDIO}>
            <Section title="Doğruluk">
              {serverProvider ? (
                <Hint>
                  Sunucu sağlayıcısı dosyayı Apeksis sunucusuna gönderir; deşifre yöntemi ve kelime
                  zamanları sunucuda belirlenir.
                </Hint>
              ) : info.id === "seda" ? (
                <MethodPicker
                  value={method}
                  onChange={onMethod}
                  disabled={running}
                />
              ) : (
                <Hint>
                  {info.name} sesi {info.engine === "duyu" ? "12–15" : "30"} saniyelik parçalar hâlinde işler;
                  kelimeler her parça bitince gelir. Model seçimi üst çubukta.
                </Hint>
              )}
              {job && (
                <SectionActions>
                  {running ? (
                    <Button onClick={onCancel}>Durdur</Button>
                  ) : onResume ? (
                    <>
                      <Button variant="primary" onClick={onResume}>
                        Devam et
                      </Button>
                      <Button onClick={onRestart}>{restartLabel}</Button>
                    </>
                  ) : (
                    <Button variant="primary" onClick={onRestart}>
                      {restartLabel}
                    </Button>
                  )}
                </SectionActions>
              )}
            </Section>
            {showPunct && (
              <Section title="Noktalama ve büyük harf">
                <Row>
                  <RowLabel wide>Otomatik ekle</RowLabel>
                  <Switch
                    checked={autoPunct}
                    onChange={(e) => onAutoPunct(e.target.checked)}
                  />
                </Row>
                <Hint>
                  Döküm bitince nokta, virgül ve soru işareti eklenir; cümle
                  başları ve özel adlar büyük harfle yazılır ("İstanbul'da"). ⌘Z
                  ile geri alınır. İlk kullanımda yaklaşık 60 MB model
                  indirilir.
                </Hint>
                {/* Not on a Whisper transcript: it would replace Whisper's own punctuation with a weaker one. */}
                {sedaJob && (
                  <SectionActions>
                    <Button
                      disabled={running || punctBusy || !job.words.length}
                      onClick={onPunctuate}
                    >
                      {punctBusy ? "Ekleniyor…" : "Şimdi uygula"}
                    </Button>
                  </SectionActions>
                )}
              </Section>
            )}
            <Section title="Sayı yazımı">
              <Select<NumberMode>
                label="Sayı yazımı"
                value={numberMode}
                options={NUMBER_MODES}
                onChange={onNumberMode}
                render={(o, inList) => (
                  <span className={OPT}>
                    <span className={OPT_TEXT}>
                      <span className={OPT_TITLE}>{o.label}</span>
                      {inList && (
                        <span className={OPT_NOTE}>
                          {
                            NUMBER_MODES.find((m) => m.value === o.value)!
                              .sample
                          }
                        </span>
                      )}
                    </span>
                  </span>
                )}
              />
              <Hint>
                {NUMBER_MODES.find((m) => m.value === numberMode)!.sample}
                {numberMode !== "keep" &&
                  ' Döküm bitince her modelde uygulanır; tarih ve saat hep rakamla yazılır ("23 Nisan", "saat 15.30"). ⌘Z ile geri alınır.'}
              </Hint>
              {job && numberMode !== "keep" && (
                <SectionActions>
                  <Button
                    disabled={running || !numberChanges}
                    onClick={onNumbers}
                  >
                    {running
                      ? "Şimdi uygula"
                      : numberChanges
                        ? `${numberChanges} sayıyı düzenle`
                        : "Değişecek sayı yok"}
                  </Button>
                </SectionActions>
              )}
            </Section>
            <Section title="İngilizce çeviri">
              <Hint>
                Transkript cümle cümle İngilizceye çevrilir; her cümle Türkçesinin
                zamanında görünür. Transkriptin üstündeki TR / EN ile altyazı,
                dışa aktarma ve video için dil seçilir; çeviri de düzenlenebilir.
                İlk kullanımda yaklaşık 360 MB model indirilir.
              </Hint>
              {translate.status === "download" && (
                <div className="flex items-center gap-2.5 text-[12px] text-fg-2">
                  <span className="flex-1">
                    Model indiriliyor %
                    {Math.floor((translate.loaded / (translate.total || 1)) * 100)}
                  </span>
                  <Meter value={translate.loaded / (translate.total || 1)} />
                </div>
              )}
              {translate.status === "running" && (
                <div className="flex items-center gap-2.5 text-[12px] text-fg-2">
                  <span className="flex-1">
                    {translate.done
                      ? `Çevriliyor ${translate.done} / ${translate.total}`
                      : "Model hazırlanıyor"}
                  </span>
                  <Meter value={translate.total ? translate.done / translate.total : 0} />
                </div>
              )}
              {translate.status === "error" && (
                <Hint>Çevrilemedi: {translate.message}</Hint>
              )}
              {translation && translationStale && translate.status === "idle" && (
                <Hint>
                  Transkript çeviriden sonra değişti. Yeniden çevirirsen
                  çeviride yaptığın düzeltmeler gider (⌘Z ile geri gelir).
                </Hint>
              )}
              <SectionActions>
                {translate.status === "download" || translate.status === "running" ? (
                  <Button onClick={onCancelTranslate}>Durdur</Button>
                ) : (
                  <Button
                    variant={translation && !translationStale ? "default" : "primary"}
                    disabled={!canTranslate || running}
                    onClick={onTranslate}
                  >
                    {translation ? "Yeniden çevir" : "İngilizceye çevir"}
                  </Button>
                )}
              </SectionActions>
              <Hint>
                <a href="https://huggingface.co/Helsinki-NLP/opus-mt-tc-big-tr-en">
                  opus-mt-tc-big-tr-en
                </a>{" "}
                (Helsinki-NLP, CC-BY 4.0), bu bilgisayarda çalışır. Yemek adları,
                özel adlar ve argo yanlış çevrilebilir; paylaşmadan önce göz at.
              </Hint>
            </Section>
            <Section title="Model">
              <dl className="m-0 grid grid-cols-[88px_1fr] gap-x-2.5 gap-y-1.5 text-[12.5px] [&_dd]:m-0 [&_dt]:text-fg-3">
                <dt>Model</dt>
                <dd>
                  <a href={info.link}>{info.spec}</a>
                  {info.engine === "seda"
                    ? ", Türkçe"
                    : info.engine === "duyu"
                      ? ", Türkçe ve İngilizce (Türkçe seçili)"
                      : ", çok dilli (Türkçe seçili)"}
                </dd>
                <dt>Çalıştığı yer</dt>
                <dd>
                  {engine.phase === "ready"
                    ? engine.provider === "webgpu"
                      ? `WebGPU${engine.gpu ? `, ${engine.gpu}` : ""}`
                      : "İşlemci (WASM)"
                    : "Henüz yüklenmedi"}
                </dd>
                <dt>Gizlilik</dt>
                <dd>Ses ve video bu bilgisayardan çıkmaz.</dd>
              </dl>
              <Hint>
                {info.id === "seda" &&
                  'Sayılar yazıyla gelir ("bin dokuz yüz yirmi üç"). '}
                Bir kelimeye tıklayınca kayıt o ana atlar.
              </Hint>
            </Section>
          </div>
        )}
      </PaneBody>
    </Pane>
  );
}
