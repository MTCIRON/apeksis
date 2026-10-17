// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { clock, duration as fmtDuration, megabytes, remaining } from "../lib/format";
import { gatewayLabel, type GatewayState } from "../../lib/useGateway";
import type { BurnState } from "../lib/useBurner";
import type { EngineState, Job, PunctState } from "../lib/useTranscriber";
import type { SttProvider } from "../worker/protocol";
import { Meter, RecDot } from "./Indicators";

const ITEM =
  "inline-flex min-w-0 items-center gap-[7px] overflow-hidden text-ellipsis tabular-nums [font-feature-settings:'tnum'_1]";
const ERROR = `${ITEM} text-mercan`;
const DIM = "text-fg-3";

function EngineItem({ engine, provider }: { engine: EngineState; provider: SttProvider }) {
  // The server needs no browser model; there is nothing to download or compile.
  if (provider === "sunucu") {
    return (
      <span className={ITEM} title="Dosya Apeksis sunucusunda yazıya dökülür">
        <span
          className="size-[7px] flex-none rounded-full bg-cini shadow-[0_0_6px_rgba(71,109,230,0.6)]"
          aria-hidden
        />
        Sunucu (Apeksis)
        <span className={DIM}>/v1/audio/transcriptions</span>
      </span>
    );
  }
  switch (engine.phase) {
    case "idle":
      return <span className={ITEM}>Model ilk dosyada indirilecek</span>;
    case "downloading": {
      const pct = engine.total ? engine.loaded / engine.total : 0;
      return (
        <span className={ITEM} role="status">
          {engine.fromCache ? "Model önbellekten açılıyor" : `Model indiriliyor ${megabytes(engine.loaded)} / ${megabytes(engine.total)} MB`}
          <Meter value={pct} />
        </span>
      );
    }
    case "compiling":
      return <span className={ITEM}>Model hazırlanıyor</span>;
    case "ready":
      return (
        <span className={ITEM} title={engine.gpu ?? engine.fallbackReason ?? undefined}>
          <span
            className={`size-[7px] flex-none rounded-full ${
              engine.provider === "webgpu"
                ? "bg-cini shadow-[0_0_6px_rgba(71,109,230,0.6)]"
                : "bg-firuze shadow-[0_0_6px_rgba(54,194,180,0.6)]"
            }`}
            aria-hidden
          />
          {engine.provider === "webgpu" ? "WebGPU" : "İşlemci (WASM)"}
          {engine.gpu && <span className={DIM}>{engine.gpu}</span>}
          {engine.provider === "wasm" && engine.fallbackReason && <span className={DIM}>{engine.fallbackReason}</span>}
        </span>
      );
    case "error":
      return (
        <span className={ERROR} role="alert">
          Model yüklenemedi: {engine.message}
        </span>
      );
  }
}

function JobItem({
  job,
  engine,
  provider,
  liveWaiting,
}: {
  job: Job | null;
  engine: EngineState;
  provider: SttProvider;
  liveWaiting: boolean;
}) {
  // The model progress is on the right; the job itself has not started yet.
  if (liveWaiting) return <span className={ITEM} role="status">Model hazır olunca kayıt başlayacak</span>;
  if (!job) return null;
  // A server run needs no browser model, so it never waits for one.
  if (job.status === "running" && !job.live && provider !== "sunucu" && !job.server && engine.phase !== "ready" && engine.phase !== "error") {
    return <span className={ITEM} role="status">Model hazır olunca yazıya dökme başlayacak</span>;
  }
  if (job.live && job.status === "running") {
    return (
      <span className={ITEM} role="status">
        {job.recording ? (
          <>
            <RecDot /> Dinleniyor, {clock(job.decoded)} yazıya döküldü
          </>
        ) : (
          "Son kelimeler yazılıyor"
        )}
      </span>
    );
  }
  switch (job.status) {
    case "running": {
      // One request, one answer: the server reports no progress to show.
      if (job.server) return <span className={ITEM} role="status">Sunucuda yazıya dökülüyor…</span>;
      const pct = job.duration ? Math.min(99, Math.floor((job.decoded / job.duration) * 100)) : 0;
      return (
        <span className={ITEM} role="status">
          Yazıya dökülüyor %{pct}
          <Meter value={pct / 100} />
          {job.speed > 0.5 && <span className={DIM}>{job.speed.toFixed(1)}× hız</span>}
        </span>
      );
    }
    case "done":
      return (
        <span className={ITEM}>
          {job.words.length} kelime
          <span className={DIM}>
            {job.imported
              ? `${job.imported} altyazısından`
              : `${fmtDuration(job.duration ?? job.decoded)} kayıt, ${fmtDuration(job.elapsed ?? 0)} içinde`}
            {job.server && " · sunucudan"}
          </span>
        </span>
      );
    case "cancelled":
      // A server run writes nothing until it answers, so there is no partial point.
      return job.server ? (
        <span className={ITEM}>Durduruldu</span>
      ) : (
        <span className={ITEM}>Durduruldu, {clock(job.decoded)} konumuna kadar yazıya döküldü</span>
      );
    case "error":
      return (
        <span className={ERROR} role="alert">
          {job.error}
        </span>
      );
  }
}

