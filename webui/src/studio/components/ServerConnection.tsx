// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useEffect, useState } from "react";
import { ApiError, fetchModels, fetchRuntimeStatus } from "../../api/client";
import { pushLog } from "../../lib/debug";
import { describeRuntimeStatus, type RuntimeStatus } from "../../lib/runtimeStatus";
import { hasStoredKey, loadSettings, saveSettings } from "../../lib/settings";
import { Badge, Button, Field, Hint, SettingsBlock, inputClass } from "./ui";

// Settings → Sunucu → "Bağlantı": how this browser reaches the Apeksis gateway.
//
// This is the ONE place the connection is configured. The key stays in this
// browser only (localStorage); the base URL is empty for the normal same-origin
// install, where the TLS proxy routes /v1 to the gateway.
//
// Aşama 9b: this block used to be the whole "Sunucu" section; the full-screen
// panel's status, endpoint catalog and log moved in beside it, so the gateway is
// one page instead of three surfaces.

export function ServerConnection({ active }: { active: boolean }) {
  const [apiKey, setApiKey] = useState(loadSettings().apiKey);
  const [baseUrl, setBaseUrl] = useState(loadSettings().baseUrl);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [hasKey, setHasKey] = useState(hasStoredKey);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fetchRuntimeStatus().then((status) => {
      if (alive) setRuntime(status);
    });
    return () => {
      alive = false;
    };
  }, [active]);

  const needsKey = runtime ? runtime.needKey : false;
  const status = runtime ? describeRuntimeStatus(runtime) : null;

  /** A real /v1/models call: the same call every server feature makes. */
  const verify = async () => {
    setBusy(true);
    setResult(null);
    try {
      const models = await fetchModels();
      setResult({ tone: "ok", text: `Bağlantı kuruldu · ${models.data.length} model` });
    } catch (error) {
      setResult({
        tone: "bad",
        text:
          error instanceof ApiError
            ? error.status === 401 || error.status === 403
              ? `Anahtar reddedildi (${error.status}). Anahtarı kontrol edip yeniden deneyin.`
              : `${error.status} · ${error.message}`
            : "Sunucuya ulaşılamadı.",
      });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    saveSettings({ apiKey, baseUrl });
    setHasKey(hasStoredKey());
    pushLog({ kind: "ui", method: "AYAR", path: "/sunucu", detail: "sunucu ayarları kaydedildi" });
    await verify();
  };

  return (
    <SettingsBlock title="Bağlantı">
      <div className="flex items-start gap-2 rounded-[10px] border border-line-soft bg-pane p-3">
        <Badge tone={runtime ? status!.tone : "neutral"}>{runtime ? `Kimlik · ${runtime.mode}` : "Kurulum"}</Badge>
        <span className="text-[12.5px] leading-normal text-fg-2">
          {status
            ? status.text
            : "Kimlik durumu okunamadı. Normal (yerel) kurulumda anahtar gerekmez; uzaktaki bir sunucuya bağlanıyorsanız anahtarınızı girin."}
        </span>
      </div>

      {needsKey && (
        <Field label="API anahtarı (Bearer)">
          <input
            className={inputClass}
            type="password"
            value={apiKey}
            placeholder="Uygulama anahtarı…"
            onChange={(event) => setApiKey(event.target.value)}
          />
        </Field>
      )}

      <details className="rounded-[10px] border border-line-soft bg-pane p-3">
        <summary className="cursor-pointer select-none text-[12.5px] font-medium text-fg-2">
          Gelişmiş bağlantı ayarları
        </summary>
        <div className="mt-3 grid gap-3">
          {!needsKey && (
            <Field label="API anahtarı (yalnızca LAN / anahtar gerekiyorsa)">
              <input
                className={inputClass}
                type="password"
                value={apiKey}
                placeholder="boş bırakılabilir"
                onChange={(event) => setApiKey(event.target.value)}
              />
            </Field>
          )}
          <Field label="Temel URL (boş = aynı origin)">
            <input
              className={inputClass}
              type="text"
              value={baseUrl}
              placeholder="https://192.168.1.120:8443"
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Sınanıyor…" : "Kaydet ve sına"}
        </Button>
        {hasKey && !needsKey && <Badge tone="ok">Bu tarayıcıda anahtar var</Badge>}
        {result && (
          <span className={`text-[12px] ${result.tone === "ok" ? "text-firuze" : "text-mercan"}`} role="status">
            {result.text}
          </span>
        )}
      </div>

      <Hint>
        Anahtar yalnızca bu tarayıcıda (localStorage) saklanır; sunucuya gönderilmez. Canlı durum için
        durum çubuğuna, ayrıntı için aşağıdaki <b>Durum</b> ve <b>Uçlar</b> bloklarına bakın.
      </Hint>
    </SettingsBlock>
  );
}