function PunctItem({ punct }: { punct: PunctState }) {
  if (punct.phase === "idle") return null;
  if (punct.phase === "error") {
    return (
      <span className={ERROR} role="alert">
        Noktalama eklenemedi: {punct.message}
      </span>
    );
  }
  const pct = punct.total ? punct.done / punct.total : 0;
  return (
    <span className={ITEM} role="status">
      {punct.phase === "download"
        ? `Noktalama modeli indiriliyor ${megabytes(punct.done)} / ${megabytes(punct.total)} MB`
        : "Noktalama ekleniyor"}
      <Meter value={pct} />
    </span>
  );
}

function BurnItem({ burn }: { burn: BurnState }) {
  if (burn.status !== "running") return null;
  return (
    <span className={ITEM} role="status">
      Video oluşturuluyor %{Math.floor(burn.progress * 100)}
      {burn.remaining !== null && `, ${remaining(burn.remaining)} kaldı`}
      <Meter value={burn.progress} />
    </span>
  );
}

const ACTION =
  "cursor-pointer rounded-ui-sm border border-line bg-transparent px-1.5 py-px text-[11px] leading-[15px] text-fg-2 hover:bg-line hover:text-fg";

/** The gateway's health, on the same line as the engine (Aşama 8). */
function GatewayItem({ gateway, onOpen }: { gateway: GatewayState; onOpen: () => void }) {
  const { text, tone } = gatewayLabel(gateway);
  const dot =
    tone === "ok"
      ? "bg-firuze shadow-[0_0_6px_rgba(54,194,180,0.6)]"
      : tone === "warn"
        ? "bg-mercan"
        : tone === "bad"
          ? "bg-mercan shadow-[0_0_6px_rgba(224,96,96,0.6)]"
          : "bg-fg-3";
  const workers = Object.entries(gateway.ready?.workers ?? {});
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`${tone === "bad" ? ERROR : ITEM} flex-none cursor-pointer rounded-ui-sm border-0 bg-transparent p-0 text-left hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cini max-[860px]:hidden`}
      title={
        gateway.failed
          ? "Ağ geçidine ulaşılamadı (/healthz, /readyz). Ayarlar → Sunucu'dan yeniden deneyebilirsin."
          : workers.length
            ? `Servisler: ${workers.map(([name, ok]) => `${name}: ${ok ? "hazır" : "bekliyor"}`).join(" · ")} · Ayarlar → Sunucu`
            : "Ağ geçidi /healthz ve /readyz yanıtı · Ayarlar → Sunucu"
      }
      aria-label={`Sunucu durumu: ${text}. Ayarlar'da aç.`}
    >
      <span className={`size-[7px] flex-none rounded-full ${dot}`} aria-hidden />
      {text}
    </button>
  );
}

export function StatusBar({
  engine,
  provider,
  job,
  burn,
  notice,
  punct,
  liveWaiting,
  gateway,
  onOpenServer,
  onStop,
  onDiscard,
  onResume,
}: {
  engine: EngineState;
  provider: SttProvider;
  job: Job | null;
  liveWaiting: boolean;
  burn: BurnState;
  punct: PunctState;
  /** One-off problem to show, e.g. microphone permission denied. */
  notice: string | null;
  /** The gateway's own health, polled silently (Aşama 8). */
  gateway: GatewayState;
  /** Open Settings → Sunucu: where the gateway can be re-checked (Aşama 9b). */
  onOpenServer: () => void;
  /** Stop the transcription and keep what is written. */
  onStop: () => void;
  /** Stop it and drop the job: nothing is saved. */
  onDiscard: () => void;
  /** Go on with a stopped transcription; missing when it cannot. */
  onResume?: () => void;
}) {
  const transcribing = job?.status === "running" && !job.live;
  return (
    <footer className="flex items-center gap-[18px] border-t border-line-soft bg-[#111417] px-3.5 text-[11px] tracking-[-0.005em] whitespace-nowrap text-fg-2 max-[860px]:order-5 max-[860px]:mt-auto max-[860px]:h-[26px]">
      {notice && (
        <span className={ERROR} role="alert">
          {notice}
        </span>
      )}
      <JobItem job={job} engine={engine} provider={provider} liveWaiting={liveWaiting} />
      {transcribing && (
        <span className="inline-flex flex-none gap-1.5">
          <button type="button" className={ACTION} title="Şimdiye kadar dökülen kısım proje olarak kalır" onClick={onStop}>
            Durdur
          </button>
          {/* A continued job is already saved as a project: only stopping makes sense. */}
          {!job.startAt && (
            <button type="button" className={ACTION} title="Yanlış dosya mı? Döküm silinir, proje kaydedilmez" onClick={onDiscard}>
              İptal
            </button>
          )}
        </span>
      )}
      {onResume && (
        <button type="button" className={`${ACTION} flex-none`} title="Kaldığı yerden yazıya dökmeye devam et" onClick={onResume}>
          Devam et
        </button>
      )}
      <PunctItem punct={punct} />
      <BurnItem burn={burn} />
      <span className="flex-1" />
      <GatewayItem gateway={gateway} onOpen={onOpenServer} />
      <EngineItem engine={engine} provider={provider} />
    </footer>
  );
}
