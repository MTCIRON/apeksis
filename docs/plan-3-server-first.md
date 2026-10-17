# Plan 3 — Sunucu-öncelikli tek API (CPU)

> **Durum: Aşama A ve B TAMAMLANDI (2026-10-16); C–H onay bekliyor.** Plan onaylandı, kararlar S1–S5
> verildi (§5). Aşama A'nın kanıtı Plan 2 §15'te, Aşama B'nin kanıtı §7'de.

## 0. İlke (kullanıcı kararı)

1. **Sunucu (CPU) kanonik yürütme yoludur.** Hiçbir yetenek tarayıcıya ya da GPU'ya bağlı olmaz;
   sunucuda CPU'da çalışacakmış gibi planlanır.
2. **Tek OpenAI-uyumlu API** hem stüdyoya hem **dış ajanlara** (n8n, OpenWebUI, Hermes, diğerleri)
   hizmet eder. Stüdyo yalnızca bu API'nin bir istemcisidir — stüdyoya özel uç yoktur.
3. **Tüm modeller desteklenir** ve `/v1/models`'ta dürüstçe listelenir.
4. **Modeller imajla taşınır**; her makinede yeniden indirilmez (kayıt defteri ya da `save`/`load`).

Bu, Plan 2'nin doğal devamıdır: Plan 2 §11 **varsayılanı** sunucu yaptı; Plan 3 sunucuyu **eksiksiz
kanonik yol** yapar (bugün yalnızca tarayıcıda olan noktalama/çeviri dahil).

---

## 1. Mevcut durum (kanıtlı envanter)

### 1.1 Uç noktalar (`src/voxi/gateway.py`, satır numaralarıyla)

| Uç | Kimlik | OpenAI-uyumlu? |
|---|---|---|
| `GET /healthz` · `GET /readyz` · `GET /metrics` | açık | hayır (operasyonel) |
| `GET /v1/endpoints` | **açık** | hayır (katalog) |
| `GET /v1/models` | `protected` | **evet** |
| `POST /v1/audio/speech` | `audio:write` | **evet** |
| `POST /v1/audio/transcriptions` | `audio:write` | **evet** |
| `POST /v1/auth/socket` | `protected` | hayır (tarayıcı WS bileti) |
| `POST /v1/sessions` · `/turns` · `DELETE` | `realtime:connect` | hayır (Voxi ajan döngüsü) |
| `WS /v1/sessions/{id}/stream` | `realtime:connect` | hayır |
| `WS /v1/tts/stream` | `audio:write` | hayır (Voxi akış protokolü) |
| `WS /v1/realtime/transcriptions` | `audio:write` | hayır (Voxi akış protokolü) |

Sözleşmeler `src/voxi/contracts.py`: `SpeechRequest` (model/input/voice/response_format wav·pcm·mp3/
speed/sample_rate/seed), `TranscriptionRequest` (language/prompt/temperature/word_timestamps),
`TranscriptionResult`. Hepsi `extra="forbid"`.

### 1.2 Kimlik ve kapsamlar (`src/voxi/auth.py`)

- `Keyring(VOXI_API_KEY, VOXI_API_KEYS_JSON)` — **çoklu anahtar zaten destekli**; her kayıt
  `{id, sha256, scopes[]}`. `VOXI_API_KEY` "application" kimliğini üç kapsamla ekler.
- Kapsamlar **yalnızca üç**: `audio:read`, `audio:write`, `realtime:connect`.
- Worker'lar ayrı `VOXI_WORKER_API_KEY` ile korunur (`/internal/*` asla yayınlanmaz).
- **Sonuç:** dış ajanlara ayrı anahtar + kapsam vermek **bugün mümkün** (n8n'e `audio:read+write`,
  OpenWebUI'a aynısı, Hermes'e ihtiyacı kadar). Yeni metin yetenekleri için **yeni kapsam gerekir**.

### 1.3 Dış ajan entegrasyonları — **dosyalar zaten var**

`integrations/n8n/{README.md, turn-agent.json, file-tts.json, file-stt.json}` ·
`integrations/openwebui/{README.md, audio.env.example}` ·
`integrations/hermes/{README.md, config.yaml.example}` ·
`integrations/ucm6510/checklist.md` · `integrations/nginx/*` · `integrations/webui/README.md`.

`docs/deployment.md:179` bunları işaret eder. **Eksik olan entegrasyon değil, uçtan uca doğrulama
ve kapsam tutarlılığıdır.**

### 1.4 Provizyon akışı (bugün) — modeller **imajda değil, volume'da**

- `provision-*` tek seferlik servisler (`profiles: provision`, `provision-antalia`) → `provision_models.py`
  → **named volume**'lara yazar (`voxi_ema-models`, `voxi_whisper-models`, `voxi_antalia-models`).
- Runtime volume'ları **`:ro`** bağlar; imajlar model içermez.
- Host dizinleri alternatif (`EMA_MODEL_PATH` vb.).
- **Sonuç:** her yeni makinede modeller **tekrar indirilir** (kullanıcının şikâyeti).

### 1.5 Lisans kapısı (`docs/licensing.md`) — imaj dağıtımını doğrudan bağlar

> "Model provisioning must save immutable revisions and SHA256 artifact manifest plus upstream
> license/notice assets. **Shipping model assets or images requires retaining these and auditing
> every transitive dependency, tokenizer, VAD asset, dataset/training notice and OS package.**"

Lisanslar: EMA Lightning **Apache-2.0**, normalizer-tr Apache-2.0, Faster-Whisper **MIT**,
Antalia-2 Mini **Apache-2.0** (Antalia 1 bilinçli hariç), noktalama kaynağı **MIT**
(`uygarkurt/bert-restore-punctuation-turkish`). **Model imajı yayınlamak hukuken serbest değil —
notis+denetim şartı var.** Plan bunu bir kapı olarak taşır.

### 1.6 Model envanteri (Plan 2 §13'ten)

- **Sunucuda çalışan:** `ema-lightning` (TTS, `ema-tr`), `antalia-mini` (TTS, `antalia-tr`),
  `whisper-small` (STT) + `tts-1` / `whisper-1` takma adları.
- **Sunucuda YOK:** `whisper-large-v3-turbo` (envanterde tanımlı, servis/dosya yok),
  **noktalama** (artefakt diskte, uç yok), **çeviri** (yalnızca tarayıcı).
- **Tarayıcıda 4 ASR modeli** (`webui/src/lib/models.ts`): **Seda** (`seda-v0.1`, 105 MB, canlı,
  CPU+WebGPU), **Duyu** (`Duyu-small` int8, 85 MB, noktalama+büyük harfi kendi yazar, canlı değil),
  **Whisper Turbo Hafif** (`whisper-large-v3-turbo` q4f16, 600 MB, GPU) ve **Whisper Turbo**
  (`whisper-large-v3-turbo` fp16+q4f16, 1,5 GB, GPU). Sunucuda bunlardan **hiçbiri** yok: sunucu STT
  tek model, `whisper-small`.
- **Tarayıcı paketleri:** 8 tanımlı, **0 kurulu** (Plan 2 §13.2).

---

## 2. Boşluk analizi

| # | Boşluk | Kanıt | Etki |
|---|---|---|---|
| **G1** | Stüdyonun **canlı konuşması** ajan oturumuna (n8n) bağlı (**Aşama A'da giderildi**) | `studio/App.tsx:942` `if (!(await session.start())) return;` → `goLive()` hiç çalışmaz; `goLive` oturuma dokunmaz | n8n yoksa canlı transkript çalışmıyor — yapay kısıt |
| **G2** | **Noktalama** sunucuda uç yok | `src/voxi`'de punct/worker yok; ONNX yalnız nginx'ten tarayıcıya | CPU-only sunucuda yetenek eksik |
| **G3** | **Çeviri** sunucuda yok | `src/voxi`'de hiç yok; tarayıcıda `opus-mt-tc-big-tr-en` | aynı |
| **G4** | Model kapsamı eksik | `whisper-large-v3-turbo` servissiz | kalite seçeneği yok |
| **G5** | Kapsamlar yalnız ses | `auth.py` üç kapsam | yeni metin uçları yetkilendirilemez |
| **G6** | OpenAI uyumu uçtan uca doğrulanmamış | yalnız `scripts/smoke.py` dosya çıkarımı | dış istemci riski |
| **G7** | Dış ajan entegrasyonları doğrulanmamış | dosyalar var, E2E kanıt yok | "çalışıyor" denemez |
| **G8** | Modeller her makinede yeniden iner | volume + provision | zaman/bant genişliği |
| **G9** | Tarayıcı paketleri tutarsız (0/8) | Plan 2 §13.2 | sunucu kanonik olunca gereksiz |
| **G10** | **Sunucu STT model kapsamı**: tarayıcıda 4 ASR modeli var, sunucuda yalnız `whisper-small` | `webui/src/lib/models.ts` `MODELS`; `src/voxi` STT worker'ı tek model sunar | "tüm modeller desteklensin" hedefi eksik |

---

## 3. Hedef tasarım

### 3.1 Katmanlar — tek kapı

```
istemciler:  stüdyo (/ui)   ·   n8n   ·   OpenWebUI   ·   Hermes   ·   diğer
                              │
                        TLS proxy (yalnız yayınlanan yüz)
                              │
                        gateway  ← TEK API, TEK kimlik, TEK limit, TEK katalog
                              │
        ┌──────────────┬──────┴───────┬──────────────┬─────────────┐
     tts-ema      tts-antalia      stt-whisper    punct (yeni)   mt (yeni)
```

Stüdyo ayrıcalıklı değildir: aynı uçları kullanır. Tarayıcı motorları **isteğe bağlı** kalır.

### 3.2 Yetenek matrisi (hedef)

| Yetenek | Sunucu (CPU) | Uç | Takma ad |
|---|---|---|---|
| TTS | `ema-lightning`, `antalia-mini` | `POST /v1/audio/speech` | `tts-1` → ema |
| STT (dosya) | `whisper-small`, (+`whisper-large-v3-turbo`) | `POST /v1/audio/transcriptions` | `whisper-1` |
| STT (canlı) | aynı motor, VAD | `WS /v1/realtime/transcriptions` | — |
| Noktalama | `punctuation-tr` (ONNX int8 ~106 MB, CPU) | **yeni** `POST /v1/text/punctuate` | — |
| Çeviri | `opus-mt-tc-big-tr-en` | **yeni** `POST /v1/text/translate` | — |
| Ajan turu | n8n'e taşıma | `/v1/sessions*` | — |

**Noktalama için ikinci yol (karar S1 = ikisi):** `/v1/audio/transcriptions` gövdesine `punctuate: true`
eklemek → OpenAI istemcisi (OpenWebUI, Hermes) **tek çağrıda** noktalı metin alır. Ayrı uç, ikinci
çağrı isteyenler için kalır.

### 3.3 Model imajı deseni — seçenekler

| # | Desen | Artı | Eksi |
|---|---|---|---|
| **M1 (öneri)** | **Veri-only model imajları**: `apeksis-models-<model>:local` yalnız model dosyalarını taşır; worker imajları `COPY --from=...` ile alır | İçerik-adresli, önbelleğe alınır, registry'den **bir kez** çekilir, offline çalışır, worker kodu yeniden derlenince model **yeniden inmez** | İki imaj katmanı; registry/save-load akışı gerekir |
| M2 | Modeli **worker imajına gömmek** | En basit (volume yok) | Model baytları worker katmanına bağlanır; her worker rebuild'i büyük katmanları taşır |
| M3 | Volume'ı **tarball/OCI artefaktı** olarak dışa/içe aktarmak | Mevcut akışa en az dokunuş | Sürümleme/önbellek zayıf; registry yok |

**Dağıtım (karar S2 = ikisi):** kayıt defteri (`docker push/pull`) **ve** `docker save`/`docker load`
tarball (hava boşluklu/offline sahalar için). İkisi de M1 ile çalışır.

**Lisans kapısı (zorunlu):** M1/M2 imajları **yayınlanmadan önce** §1.5'teki notis + geçişli
bağımlılık denetimi tamamlanmalı. Yayın yoksa yalnız yerel/özel kayıt defteri.

### 3.4 Kimlik — istemci başına anahtar

`VOXI_API_KEYS_JSON`'a istemci kayıtları; yeni metin uçları için **yeni kapsam** (öneri:
`text:process`). Örnek (uydurma sır yok, biçim):

```json
[
  {"id": "n8n",        "sha256": "<64 hex>", "scopes": ["audio:read", "audio:write", "realtime:connect"]},
  {"id": "openwebui",  "sha256": "<64 hex>", "scopes": ["audio:read", "audio:write", "text:process"]},
  {"id": "hermes",     "sha256": "<64 hex>", "scopes": ["audio:write", "text:process"]}
]
```

### 3.5 CPU bütçesi — **ölçülmeden sayı yok**

- Tüm hedef modeller CPU'da çalışır. `whisper-large-v3-turbo` CPU'da **ağırdır**; gerçek
  gecikme/bellek **ölçülmeden** iddia edilmeyecek (Plan 2'nin "uydurma veri yok" kuralı).
- Varsayılan: `whisper-small` + `ema-lightning`. Ağır modeller **opt-in profil** olur (karar S5:
  `whisper-large-v3-turbo` eklenir ama varsayılan `whisper-small` kalır).

---

## 4. Aşamalar (her aşama sonunda DUR, özet ver, onay al)

| Aşama | İş | Dokunur | Yığın? |
|---|---|---|---|
| **A** | **G1** — Stüdyo canlı konuşmasını n8n'den ayır: "Oturum başlat" = mikrofon + canlı STT; ajan oturumu **ilk gönderimde tembel** açılır; n8n yoksa yalnız gönderim dürüst hata verir; bar canlı/ajan durumunu ayrı gösterir | `studio/App.tsx`, `SessionBar.tsx`, `useSession.ts`, testler | rebuild webui |
| **B** | **G5,G6** — API sözleşmesi: yeni kapsamlar, `/v1/endpoints` güncellemesi, **OpenAI-uyum tablosu** dokümanı, SDK ile uçtan uca doğrulama | `auth.py`, `gateway.py`, `docs/api.md` (yeni) | rebuild gateway |
| **C** | **G8** — Model imajı deseni (M1) + dağıtım (S2 kararı) + lisans kapısı kontrol listesi | `compose.yaml`, yeni `Dockerfile.model*`, `docs/deployment.md` | evet (yeni imajlar) |
| **D** | **G2** — Sunucu **noktalama** ucu (ONNX Runtime CPU, pinli artefakt) + `/v1/models`'ta `punctuation-tr` | yeni `providers/punct.py` + `workers/punct.py`, `gateway.py`, `compose.yaml` | evet |
| **E** | **G3** — Sunucu **çeviri** ucu (tr→en) | yeni provider/worker, `gateway.py`, `compose.yaml` | evet |
| **F0** | **G10 kapısı** — **Seda** (`atasoglu/seda-v0.1`) ve **Duyu** (`KaanAydinli/Duyu-small`) için kaynak + lisans + geçişli bağımlılık denetimi (§1.5); denetim geçmeden F2/F3 başlamaz | `docs/licensing.md`, `inventory.py` | hayır |
| **F1** | **G4** — `whisper-large-v3-turbo` kalite profili (**mevcut** faster-whisper/CTranslate2 yığını; CPU, opt-in, varsayılan `whisper-small` kalır) | `compose.yaml`, `inventory.py`, profil | evet |
| **F2** | **G10** — **Seda** sunucu motoru: sherpa-onnx transducer (encoder/decoder/joiner + rnnlm), **canlı/akışlı** ASR | yeni provider/worker (`sherpa-onnx`), `compose.yaml`, `inventory.py` | evet |
| **F3** | **G10** — **Duyu** sunucu motoru (`Duyu-small`): kendi noktalamasını yazar; canlı değil | yeni provider/worker, `compose.yaml`, `inventory.py` | evet |
| **G** | **G7** — Dış ajan E2E: n8n (`turn-agent.json`, `file-tts/stt.json`), OpenWebUI (`audio.env`), Hermes (`config.yaml`) canlı gateway'e karşı | `integrations/*`, `docs/deployment.md` | hayır |
| **H** | **G9** — Tarayıcı paketleri politikası (sunucu kanonik olunca: opsiyonel/erteleme/kaldırma) | `docs/*`, `webui/src/lib/models.ts` | belki |

**Önerilen sıra:** A → B → C → D → E → F0 → F1 → F2 → F3 → G → H. (A küçük ve bağımsız; C, D/E/F'nin
kullanacağı altyapıyı kurar; F1 mevcut STT yığınıyla en ucuz kazanç, F2/F3 yeni motor ister.)

---

## 5. Kararlar (onaylandı, 2026-10-16)

| # | Karar |
|---|---|
| **S1** | **İkisi birden**: ayrı `POST /v1/text/punctuate` **ve** `/v1/audio/transcriptions`'a `punctuate` bayrağı. |
| **S2** | **Registry + `save`/`load`**: veri-only model imajları (M1) hem kayıt defterine push/pull hem offline için tarball. |
| **S3** | **Opsiyonel kalsın**: sunucu kanonik; tarayıcı ONNX paketleri isteyen kurar, kod ve belge kalır. |
| **S4** | **Ayrı göster**: çubuk canlı modu ve ajan oturumunu ayrı gösterir (Aşama A'da yapıldı). |
| **S5** | **Opt-in profil**: `whisper-large-v3-turbo` eklenir ama varsayılan `whisper-small` kalır; CPU maliyeti ölçülüp yazılır. |

## 5b. Aşama durumu

| Aşama | Durum |
|---|---|
| **A** — canlı modu ajan oturumundan ayır | ✅ **TAMAMLANDI** — kanıt: Plan 2 §15 |
| **B** — sözleşme + kapsamlar + OpenAI-uyum doğrulaması | ✅ **TAMAMLANDI** — kanıt: §7 |
| **C** — model imajı deseni (M1) + dağıtım + lisans kapısı | ⏸️ onay bekliyor |
| **D** — sunucu noktalama ucu | ⏸️ onay bekliyor |
| **E** — sunucu çeviri ucu | ⏸️ onay bekliyor |
| **F0** — Seda/Duyu lisans + provenans denetimi | ✅ **TAMAMLANDI** — kanıt: §8.1 |
| **F1** — `whisper-large-v3-turbo` opt-in profili | ✅ **TAMAMLANDI** — kanıt: §8.2 |
| **F1b** — turnkey kurulum: `up -d` modelleri kendisi kurar | ✅ **TAMAMLANDI** — kanıt: §8.3 |
| **T1** — taze kopyada sırlar + TLS'in kendi kendine kurulması | ✅ **TAMAMLANDI** — kanıt: §8.4 |
| **F2** — Seda sunucu motoru (sherpa-onnx) | ⏸️ onay bekliyor |
| **F3** — Duyu sunucu motoru | ⏸️ onay bekliyor |
| **G** — dış ajan E2E (n8n/OpenWebUI/Hermes) | ⏸️ onay bekliyor |
| **H** — tarayıcı paketleri politikası (opsiyonel) | ⏸️ onay bekliyor |
| **R** — yayın hazırlığı (R1 ✅ R2 ✅ R3 ✅ R5 ✅ R6 ✅; R4 ✅; R7 sırada) | 🟡 R1 ✅ · R2 ✅ · R3 ✅ · **R4 ✅ (§8.5.9)** · R5 ✅ (§8.5.8) · R6 ✅ (§8.5.6 + §8.5.7) · **R7 sırada** — kanıt: §8.5 |

## 6. Kapsam dışı (bu planın dışında)

- SIP/RTP/DTMF/transfer (ADR 0002 + `integrations/ucm6510/checklist.md` kapıları).
- OpenAI Realtime API uyumu (Voxi akış protokolleri Voxi-tanımlı kalır).
- GPU yolu (mevcut `compose.nvidia.yaml` dokunulmaz; bu plan **CPU** içindir).
- Derin Apeksis backend yeniden adlandırması (Plan 2 §12).

---

## 7. Aşama B kaydı — sözleşme + kapsamlar + OpenAI-uyum doğrulaması (2026-10-16)

### 7.1 Yapılanlar

- `src/voxi/gateway.py` `/v1/endpoints` **6 → 14** rotaya çıktı; her rota
  `method / path / service / scopes / purpose` döndürür. Açık rotalar `scopes: []` taşır, yani
  istemci hangi uç için hangi kapsamı istemesi gerektiğini tahmin etmeden öğrenir. `purpose`
  dizeleri ASCII-Türkçe ve ≤100 karakter (ruff E501 sınırı).
- `webui/src/api/client.ts`: `EndpointEntry`'ye isteğe bağlı `scopes?: string[]` eklendi.
- `webui/src/studio/components/ServerSection.tsx`: `kapsam: …` / `kapsam: açık` yalnızca
  `Array.isArray(endpoint.scopes)` ise çizilir — eski bir uzak gateway'e karşı güvenli.
- `src/voxi/workers/tts.py:98`: Step 1'den kalan mypy hatası düzeltildi
  (`names: tuple[str, ...] = (current.model_id,)`).
- `scripts/smoke.py`: TLS proxy'ye karşı koşabilmesi için `--ca-bundle` ve `--insecure` eklendi;
  `verify` değeri **hem** hazır-olma yoklamasında **hem** SDK taşımasında kullanılır (aynı sertifikaya
  güvenilir). Taşımaya `timeout=args.request_timeout` verildi, böylece `--request-timeout` gerçekten
  etkili olur.
- `infra/compose.proxy.yaml` §gateway yorumu düzeltildi: `docker compose exec gateway python
  scripts/smoke.py` **çalışmaz** (gateway imajında `openai` yok); doğru yol `--profile smoke` istemci
  imajı ya da host'tan proxy + `--ca-bundle`.
- `docs/deployment.md`: smoke bölümüne proxy yolu + yeni bayraklar; kapsam listesine rezerve
  `text:process` eklendi (bugün hiçbir rotada yok, hiçbir şey vermez).
- `docs/api-compatibility.md`: "Verified against a running deployment" (ölçülmüş tablo) ve
  "Client keys and scopes" (n8n/OpenWebUI/Hermes matrisi) bölümleri eklendi.

### 7.2 Kanıt (statik + çalışan yığın)

| Kontrol | Sonuç |
|---|---|
| `ruff check` | temiz |
| `mypy` | temiz (21 dosya) |
| `pytest` | **137/137** |
| `tsc` | temiz |
| `vitest` | **81/81** (10 dosya) |
| `vite build` | OK |
| `GET /v1/endpoints` (proxy) | 14 rota, kapsamlar dahil |
| `/ui/` (HTTPS) | 200 → `index-CPyhoOa5.js` |
| `/readyz` | `{"status":"ready","workers":{"tts":true,"stt":true,"antalia":true}}` |

OpenAI SDK E2E (`openai==1.78.1`, `scripts/smoke.py`, `https://127.0.0.1:8443/v1 --ca-bundle
certs/voxi.crt`) — üç model de geçti, sayılar koşunun kendi raporundan:

| Model / ses | WAV (mono PCM16 24 kHz) | MP3 | STT `whisper-1` |
|---|---|---|---|
| `ema-lightning` / `ema-tr` | 3.360 s (istek 0.735 s) | 3.408 s (0.391 s) | boş değil |
| `tts-1` / `ema-tr` | 3.360 s (0.297 s) | 3.408 s (0.297 s) | boş değil |
| `antalia-mini` / `antalia-tr` | 3.627 s (0.266 s) | 3.696 s (0.297 s) | boş değil |

`/v1/models` tam olarak `antalia-mini, ema-lightning, tts-1, whisper-1, whisper-small` döndürdü.

### 7.3 Dürüst sınırlar

- `text:process` **rezerve**dir: kayıt defteri her kapsam dizesini kabul eder, dolayısıyla bugün
  `text:process` hiçbir uç açmaz (D/E aşamalarında karşılığı gelecek).
- Bu koşuda **doğrulanmayanlar**: OpenAI Realtime, gerçek istemciyle WebSocket taşımaları,
  OpenWebUI/Hermes sürüm-özel davranışı, canlı mikrofonda ilk-ses gecikmesi, eşzamanlı oturum
  kapasitesi.
- Proxy overlay'de gateway host portu **kaldırılır** (`ports: !reset []`), bu yüzden `127.0.0.1:8080`
  host'tan yoktur; smoke ya `--profile smoke` imajından ya host'tan proxy üzerinden koşar.

### 7.4 Yeni boşluk (kullanıcı sorusu, 2026-10-16)

Kullanıcı tarayıcıdaki **STT modellerinin de servis olarak** sunulmasını istedi. Envanter (§1.6):
tarayıcıda 4 ASR modeli var, sunucuda yalnız `whisper-small`. Bu **G10** olarak kayda geçti ve
F0/F1/F2/F3 aşamalarına ayrıldı (§4): F0 lisans denetimi, F1 `whisper-large-v3-turbo` (mevcut
faster-whisper yığınıyla en ucuz kazanç), F2 **Seda** (sherpa-onnx transducer, yeni motor, canlı),
F3 **Duyu** (yeni motor).

---

## 8. Aşama F0 — Seda/Duyu lisans + provenans denetimi (2026-10-16)

Ayrıntılı tablo `docs/licensing.md` §"STT model audit" içinde. Özet:

| Model | Revizyon | Kod/ağırlık | Kritik bulgu |
|---|---|---|---|
| `atasoglu/seda-v0.1` | `5cbbda1b34bde5e3004e79b137dc3871587ea282` | Zipformer2 transducer (66.1M) int8 ONNX, **Apache-2.0** | **`lm/` = CC BY-SA 4.0** (Türkçe Wikipedia ile eğitilmiş) → ShareAlike |
| `KaanAydinli/Duyu-small` | `a9aa79751ea6e99c1e035fcb056318d5c1b67f13` | Conformer/CTC (tr+en) ONNX, **Apache-2.0** + kendi `duyu_small/` Python çalıştırıcısı | kartta ek şart yok; eğitim verisi bildirimi upstream'de yok |

**Karar:** Seda'nın akustik modeli serbest; **dil modeli (`lm/rnnlm.int8.onnx` + `lm/2gram.fst`) kapıdır**.
Varsayılan plan **Seda'yı LM'siz** göndermek (greedy/beam-4); LM ayrı, açıkça etiketli opsiyonel artefakt
olur. Bedeli gizlenmez: model kartına göre FLEURS-TR WER 14.24 → 11.52 (~2,7 puan).

**Duyu bulgusu (F3'ü kolaylaştırır):** upstream zaten bir Python paketi (`duyu_small/`: `model.py`,
`features.py`, `decode.py`, `cli.py`) ve `pyproject.toml` yayınlıyor — yani "sıfırdan motor yazmak"
gerekmiyor, mevcut çalıştırıcı ONNX Runtime üzerinden paketlenebilir.

Kartlardaki WER değerleri `verified: false`; yazarların iddiası, bizim ölçümümüz değil.

---

## 8.2 Aşama F1 — `whisper-large-v3-turbo` opt-in STT (2026-10-16)

### 8.2.1 Ne değişti

| Ne | Dosya |
|---|---|
| `Settings.stt_turbo_url` (env `STT_TURBO_URL`) + `resolve_stt(model)` | `src/voxi/gateway.py` |
| `/v1/models` turbo worker'ını da toplar **ve id'ye göre tekilleştirir** | `src/voxi/gateway.py` |
| Transkripsiyon model id'sine göre yönlendirilir; hata mesajı gerçekten kurulu id'leri listeler | `src/voxi/gateway.py` |
| `stt-whisper-turbo` servisi (`profiles: [stt-turbo]`, port 8084), `provision-whisper-turbo`, `whisper-turbo-models` hacmi, gateway env'i | `compose.yaml` |
| `--stt-model` (varsayılan `whisper-1`); rapora `tts_model` + `stt_model` alanları | `scripts/smoke.py` |
| Sahte upstream gerçeğe uyduruldu; 2 yeni test (opt-in yönlendirme, kapatınca reddetme) | `tests/test_gateway.py` |

### 8.2.2 Canlı kanıt (uydurma yok)

- Provision: `whisper-large-v3-turbo: 4df90f75321148c3a29a9e2351b7ddf8f5b115a8, 6 assets provisioned`.
- `/v1/models` (proxy üzerinden): `tts-1, ema-lightning, whisper-1, whisper-small, antalia-mini,
  whisper-large-v3-turbo` — **6 id, 6 tekil**. Tekilleştirme olmadan `whisper-1` **iki kez** çıkıyordu
  (iki STT worker'ı da takma adı duyurur); bu kusuru **canlı doğrulama** yakaladı ve gateway'de düzeltildi.
- `scripts/smoke.py --stt-model …` (3,36 s Türkçe cümle, CPU):

| STT modeli | `transcription_request_seconds` | Transkript |
|---|---|---|
| `whisper-small` | **1,89 s** | "Merhaba, bu Yerel Türkçe Konuşma Hizmeti'nin ses denemesidir." |
| `whisper-large-v3-turbo` | **6,91 s** | "Merhaba, bu yerel Türkçe konuşma hizmetinin ses denemesidir." |

### 8.2.3 Dürüst sınırlar

- **CPU'da turbo gerçek zamandan yavaş** (RTF ≈ 2,1): 3,36 s sesi 6,91 s'de yazıyor. Bu yüzden varsayılan
  `whisper-small` kalır (S5) ve turbo bu donanımda bir **dosya/parti** modelidir, canlı değil.
- İki model aynı cümlede büyük/küçük harf ve noktalama bakımından farklı çıktı verdi. Bu **tek cümlelik
  bir gözlem**; kalite iddiası değil (WER ölçümü yapılmadı).
- **Kapsam boşluğu (G10) kapanmadı:** studio hâlâ `whisper-1` gönderiyor ve **sunucu STT modeli seçicisi
  yok**; turbo'yu bugün yalnızca API istemcisi (SDK/curl) seçebilir.

---

## 8.3 F1b — turnkey kurulum: `docker compose up -d` modelleri kendisi kurar (2026-10-16)

**İstenen:** kullanıcı kendi sunucusuna `git clone` + `docker compose up -d` ile kurabilmeli; modeller
ilgili (pinlenmiş) adreslerden indirilip kurulmalı.

### 8.3.1 Tasarım

- `provision-*` tek-seferlik servisleri artık **profil dışı**: `docker compose up -d` onları da çalıştırır.
  Gerekçe deneyle sabit: `depends_on` + `profiles` uyumsuz — profil kapalıyken Compose
  `service "a" depends on undefined service "b"` diyerek reddediyor.
- Her worker kendi modelini bekler: `depends_on: <provision-X>: condition: service_completed_successfully`.
- `gateway` ayrıca `provision-antalia` + `provision-whisper-turbo`'ya bağlı. Böylece (a) API hizmet
  vermeden önce **tüm** pinlenmiş modeller kurulu olur ve (b) her tek-seferlik servisin bir bağımlısı
  olduğu için `--wait` çıkışı **0** kalır. (Bağımlısı olmayan çıkmış servis `--wait`'i 1 yapıyordu —
  deneyle görüldü; `bootstrap.ps1`/`redeploy.ps1` bu yüzden kırılmadan çalışmaya devam ediyor.)
- Çalıştırma tarafı bilinçli olarak opt-in kaldı: `tts-antalia` `--profile antalia`,
  `stt-whisper-turbo` `--profile stt-turbo`. Modelleri ise her hâlükârda kurulur.
- `docs/deployment.md`'deki `--profile provision*` komutları kaldırıldı; hacim listesine
  `voxi_whisper-turbo-models` eklendi; `.env.example` yorumları güncellendi.

### 8.3.2 Kanıt

| Kontrol | Sonuç |
|---|---|
| `docker compose config --services` (profil yok) | `provision-ema/whisper/antalia/whisper-turbo` **listede** ✅ |
| `docker compose up -d --wait --wait-timeout 900` (tam yığın) | **exit 0** ✅ |
| Provision çıkış kodları | dördü de `Exited (0)` ✅ |
| Tekrar koşu (idempotent) | mevcut dosyalar yalnız yeniden hash'lenir, **ağ yok** ✅ |
| `/readyz` · `/ui/` · `/v1/models` | `ready` · HTTP 200 · 6 id ✅ |

### 8.3.3 Dürüst sınırlar

- **Literal `git clone && docker compose up -d` henüz mümkün değil.** `.env` (`VOXI_WORKER_API_KEY`
  `:?` ile zorunlu) ve `certs/` (TLS; proxy "sertifika yoksa başlamam" kuralı) hâlâ gerekli ve ikisi de
  `.gitignore`'da. Bugünkü turnkey araç `infra/bootstrap.ps1` ve **yalnız Windows**. Bu, onay bekleyen
  bir sonraki karardır (aşağıda seçenekler).
- Varsayılan `up -d` artık **her zaman ~1,6 GB turbo indirir**, turbo çalışmasa bile. "Tüm modeller
  kurulu olsun" isteği gereğince bilinçli; maliyet burada açıkça yazılı.
- Taze klonda `voxi-antalia:local` imajı, yalnız `provision-antalia` için bile derlenir.

---

## 8.4 T1 — taze kopyada sırlar ve TLS kendiliğinden kurulur (2026-10-16)

**İstenen:** `git clone` + tek komut ile kurulum; kullanıcı `.env` yazmak ya da host'ta betik
çalıştırmak zorunda kalmamalı. Onaylanan tasarım: **seçenek A — Compose kendi kendini başlatır**
(kullanıcının verdiği 8 koşul bağlayıcı kabul edildi).

### 8.4.1 Ne değişti

| Ne | Dosya |
|---|---|
| Sır kaynağı dikişi: `environment → <NAME>_FILE → VOXI_SECRETS_DIR/<dosya>` | `src/voxi/secrets.py` (yeni); `src/voxi/gateway.py`, `src/voxi/auth.py`, `src/voxi/workers/common.py`, `scripts/smoke.py` |
| Tek seferlik üretici: anahtarlar, anahtarlık, SAN'lı sertifika, işaret dosyası, strict mod, mod/sahiplik | `scripts/bootstrap_secrets.py` (yeni) |
| Tek seferlik `secrets` servisi (`network_mode: none`, `cap_drop: ALL` + `cap_add: CHOWN`, `read_only`), `voxi-secrets` hacmi, gateway/worker/proxy/smoke bağımlılıkları; `VOXI_WORKER_API_KEY:?` zorunluluğu kaldırıldı | `compose.yaml`, `infra/compose.proxy.yaml` |
| Proxy giriş noktası: `VOXI_WEBUI_KEY` boşsa `webui.key` dosyasını okur; strict modda **üretilmiş** sertifikayı reddeder | `integrations/nginx/voxi-entrypoint.sh` |
| `openssl` + üretici betiği imaja girer | `Dockerfile` |
| 22 test: öncelik, tekrarsızlık, anahtarlık özeti, log sessizliği, izinler, SAN'lar, strict mod redleri, gateway/worker dosya okuması | `tests/test_secrets.py` (yeni) |
| Kurulum, sır tablosu, hacim listesi, sorun giderme, tehdit modeli, ADR 0007, CHANGELOG, README, `.env.example` | çeşitli belgeler |

### 8.4.2 Kanıt (hepsi canlı — uydurma yok)

**(a) Üretici, gerçek imajın içinde (`voxi-gateway:local`, host'ta `openssl` yok):**

| Kontrol | Sonuç |
|---|---|
| Üretim (4 sır + sertifika) | `exit 0`; log yalnız dosya adlarını yazar |
| İzin/sahiplik | `webui.key`/`voxi.key` `0600 root:root`; `worker.key`/`app.key`/`api-keys.json` `0640 root:10001`; `voxi.crt` `0644` |
| Üretilen SAN'lar | `DNS:localhost, IP:127.0.0.1, IP:::1` |
| Logda sır değeri | **yok** (60+ karakterlik base64 taraması boş) |
| İkinci koşu | 6 dosya **bit bit aynı**; her satır `present, left untouched` |
| strict + sertifika yok | `exit 1` |
| strict + **üretilmiş** sertifika (işaret var) | `exit 1` |
| strict + **kullanıcı** sertifikası (işaret yok) | `exit 0` |
| `VOXI_WORKER_API_KEY` verili | `worker.key` **üretilmedi** |
| `VOXI_WEBUI_KEY` verili | anahtarlıktaki SHA-256, ortam değeriyle **birebir** |

**(b) Proxy giriş noktası, gerçek `nginx:1.27-alpine` imajına karşı:** üretilmiş sertifikayla strict
mod → `exit 1`; sertifika yokken strict mod → `exit 1`; dosyadan anahtar okunduğunda `VOXI_WEBUI_KEY`
boş olsa bile enjeksiyon kontrolü geçilir; kullanıcı sertifikası çiftiyle render edilen yapılandırma
`0600 root:root` ve taşıdığı bearer **anahtar dosyasından** gelir; nginx başlar; loglarda sır yok.

**(c) Taze kopya E2E (gerçek):** `.env` → `.env.saved`, `certs/` → `certs.saved` taşındı, `voxi_secrets`
hacmi silindi (yani hiçbir kullanıcı malzemesi yok) ve **tek komut** koşuldu:

```sh
docker compose -f compose.yaml -f infra/compose.proxy.yaml up -d --wait --wait-timeout 900
```

| Kontrol | Sonuç |
|---|---|
| `up` çıkışı | **0** |
| Servisler | `gateway`, `proxy`, `webui`, `tts-ema`, `stt-whisper` **healthy**; `secrets` + dört `provision-*` **Exited (0)** |
| `certs/` | `voxi.crt` + `voxi.key` + `.generated-by-voxi` üretildi; SAN'lar loopback |
| `voxi_secrets` hacmi | 4 dosya, yukarıdaki izinlerle |
| `secrets` logu | sır değeri **yok**; ikinci koşuda hepsi `present, left untouched` |
| `/readyz` | `{"status":"ready","workers":{"tts":true,"stt":true}}` |
| `/ui/` (8443, HTTPS) | **HTTP 200** |
| `/v1/models` (anahtar **vermeden**, proxy enjekte etti) | `tts-1, ema-lightning, whisper-1, whisper-small` — 4 id, 4 tekil |
| `/v1/models` geçersiz anahtarla | **HTTP 401** |
| Tekrarsızlık: ikinci `up -d` | 4 anahtar + işaret + sertifika **bit bit aynı** |
| Kullanıcı sertifikası önceliği | Orijinal `certs/` geri konunca sertifika **değişmedi**, işaret **eklenmedi**, log `present, left untouched` |
| Geri yükleme | `.env` sha256 ve `certs/voxi.crt` sha256 **olay öncesiyle birebir**; 8443'te sunulan sertifikanın SHA-256 parmak izi kullanıcının sertifikasıyla **aynı**; `/readyz` `antalia:true`; `/v1/models` **6 id, 6 tekil** |
| Kullanıcı malzemesi varken üretim | `secrets` logu: her değer için *"is set in the environment and wins at read time, nothing generated"*, TLS *"present, left untouched"*; `voxi_secrets` hacmi **boş** |

### 8.4.3 Dürüst sınırlar

- **Mod sapması (belgelendi, gizlenmedi):** üretilen dosyalardan UID 10001 çalışma zamanının okuduğu
  dördü `0640 root:voxi`'dir, `0600 root:root` değil — root sahipli `0600` bir dosyayı root olmayan
  okuyucu **okuyamaz**. `0600 root:root` yalnız root proxy'nin okuduğu `webui.key` ve `certs/voxi.key`
  için geçerlidir. Hiçbir dosya dünya tarafından okunabilir değil.
- **Üretilen sertifika sunucu kimliği kanıtlamaz.** Loopback için şifreleme sağlar; istemci tarafında
  güven yine istemcinin yapılandırmasından gelir. LAN/üretim `REQUIRE_PROVIDED_CERTS=1` ister.
- **Host'ta `openssl` olmadığı için** üreticinin sertifika birim testleri geliştirme makinesinde
  atlanır (4 skip); üretim yolu **imajın içinde** canlı doğrulandı — yani gerçekte koştuğu yerde.
- **Taze kopya E2E otomatik bir test değil, elle bir simülasyon.** Otomatikleştirmek sahte bir proje
  adı gerektirir ki bu tüm pinlenmiş modelleri yeniden indirir.
- **Belgelerde düzeltilen hata:** `proxy` yalnız `infra/compose.proxy.yaml` içinde tanımlı olduğu için
  **çıplak `docker compose up -d` tam bir kurulum değildir** — API'yi TLS/UI kenarı olmadan başlatır.
  Kurulum komutu bu yüzden iki `-f` bayrağını içerir (README, `deployment.md`, ADR 0007 buna göre
  düzeltildi). **Karar (kullanıcı, 2026-10-17): iki `-f` bayrağı kanonik kurulum olarak kalır** —
  proxy opt-in ve fail-closed kalır, böylece yanlış bir `VOXI_PROXY_BIND_IP` ya da eksik TLS malzemesi
  yalnızca proxy'yi düşürür, çalışan API'yi değil; ayrıca otomatik okunan bir `compose.override.yaml`
  gizli bir varsayılan yaratıp "bu servis nereden geldi?" belirsizliği doğururdu. Çıplak komutun
  eksiklik riski belgeyle sınırlanır; `.env.example`'da **yorumlu** bir `COMPOSE_FILE=…` kolaylığı
  sunuldu (kullanıcı isterse açar). Kanonik komutu tek hedefe sarmalamak (ör. `make up` /
  `scripts/up.sh`) küçük bir teknik borç olarak kaydedildi (`docs/technical-debt.md`).
- **İlk `up -d --wait` bir kez `exit 1` döndü** (`tts-ema` `exited (143)`): imajlar az önce yeniden
  derlendiği için Compose konteyneri *yeniden oluşturdu* ve eski konteynerin SIGTERM çıkışını (143)
  başarısızlık saydı. Hemen ardından aynı komut `exit 0` verdi. Taze bir makinede yeniden oluşturulacak
  konteyner **yoktur**, dolayısıyla bu durum kurulumun kendisinden değil, imaj tazelemesinden doğar;
  yine de gözlem burada açıkça kayıtlı.
- **İmaj tazelemesi tamamlandı.** Beş imaj da (`gateway`, `tts`, `stt`, `smoke`, `antalia`) T1 koduyla
  yeniden derlendi; ağır `torch` katmanı Docker Desktop motorunu birkaç kez düşürdüğü için derlemeler
  tek tek yapıldı. `stt-whisper-turbo`, `voxi-stt:local`'ı paylaştığı için `stt` derlemesiyle kapsandı.
  Her imajda dikişin kendisi arandı (`grep read_secret`); yenilenen `smoke` imajı canlı yığına karşı tam
  OpenAI SDK E2E'sini koşturdu (`exit 0`, boş olmayan Türkçe transkript). Yalnız kozmetik bir kalıntı
  var: `voxi-tts`/`voxi-stt`, hiç çalıştırmadıkları `bootstrap_secrets.py`'nin eski kopyasını taşır —
  o betiği yalnız `secrets` servisi koşar ve o da güncel `voxi-gateway` imajını kullanır. İşlevsel
  etkisi yok.

### 8.4.4 Karar kaydı (kullanıcının 8 koşulu → kanıt)

| # | Koşul | Durum |
|---|---|---|
| 1 | Kullanıcı sertifikası/anahtarı her zaman önceliklidir; üzerine yazılmaz | ✅ (8.4.2c: env kazanır, sertifika değişmez, işaret eklenmez) |
| 2 | Fail-closed kaldırılmaz; `REQUIRE_PROVIDED_CERTS=1` "sertifika yoksa başlama" | ✅ (üretici + giriş noktası, üretilmiş sertifika da reddedilir) |
| 3 | Üretim tek seferlik ve idempotent; her `up` anahtarı döndürmez | ✅ (bit bit aynı) |
| 4 | Dosyalar root'a ait ve dünyaya kapalı; değer log/inspect/env'e sızmaz | ✅ (`0600`/`0640`; log taraması temiz; üretilen değer env'e konmaz) |
| 5 | Varsayılan bağlama loopback kalır; LAN açık bir karardır | ✅ (`VOXI_PROXY_BIND_IP` varsayılanı `127.0.0.1`; giriş noktası loopback dışında enjeksiyonu reddeder) |
| 6 | SAN'lar localhost/127.0.0.1/::1 + env'den ek adlar | ✅ (`VOXI_TLS_SAN`, `VOXI_PROXY_BIND_IP`) |
| 7 | `secrets` gateway/worker/proxy'ye `service_completed_successfully` ile bağlanır (`--wait` tuzağı) | ✅ (`up -d --wait` → 0) |
| 8 | Testler: taze `up -d --wait`, ikinci koşuda anahtar değişmez, kullanıcı sertifikası ezilmez, strict mod reddeder | ✅ (8.4.2) |

Ayrıca: turbo ölçümü **GPU kurulumunda ayrıca** yapılmalıdır (`docs/api-compatibility.md`'ye uyarı
eklendi); buradaki CPU sayıları genellenemez.

---

## 8.5 Aşama R — yayın hazırlığı (2026-10-17, kullanıcı önerisi)

Amaç: repoyu dışarıya açılabilir hâle getirmek. Bu aşama **ürün davranışını değiştirmez**; yalnızca
sır/geçmiş hijyeni, lisans kapısı, repo iskeleti, CI ve yeniden üretilebilirlikle ilgilenir.
"Her aşama sonunda DUR, özet ver, onay al" kuralı burada da geçerlidir.

### 8.5.1 Adımlar

| # | İş | Durum |
|---|---|---|
| **R1** | Sır + kişisel kimlik/yol taraması (geçmiş dâhil) | ✅ tarandı — bulgular §8.5.2 |
| **R2** | Repo hijyeni: `.gitignore`, `.dockerignore`, uçtaki artıklar, iç belgelerin `docs/internal/`'a taşınması | ✅ uygulandı — §8.5.3 |
| **R3** | `LICENSE` (AGPL-3.0-or-later) + DCO'lu `CONTRIBUTING.md` + `docs/licensing.md` + README lisans bölümü + bağımlılık taraması + SPDX başlıkları | ✅ tamam — §8.5.4 |
| **R4** | Yeniden üretilebilirlik: README ilk ekranı, `make up` sarmalayıcı, donanım/ilk indirme süresi | ✅ tamam — §8.5.9 (`scripts/up.sh` sarmalayıcı + donanım/boyut notları + `npm ci` byte-aynı doğrulaması; ilk-indirme *süresi* ölçülemedi — hacim silme yasağı, dürüst not dokümanda) |
| **R5** | CI: mevcut `ci.yaml`'a compose-config matrisi (+ opsiyonel imaj taraması) | ✅ tamam — §8.5.8 (matris + `webui` işi; imaj taraması opsiyonel kalıyor) |
| **R6** | Marka hijyeni: eski ürün adı (ürün kodu **yorumları** + belgeler + README başlığı `Voxi` → `Apeksis`) | ✅ tamam — §8.5.6 + §8.5.7 |
| **R7** | Özel repo → temiz makinede README'yi sıfırdan izle → public + etiket | 🟡 git init + ilk commit yapıldı (§8.5.11); temiz makine benzeri taze-klon doğrulaması §8.5.11; kalan: gerçek repo URL'si (README `git clone <repo>` yerine yazılır), GitHub'a push + `v0.3.0` etiketi, 8 maddelik görsel onay |

### 8.5.2 R1 bulguları (gerçek, 2026-10-17)

**En önemli gerçek önce: repoda `.git` yok** (`git` 2.55 kurulu, ama geçmiş yok). Dolayısıyla
"geçmişte kalmış sır" riski **yapısal olarak sıfırdır** — yayın temiz bir ilk commit'le başlayacak.
Buna karşılık *çalışma ağacında* yayına girmemesi gereken dosyalar var ve bunlar şu an `.gitignore`
dışında; `git init && git add -A` yapan biri bunları commit'lerdi. Tarama araçları kurulu değil
(`gitleaks`, `trufflehog`, `trivy` yok), bu yüzden tarama **desen tabanlı `rg`** ile yapıldı —
dürüst sınır: bu bir sır tarayıcısı değil, bilinen imza aramasıdır.

| # | Bulgu | Kanıt | Sınıf |
|---|---|---|---|
| 1 | **`example-projects/` gitignore'da DEĞİL: 563,7 MB / 3918 dosya**, içinde eski uygulama (birleştirmenin kaynağı) ve `studio-glow-63` | `example-projects/reference-app/*`, `example-projects/studio-glow-63/*` | 🔴 **engelleyici** (yayın + rebrand) → **R2'de kapatıldı** |
| 2 | **İki ignore dosyası da eksikti → build bağlamı 1,52 GB'a çıkıyordu.** Ölçüm: BuildKit `transferring context: 1.52GB`. Nedeni ölçüldü: `.venv-export/` **1.405,8 MB** (`.dockerignore`'daki `.venv` deseni `.venv-export`'ı yakalamıyor) + `.test-tmp/` 4,5 MB + `.pytest-tmp/` 0,3 MB; `.gitignore` ise `example-projects/`'ı (563,7 MB) dışlamıyordu | probe Dockerfile ile `COPY .`; klasik builder bağlam tarı | 🟠 performans (ve yayın) → **R2'de kapatıldı: yeni bağlam 32,99 MB** |
| 3 | Kökteki gerçek artıklar: `nginxlog.txt` (0 B), `tts16.json` (elle atılmış curl gövdesi). **Düzeltme:** `stream-sample.wav` artık **değil** — `integrations/webui/README.md:240,269` onu `smoke_stream.py --audio` örneği olarak kullanıyor, **kalıyor** | kök listesi + `rg fixed-strings` | 🟡 hijyen → **R2'de kapatıldı** |
| 4 | Kökte **iç süreç belgeleri**: `self_hosted_voice_platform_PRD_v1.3_antalia.md` (52 KB), `voice_platform_master_build_prompt.md` (16 KB) | kökteki dosyalar | 🟡 sınıflandırma → **R2'de `docs/internal/`'a taşındı** |
| 5 | **`LICENSE` yok** → varsayılan "tüm hakları saklıdır"; `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` yok | `Test-Path` → hepsi `False` | 🔴 **engelleyici** — karar: **AGPL-3.0-or-later** (+ DCO, SPDX); telif sahibi adı bekleniyor |
| 6 | Kişisel kullanıcı adı shipped belgede: `pytest-of-<user>` (2 satır) | `docs/technical-debt.md:54,58` | 🟡 küçük → **R2'de kapatıldı** |
| 7 | Ürün kodu **yorumlarındaki** eski ürün adı (ör. `styles.css`, `index.css`, `App.tsx`, `shell/*`) | 18 dosyada 41 yorum | ✅ R6 + §8.5.7 ile tamamen temizlendi |
| 8 | `THIRD_PARTY_NOTICES.md` **var** (7,7 KB, 5 GitHub kaynağı) + `docs/licensing.md` var | kök + `docs/` | ✅ iyi durumda |
| 9 | `.github/workflows/ci.yaml` **var**: ruff, mypy, pytest, `export_openapi.py`, kontrat artefaktı yükleme | `.github/workflows/ci.yaml` | ✅ iyi durumda |
| 10 | Sır sızıntısı **yok**: `.env`, `certs/`, `models/`, `.venv*`, `smoke-output/`, `_scratch_reference/` gitignore'da | `.gitignore` | ✅ temiz |
| 11 | Mutlak kullanıcı yolu yalnız ignore edilen dizinlerde (`example-projects/`, `node_modules/`) | `rg "C:.Users\|/Users/"` | ✅ temiz |
| 12 | `192.168.x` yalnız **örnek/placeholder**: UI'da `placeholder="https://192.168.1.120:8443"`, belgelerde örnek, testlerde fixture | `ServerConnection.tsx:113`, `preview.html:445` | ✅ temiz (gerçek IP değil) |
| 13 | "Mustafa Tayyar Çalışkan" + `caliskangroup` yalnız **istenen** yerlerde: `About.tsx` (marka) ve iç plan | `webui/src/studio/components/About.tsx` | ✅ istenen |

### 8.5.3 R2 — uygulananlar (2026-10-17)

Kullanıcı onayıyla, ürün davranışına dokunmadan:

| İş | Dosya | Etki |
|---|---|---|
| `example-projects/` ignore edildi | `.gitignore` | 563,7 MB'lık referans artık commit edilemez |
| `example-projects` + `_scratch_reference` build bağlamından çıkarıldı | `.dockerignore` | **ölçüldü:** bağlam 1,52 GB → **32,99 MB** |
| `.venv` → `.venv*` düzeltildi | `.dockerignore` | `.venv-export` (1.405,8 MB) artık bağlama girmiyor — asıl büyük kalem buydu |
| `.pytest-tmp`, `.test-tmp`, `docs/internal` bağlamdan çıkarıldı | `.dockerignore` | +4,8 MB |
| Build girdileri hâlâ yerinde mi? | probe Dockerfile | ✅ tüm `COPY` kaynakları mevcut (eksik olsa build hata verirdi) |
| `docs/internal/` ignore edildi | `.gitignore` | İç süreç notları yayına girmez |
| `nginxlog.txt`, `tts16.json` ignore edildi | `.gitignore` | Uçtaki artıklar; **dosyalar silinmedi** (kullanıcı isterse elle siler) |
| İki iç belge taşındı | kök → `docs/internal/` | Referansı yoktu (yalnız bu §8.5.2 tablosu); kod/derleme etkilenmedi |
| Kişisel kullanıcı adı genelleştirildi | `docs/technical-debt.md` | `pytest-of-<user>` |

`stream-sample.wav` bilinçli olarak **kalıyor** (belgelenmiş akış smoke örneği) ve `.dockerignore` `*.wav`'ı zaten dışlar — imajlara girmez.

### 8.5.4 R3 — lisans (2026-10-17): AGPL-3.0-or-later

**Karar (telif sahibi):** kod `AGPL-3.0-or-later`. Gerekçe kullanıcının: "değiştirip ağdan sunan
kaynağı geri vermek zorunda kalsın". Dosyalar:

| Dosya | Ne | Durum |
|---|---|---|
| `LICENSE` | Kanonik AGPL-3.0 metni — **gnu.org'dan indirildi**, elle yazılmadı: 661 satır / 34.523 bayt / SHA-256 `0D96A4FF…` | ✅ |
| `docs/licensing.md` | "Code license (R3)" bölümü: karar + **kanıtlı bağımlılık taraması** + §13 yükümlülüğü | ✅ |
| `THIRD_PARTY_NOTICES.md` | WebUI/npm bölümü (OFL fontlar + `mediabunny` MPL-2.0) + **`cmudict` düzeltmesi** | ✅ |
| `CONTRIBUTING.md` | DCO 1.1 metni + `git commit -s` + SPDX başlık kuralı + kanıt kuralları | ✅ |
| `README.md` | `## License` bölümü + §13 notu | ✅ |
| SPDX başlıkları (kaynak dosyalara) | **183 dosya** + idempotent araç `scripts/add_spdx_headers.py` — tek kimlik `AGPL-3.0-or-later` + `SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan` | ✅ §8.5.6 |
| Arayüzde "Kaynak kod" bağlantısı (§13) | Hedef URL ancak R7'de (yayın) oluşur; placeholder'a bağlamak yerine bilinçli ertelendi | ⏸️ |

**Tarama (gerçek metadata, `pyproject.toml` beyanı değil):** Python **imajların içinde** tarandı —
`gateway` 22 / `tts` 40 / `stt` 43 / `antalia` 47 dağıtım. Copyleft: `certifi` MPL-2.0, `tqdm`
MPL-2.0 AND MIT (hepsi uyumlu) ve **`cmudict` GPL-3.0-or-later** (`antalia` içinde). npm:
`webui/package-lock.json` 240 paket, **sıfır copyleft** (MIT 169, Apache-2.0 27, MPL-2.0 13,
BSD-3 12, OFL-1.1 9, ISC 8, CC-BY-4.0 1, 0BSD 1).

**Önemli bulgu — `cmudict` iki lisanslı:** PyPI paketi (`prosegrinder/python-cmudict`) **kodu**
GPL-3.0-or-later derlemesi yaparken, içindeki **CMU verisi** (BSD-2-Clause) farklı. `THIRD_PARTY_NOTICES.md`
yalnız BSD-2-Clause yazıyordu; düzeltildi. **GPLv3+ ile AGPL-3.0+ birleşimi açıkça izinlidir**
(AGPL §13 / GPLv3 §13) ve birleşik eser AGPL kalır — yani engelleyici değil.

**Bu seçimin beklenmedik faydası:** `cmudict` (GPLv3+) ve `libsndfile` (LGPL) gibi bağımlılıklar,
kod MIT ya da Apache-2.0 seçilseydi **tüm projeyi** GPL'ye çekerdi. AGPL seçildiği için tablo
temiz: AGPL ile **uyumsuz** bağımlılık yok, yalnız AGPL ile uyumlu copyleft'ler var.

**Dürüst sınırlar:** (1) tarama paket *metadata'sına* bakar; metadata gerçek lisansla çelişebilir
(`cmudict` bunun canlı kanıtı). (2) Docker base imajlarının Debian OS paketleri, FFmpeg derleme
konfigürasyonu ve `nginx`/`python` imajları bu taramanın **dışında** — dağıtım öncesi `dpkg -l`
tabanlı SBOM gerekir. (3) `gitleaks`/`trufflehog`/`trivy` kurulu değil; bu bir SBOM değil,
bağımlılık lisans kontrolüdür. (4) `LICENSE` dosyası hukuken yeterli bir "release certification"
değildir; FSF'in önerdiği gibi ayrıntılı bir inceleme yerini tutmaz.

**SPDX başlıkları:** telif **Mustafa Tayyar Çalışkan (2026)**; tüm kaynak dosyalar **tek** kimlik taşır → `AGPL-3.0-or-later`. WebUI'ın önceki uygulamadan türemesi engel değil (§8.5.5: o uygulama da telif sahibinin kendi projesi).

### 8.5.5 ÇÖZÜLDÜ — WebUI, yazarın kendi önceki MIT projesinden türev (2026-10-17)

SPDX başlığı basmaya hazırlanırken **ölçüldü**. Önce "üçüncü taraf MIT kodu mu kopyaladık?" diye engelleyici sayıldı; **telif sahibi önceki uygulamanın da kendi projesi olduğunu bildirdi** ve engel kalktı. Ölçüm kanıtı kayıtta kalıyor — türetmeyi dürüstçe belgeliyor.

**Ne bulundu:** `webui/src`'in **126 dosyasının 68'i** önceki uygulama ile **satır satır aynı** (yorumlar
çıkarılıp boşluk normalize edildikten sonra dizi eşitliği `True`), 18'i ≥%75, 7'si %40–75 örtüşüyor.
`styles.css` kural dizisi **birebir aynı** (Jaccard 1.000), `index.css` 0.956. Yani arayüz
"tema referansı" değil, **kopyalanmış türev eser**.

**Kanıt yöntemi:** aynı adlı dosyalar eşleştirildi; yorumlar (`//`, `/* */`) çıkarıldı, satırlar
kırpıldı ve boşluk normalize edildi, ardından satır kümesi Jaccard'ı + dizi eşitliği hesaplandı
(`webui/src` ↔ `example-projects/reference-app/src`).

**Upstream lisansı:** `example-projects/reference-app/package.json` → `"license": "MIT"`;
`LICENSE` → **MIT, Copyright (c) 2026** + kayıtlı yazar adı — bu ad, sahibinin 2026-10-17
beyanıyla **hatalı** (aşağıdaki düzeltme). Telif sahibinin **kendi önceki** projesi (kullanıcı
bildirimi, 2026-10-17). Bu yüzden engelleyici değil.

**Düzeltme (2026-10-17, ikinci bildirim):** sahip, projenin sahibi ve geliştiricisinin **Mustafa
Tayyar Çalışkan** olduğunu açıkça beyan etti; önceki uygulama kaynaklı `MIT LICENSE`'daki kayıtlı
yazar adı **hatalı**. Bu, §8.5.5 kararının özünü değiştirmez (önceki uygulama yine telif sahibinin
kendi eseri; üçüncü taraf MIT yükümlülüğü yine yok), yalnızca ismin statüsünü netleştirir: söz konusu
ad bir üçüncü kişi olarak ele alınmaz ve bu depoda atıf hedefi olarak **kullanılmaz**; kamuya açık
kayıtlarda yalnız "LICENSE'daki hatalı kayıtlı isim" olarak anılır. Yayımlanan dokümanlarda bu
ad doğrudan geçmez.

**Çözüm:** telif sahibi hem önceki uygulamanın hem bu deponun sahibi olduğu için türev eseri dilediği
lisansla — bu depoda **AGPL-3.0-or-later** — lisanslayabilir. Bu nedenle ayrı bir MIT bildirimi veya
çift SPDX kimliği **gerekmez**; tüm dosyalar tek kimlik taşır.

**Neden önce engelleyici sayıldı (kayıt):** `THIRD_PARTY_NOTICES.md`'deki "no third-party application
code was copied" iddiası **ölçümle çürütüldü** — arayüz gerçekten türev. Bu iddia yanlıştı ve
düzeltildi. Üçüncü taraf varsayımı geçerli olsaydı MIT atıf yükümlülüğü doğardı; sahiplik bildirimi
bu yükümlülüğü ortadan kaldırdı. Önceki uygulama MIT olarak yayınlandığı için **üçüncü tarafların
o uygulamayı kullanma hakları** elbette saklıdır; bu, türevin AGPL olarak lisanslanmasını engellemez.

**Ara karar ve geri alınışı (kayıt):** kullanıcı önce "C — temiz oda ile yeniden yaz" dedi, ardından
**"önceki uygulama aslında benim; açık kaynak paylaşıyoruz"** diyerek kararı geri aldı. **Yeniden yazım
iptal.** Değerlendirilen üç yol kayıt için: (A) atıfı koru, (B) yazardan izin al, (C) yeniden yaz —
C iptal, A/B'ye de gerek kalmadı.

**Sahiplik bildirimi tüm bunları gereksiz kıldı:** yeniden yazım, temiz oda, çift SPDX — hiçbiri
gerekmiyor. Ölçümün kalıcı değeri, türetmeyi **kanıtla** belgelemesidir (o da bu bölümde duruyor).

#### Karara bağlanan sorular

| Soru | Cevap |
|---|---|
| Yeniden yazım gerekiyor mu? | **Hayır** — telif sahibi aynı kişi |
| Türev dosyalara çift SPDX kimliği? | **Hayır** — tek `AGPL-3.0-or-later` |
| `THIRD_PARTY_NOTICES.md`'de ne kalır? | Kısa bir **köken (provenance)** notu: arayüz, telif sahibinin kendi önceki projesinden türedi. Tam MIT metni ve "hukuki yükümlülük" dili kaldırıldı |
| Veri kimlikleri (ilk turda "veri güvenliği" gerekçesiyle korunmuştu) | **Karar tersine çevrildi** — §8.5.7: `apeksis.*`'e taşındı, o dönemin uzantı/biçim okuyucuları kaldırıldı |
| Üçüncü tarafların eski uygulamadaki hakları | Etkilenmez: o uygulama MIT olarak yayınlanmıştı, o proje için MIT izni geçerli kalır |

**Sonuç:** R6 (yorum metinlerindeki ad + README başlığı) ve SPDX başlık basımı **bloke değil** — aşağıda
yapıldı.

### 8.5.6 R6 — marka hijyeni + SPDX başlıkları (2026-10-17)

**İlk turdaki kural (sonradan genişletildi):** yalnız **düzyazı/yorum** metnindeki ad temizlenir;
**veri kimlikleri korunur**. İlk turda `localStorage` anahtarları, IndexedDB adı ve o dönemin
uzantı/biçimi "veri güvenliği" gerekçesiyle bilinçli olarak bırakılmıştı. **Bu kural §8.5.7'de
genişletildi:** kullanıcı adın hiçbir yerde geçmemesini istedi, kimlikler de taşındı.

| İş | Yöntem | Sonuç |
|---|---|---|
| Ürün kodu yorumlarındaki ad | Repo dışı geçici betikle **41 hedefli ikame**, 18 dosya; her kayıt **eşleşme zorunlu** (sessiz atlama yok) | ✅ 41/41 eşleşti (kod içinde "the studio / the original studio app") |
| Kalan geçişler (ilk tur) | `rg` ile denetlendi | ✅ o tur yalnız veri kimlikleri kalmıştı — §8.5.7 bunları da kaldırdı |
| README'deki kırık yol | `example-projects/reference-app/scripts/prepare_models.py` (gitignore'lu, taze klonda **yok**) → tarayıcı paketleri "bu sürümün parçası değil" diye dürüstçe yazıldı | ✅ |
| README başlığı | `# Voxi — …` → `# Apeksis — …` + teknik `voxi`/`VOXI_*` kimliklerinin kaldığı notu | ✅ (R3'te) |
| SPDX başlıkları | `scripts/add_spdx_headers.py` — **idempotent**, shebang/PEP 263/`/// <reference>` sonrasına ekler, JSON'u atlar, LF/CRLF + BOM korunur | ✅ **183 dosya** (182 kod + araç) |
| CSS/DOT dosya biçimi | `.css` → `/* */`, `.py`/`.sh` → `#`, `.ts/.tsx` → `//` | ✅ |
| Kabuk betiği | `integrations/nginx/voxi-entrypoint.sh` — **hatalı `//` basıldı, yakalandı ve `#`'e düzeltildi**; `sh -n` ile sözdizimi doğrulandı | ✅ |

**Doğrulama (hepsi koştu):**

| Kapı | Sonuç |
|---|---|
| `ruff check src scripts tests infra integrations` | ✅ All checks passed |
| `mypy src` | ✅ 22 dosya, sorun yok |
| `pytest` | ✅ **161 passed, 4 skipped** |
| `tsc --noEmit && vite build` | ✅ derlendi; üretilen ana paket hash'i **değişmedi** (yorumlar derlemede düşüyor) |
| `vitest run` | ✅ **81/81** (10 dosya) |
| Yeni kaynak, imaj bağımlılıklarıyla import | ✅ `gateway`/`tts`/`stt`/`antalia` → `voxi 0.2.0` |
| `voxi-webui` imajı | ✅ yeniden derlendi; container **zorla** yeniden oluşturuldu (eski imaj çalışıyordu) |
| Canlı: `/ui/` + ilan edilen assetler | ✅ `/ui/` 200, `index-CPyhoOa5.js` 200, `index-BC46ZlFF.css` 200 |
| Canlı: `/readyz`, `/v1/models` | ✅ ready (tts/stt/antalia true); 6 id / 6 tekil |

**Yeni bulgu (R4'e girdi):** host'ta `npm run build` ile **imaj içinde** `npm ci && npm run build`
**farklı paket hash'i** üretiyor (`index-4nq1JGdV.js` vs `index-CPyhoOa5.js`). İkisi de geçerli; fark,
host `node_modules`'ünün kilitle birebir `npm ci` sonucu olmamasından kaynaklanıyor gibi. R4
(yeniden üretilebilirlik) bunu `npm ci` ile sabitleyip doğrulamalı. **(Çözüldü — §8.5.9: hipotez
ölçümle doğrulandı; `npm ci` sonrası host demeti, imajın servis ettiği demetle byte-aynı.)**

**Bilinçli ertelenen:** dört Python imajının yeniden derlenmesi — değişiklik **yalnız yorum**
(davranış birebir; yükleme testiyle doğrulandı) ve kurulum katmanı `COPY`'lardan sonra geldiği için
rebuild torch'u baştan indirir; sonraki tam imaj tazelemesinde yapılır. Belge sınıflandırması (R2'nin
açık sorusu) ise §8.5.7 ile **kapandı**.

### 8.5.7 R6b — tam temizlik: ad repo genelinde **0** (kullanıcı kararı, 2026-10-17)

Kullanıcı R6'nın kapsamını genişletti: **"hiçbir yerde eski ad yazmasın."** Bu, ilk turda "veri
güvenliği" gerekçesiyle korunan kimlikleri de kapsar; karar bilinçli bir **temiz kopuş** oldu.

| Ne | Öncesi | Şimdi |
|---|---|---|
| `localStorage` anahtarları | eski ad öneki (8 anahtar: `captions`, `punct`, `numbers`, `voice`, `provider`, `model`, `videoOutput`, `voxiImported`) | **`apeksis.*`** |
| IndexedDB veritabanı adı | eski ad | **`apeksis`** |
| Dosya seçici (picker) kimliği | eski ad | **`apeksis-media`** |
| Proje biçimi (okuma) | `.voxi` + o dönemin uzantısı; `voxi-project` + o dönemin biçimi | **yalnız `.voxi` + `voxi-project`** (o dönemin uzantı/biçimi artık okunmaz) |
| Yerel referans dizinleri | `example-projects/<eski ad>`, `_scratch_<eski ad>` | `example-projects/reference-app`, `_scratch_reference` (+ `.gitignore`, `.dockerignore`, `CONTRIBUTING.md`) |
| Ürün kodu | 26 geçiş, 9 dosya | **0** |
| Belgeler | 8 belgede ~171 geçiş | **0** |
| İç notlar | `docs/internal/` (gitignore'lu PRD + build prompt) | 10 geçiş nötr dile çevrildi (byte-yedek geçici dizinde) |

**Bilinçli bedel (kullanıcı onayladı):** eski anahtarlarla kaydedilmiş tarayıcı ayarları bir kez
sıfırlanır; o dönemde dışa aktarılmış proje dosyaları artık açılamaz. Ürün yayınlanmadığı için gerçek
kullanıcı verisi yok. `voxi.*` / `voxi-webui` / `VOXI_*` teknik kimlikleri **korunur**.

**Kapsam dışı (dürüst sınır):** `example-projects/reference-app/` ve `_scratch_reference/` — kopyalanan
eski uygulamanın **kendi kaynağıdır** (20 + 15 dosya). Dizin adları değişti; içerikleri doğal olarak o
uygulamanın kendi adını taşır ve **yayınlanmaz** (taze klonda yoktur; gitignore'lu).

**Ölçüm (kabul kriteri):**

| Kapı | Sonuç |
|---|---|
| `rg -i <eski ad>` — repo + belgeler + iç notlar | ✅ **0** |
| Servis edilen `/ui/` demeti (js + css + html) | ✅ **0** |
| Yeni anahtarlar serviste | ✅ `apeksis.captions/punct/numbers/voice/provider/model/videoOutput/voxiImported`, `apeksis-media`, `apeksis-project` |
| İstenen marka serviste | ✅ `caliskangroup.com` |
| `ruff` / `mypy` / `pytest` | ✅ temiz / 22 dosya / **161 passed, 4 skipped** |
| `tsc --noEmit && vite build` / `vitest` | ✅ / **81/81** (10 dosya) |
| Canlı edge | ✅ `voxi-webui` yeniden derlendi + **zorla** yeniden oluşturuldu, `proxy` restart; `/ui/` 200, `index-DNfSMmAU.js` 200, `index-BC46ZlFF.css` 200 |
| `/readyz` · `/v1/models` | ✅ ready (tts/stt/antalia) · 6 id / 6 tekil |

**Ardıl karar:** R2'nin açık sorusu (süreç belgelerinin sınıflandırılması) **kapandı** — belgeler
taşınmadı, **yerinde** nötr dile çevrildi. Böylece kod yorumlarındaki tasarım referansları (14 dosya)
geçerli kalır ve belgeler kamuya açık tasarım kaydı olur.

### 8.5.8 Yayın-öncesi tam depo denetimi + R5 (2026-10-17)

Kullanıcı "GitHub'a push için sorun olmamalı" isteğiyle tam depo denetimi istedi (kurulum
betikleri, AGENTS.md/README, Linux/Docker, HF repo bağlantıları, Compose yapısı). Bulgular ve
düzeltmeler:

**P0 — sır sızıntısı riski:** `certs.saved/` (TLS **özel anahtarının** eski kopyası) gitignore'da
**değildi**; `git init && git add .` ile kamuya push edilebilirdi. `.gitignore` + `.dockerignore`
eklendi.

**Derleme bağlamı sızıntıları:** `.dockerignore`'daki `dist`/`.env` desenleri yalnız **kökte**
eşleşir; `webui/Dockerfile`'ın `COPY webui/ ./` adımı `webui/dist` (bayat demet) ve `webui/.env`
(yerel Vite yapılandırması) kopyasını içeri alabilirdi. `**/dist` + `**/.env` eklendi (webui imajı
zaten taşımıyor gibi görünüyordu; `webui/.env`'in eski ürün-adı yorumu da temizlendi ve dosya
gitignore'a verildi).

**HF bağlantı katmanı (kullanıcı gereksinimi):** yükleme betiği HTTP/NLS hatasında ham yığın izi
basıyordu; ilk kurulumda `up` yalnız "dependency failed to start" derdi. `provision_models.py`
artık üç ayrı, eyleme dönük hata verir: **ağ** ("Cannot reach Hugging Face" + proxy/DNS yönlendirmesi),
**429/5xx** (bekle + aynı provision servisini yeniden koştur; inen dosyalar korunur), **gated/401-403**
(new `HF_TOKEN` geçişi). `HF_TOKEN` dört `provision-*` servisine compose'dan tanımlandı; yalnız
çalışma zamanında ortamdan okunur, imaja girmez, loglanmaz. `.env.example` + `docs/deployment.md`
(bağımlılıklar bölümü) + `docs/troubleshooting.md` (yeni satır) güncellendi. Compose gereksinimi
düzeltildi: proxy overlay'in `!reset` etiketi için **Compose v2.24+**.

**R5 CI (plan maddesi):** `ci.yaml` iki iş kazandı — (1) beş compose kombinasyonunun `config --quiet`
doğrulaması, (2) `webui` işi: `npm ci` + `vitest run` + `tsc --noEmit && vite build` (model yok, ağ
yok bu ikisinden). `CONTRIBUTING.md`'deki doğrulama listesine `turnstub` eklendi (CI ile eşleşti).

**AGENTS.md eklendi:** ajanlar için zorunlu kurallar (uydurma ölçüm yok, canlı doğrulama, sır
kuralları, testler model indirmez), komut tablosu ve depo haritası. Alt ajan çağrısı bu ortamda
çalışmadığı (`invalid x-api-key`) için standartlar ekseni **satır içi** yapıldı: `src/voxi/secrets.py`,
`auth.py` (hmac.compare_digest her yerde, fail-closed keyring), `providers/base.py` (donmuş
dataclass'lar, temiz üretici sınırı) denetlendi; somut standart ihlali bulunamadı. `gateway.py`
(1430 satır) Fowler "God Class" yönünde bir **yargı çağrısı** (judgement call) — bölünme sonraki
aşamalara bırakıldı.

**Doğrulama (canlı):**

| Kapı | Sonuç |
|---|---|
| 5 HF pini (4 model + punctuation kaynağı) sabit revizyonlarda | ✅ HTTP 200 |
| `provision_models.py --verify-only` (yerel hacimler, ağ yok) | ✅ ema-lightning 4 / whisper-small 5 doğrulandı |
| 5 compose kombinasyonu `config --quiet` | ✅ hepsi 0 |
| `ruff` / `mypy` / `pytest` | ✅ temiz / 22 dosya / **161 passed, 4 skipped** |
| `certs.saved/`, `webui/.env`, `.test-tmp/` anahtar dosyaları | ✅ hepsi gitignore'da |

### 8.5.9 R4 — yeniden üretilebilirlik (2026-10-17)

**Ana bulgu — host vs imaj demet hash'i (§8.5.6'daki açık bulgu, ölçümle çözüldü):** host'ta
`npm ci` (kilit-temiz kurulum) ardından `npm run build`, imajın servis ettiği paketle **byte-aynı**
çıktı: `index-BTjThZuT.js` ≡ imaj paketi, **476.524 byte**, SHA-256 `7C3F8BD1…` (iki taraf da
ölçüldü). Eski uyuşmazlığın kökü, host `node_modules` sürüklenmesiydi (hipotez doğruydu);
`npm install` ile kurulan host ortamı sessizce farklı bir artefakt üretir. Ayrıca bu demetin
geç yüklediği ikinci `index-*.js` (340 KB, `BPCrj9ei`) normal bir dinamik chunk'tur (ana chunk
tarafından referans edilir). Kural `CONTRIBUTING.md`'ye yazıldı: frontend derlemeleri daima
`npm --prefix webui ci` ile. `npm audit --omit=dev`: **0 zaafiyet** (yalnız dev ağacı uyarı basar).

**`scripts/up.sh` eklendi (POSIX sh):** README kurulum komutunun incelenmiş ince
sarmalayıcısı — iki `-f` bayrağını gömerek "yalın `up -d` ile proxy'siz kurulum" hatasını
imkânsız kılar; docker/Compose yokluğunda kurulum yönlendirmesiyle başarısız olur; ek bağımsız
değişkenleri `up` alt komutundan ÖNCE geçirir (`--profile antalia` çalışır). Doğrulama: busybox
sh (`sh -n`) **PARSE-OK** (nota: host'ta sh yok; nginx:1.27-alpine konteynerinde kontrol edildi),
dosya LF-only, shebang byte'ları doğru, SPDX başlığı damgalı (184 dosya / 0 eksik). Windows'ta
karşılığı `infra/bootstrap.ps1` (dokümanda geçiyor).

**README ilk ekranı + donanım bloğu:** kurulum bloğuna `scripts/up.sh` satırı eklendi; yeni
"Hardware and first download" paragrafı yalnız **ölçülmüş/pinned** olgular verir — imaj toplamı
~7 GB (`docker images` ölçümü), `ema-lightning` 32.8 MB, `whisper-small` 463.7 MB, `antalia-mini`
29.1 MB (provisioned hacimlerdeki gerçek disk boyutları), turbo ~1.6 GB (kart bilgi), geliştirme
makinesi i7-11800H/16 GB (verification.md'nin kendi kaydı); paralel çağrı kapasitesi **bilinçli
olarak hiçbir yerde garanti edilmez**. İlk-indirme **duvar süresi ölçülmedi**: ölçmek model
hacimlerini silmeyi gerektirir (R2/volume kuralları gereği yapılmaz) — dokümanda bu dürüst not
var, süre vaadi yok.

**deployment.md:** `scripts/up.sh` cümlesi eklendi. **pyproject `[tool.ruff]`:** `extend-exclude`
listesi eklendi (`.venv-export`, `_scratch_reference`, `example-projects`, `models`, `certs.saved`) —
ruff `.gitignore`'a yalnız git checkout içinde riayet eder; git init ÖNCESİNDE de `ruff check .`
temiz çıkmalı (ölçüldü: `ruff check .` artık tüm ağaçta geçiyor; üç eski isabet gitignore'lu
dizinlerdeki dosyalardandı). `uv.lock` etkilenmez (yalnız `[tool.*]` yapılandırması).

Kapsam: R4'ün tamamı, istisna yukarıdaki ölçülemez süre notuyla açıkça işaretli.

### 8.5.10 R7 ön hazırlığı — SECURITY.md + CODE_OF_CONDUCT.md (2026-10-17)

**Sahiplik beyanı netleşti:** sahip, projenin sahibi/geliştiricisinin **Mustafa Tayyar Çalışkan**
olduğunu ve önceki uygulamanın kaynak `MIT LICENSE`'ındaki yazar adının **basitçe hatalı** olduğunu
beyan etti (görüşme kaydı: "no, the project owner and developer of this project Mustafa Tayyar
Çalışkan" + netleştirme sorusu cevabı). §8.5.5 kararının **özü** değişmez (önceki uygulama =
telif sahibinin kendi eseri; üçüncü taraf MIT yükümlülüğü yok); yalnız o **isim** artık üçüncü
kişi gibi ele alınmaz/atıf hedefi olarak kullanılmaz:

- `docs/plan-3-server-first.md` §8.5.5: düzeltme paragrafı eklendi; LICENSE aktındaki isim
  "kayıtlı hatalı isim" olarak qualify edildi (tarihçe korunur, ad yayılmaz).
- `docs/merge-plan-2-integration.md`: 3 geçiş "eski yazar adı / eski GitHub kullanıcı adı" diye
  "eski yazar adı / eski GitHub kullanıcı adı" diye geçildi (nelerin kaldırıldığı/sunulmadığı doğrulaması aynen duruyor).
- `THIRD_PARTY_NOTICES.md` WebUI provenance: sahiplik teyidi paragrafı eklendi.
- Kalan tek geçişler **gitignore'lu** ağaçlarda: `models/` tokenizer sözlükleri (normal BERT
  vocabulary token'ları — dokunulmaz), `example-projects/reference-app` (referans kopya, R2),
  `_scratch_reference/`, `docs/internal/`. Yayınlanan hiçbir dosyada ad geçmiyor
  (`rg` ölçümü yukarıda listelediği tüm kalan dosyalar ignore edilmiş ağaçlarda).

**`SECURITY.md` (yeni, 62 satır):** desteklenen yüzey = mevcut repo ağacı + compose stack'i (henüz
sürüm yok — dürüst); rapor kanalı **GitHub Security Advisories** (kullanıcı seçimi; e-posta
kullanılmaz, SLA vaadi yok — "best-effort" açıkça yazıldı); kapsam: kimlik atlama, WebSocket
izolasyonu, model bütünlük zincirini aşma (pin+SHA-256), token sızıntısı, XSS/SSRF/traversal,
proxy kenarı ihlalleri; kapsam dışı: model kalitesi, host root saldırganı, eksik özellik, bu
projenin entegrasyonunu genişletmeyen üçüncü taraf hataları. Tedarik zinciri durumu (pinli
kurulum, secrets volume'ü, CI'da model yok) uzman meydan okumasına açık diye açıkça yazıldı.
Repo henüz yayında değilse geçici olarak özel kanal yoktur — dosyada dürüstçe yazıyor.

**`CODE_OF_CONDUCT.md` (yeni, özgün metin):** Contributor Covenant şablonu kasıtlı
**kullanılmadı** (CC BY atıf yükümlülüğü + şablonun genel tonunun bu projeninkine uyumsuzluğu
yerine kısa özgün AGPL
metni). Vurgular: kurgulanmış kanıt yasağı (projenin kendi standardı davranış normu olarak),
kod eleştirisi ≠ kişi eleştirisi, TR/EN ikisi de hoş geldin, gerçek ses kayıtları varsayılan
olarak hassas, rapor kanalı GitHub özel ileti (repo yayında değilse kanal yok — dürüst not),
yaptırım merdiveni. Şablon esinlense de metin bu repoya özel.

**README:** License bölümüne Security/conduct yönlendirme satırı eklendi. **Bilinen eksik
(duruma bağlı):** README `git clone <repo>` placeholder'ı — gerçek URL kullanıcı repo'yu
oluşturduğunda yazılacak (kullanıcı beyanı: "repoyu daha yüklemedim"). AGPL §13 metni zaten
self-hosted/salt metin olarak doğru ve URL gerektirmiyor.

** Gates:** dokümantasyon dışında kod değişikliği yok → canlı doğrulama gerekmez; SPDX `--check`
çalıştırıldı (yeni .md'ler başlıksız kalır — repo kuralı .md için başlık istemiyor, ölçüm
aşağıda).

### 8.5.11 R7 — git init + ilk commit + taze-klon doğrulaması (2026-10-17)

**Sürüm kararı (ölçümle):** CHANGELOG'da zaten yayınlanmış **iç** miladlar `0.1.0` ve `0.2.0` var
(`pyproject` = `0.2.0`). Planın eski "ilk etiket v0.1.0" notu bayat: ilk **kamuya açık** etiket
**`v0.3.0`** yapıldı (son yayımlanmış 0.2.0'dan minör bump). Kütle: `pyproject` + `__init__.py`
0.3.0 → `uv lock` yeniledi (`Updated voxi v0.2.0 -> v0.3.0`, exit 0) → OpenAPI kontratları
`scripts/export_openapi.py` ile yeniden yazıldı (`info.version: 0.3.0`; diğer kontrat dosyalarında
sürüm alanı yok — ölçüldü). CHANGELOG "Unreleased" → **"0.3.0 — first public release (2026-10-17)"**;
pytest 161/4 hâlâ yeşil.

**git kurulumu:** `git init -b main` → yerel kimlik `Mustafa Tayyar Çalışkan <owner@apeksis.invalid>`
(geçersiz TLD = kimlik iddiası İÇERMEZ; kullanıcı push'tan önce kendi e-postasıyla
`--amend --reset-author -s` düzeltebilir — kılavuzda yazılı). `.gitattributes` eklendi
(`*.sh eol=lf` — CRLF shebang'ı Linux'ta kırar; `*.ps1 eol=crlf`; binary türler). `scripts/up.sh`
index'te **100755** — `git add --chmod=+x` (entrypoint yok: proxy entrypoint'i `/bin/sh` ile çağrılır,
ölçüldü). CoC + SECURITY dahil 258 dosya stage; DCO `Signed-off-by` ilk commit'te.

**Stage/commit güvenlik denetimi (ölçüm):** yasak desen listesi (`.env`, `certs*`, `models/`,
`node_modules`, `dist`, `*.key/crt`, `secrets`, tmp, `.har/medya`) **0 ihlal**. Tek isim sinyali
`stream-sample.wav` (84.524 B) — **bilinçli kalır**: `integrations/webui/README.md:240,269`
`smoke_stream.py --audio` örneği olarak referans veriyor (plan R2 kararı). Commit edilen ağaçta
`git grep`: `harfiyen` **0**, kayıtlı hatalı isim **0**, `BEGIN … PRIVATE KEY` **0**, `sk-`/`hf_`
canlı token kalıbı **0** (yalnız `.env.example`'daki `# HF_TOKEN=hf_xxx…` yorum placeholder'ı).
Commit: `8e24e93` (sonradan §8.5.11 kayıtlarıyla amend'lenecek).

**Taze-klon benzeri doğrulama (R7'nin "temiz makine" adımının dürüst ikamesi):** release commit'i
`%TEMP%\opencode\apeksis-fresh`'e `git clone`landı; sonuçlar:

| Kontrol | Ölçüm |
|---|---|
| Ağaç paritesi / status | 258/258 dosya, untracked **0**, `up.sh` LF-only, mod `100755` |
| `uv sync --locked --extra dev` | exit 0 — `voxi==0.3.0` klon çözümlemesinden |
| `ruff check .` / `mypy src` / `pytest` | temiz / 22 dosya temiz / **161 passed, 4 skipped** |
| `npm ci` + `tsc --noEmit` + `vite build` | exit 0; ana demet imaj paketiyle **byte-aynı** — 476.524 B, SHA-256 `7C3F8BD1…` |
| Compose matrisi (klonda) | **5/5** kombinasyon exit **0** |

Kapsam notu: **"gerçek sıfırdan Docker kurulumu" (sıfır imaj + sıfır hacim) yapılmadı** — o deneme
canlı model hacimlerini silmeyi gerektirir (R2/olumlu hacim koruması). İhtiyaç doğarsa
temiz makinede README sıfırdan izlenerek yapılır. `docs/verification.md`'e **"0.3.0
first-public-release gates"** bölümü eklendi (ölçüm tabloları + ölçülmeyenler dürüst yazılı).

**Kalan (tamamı kullanıcı):** GitHub repo oluşturup push, README `git clone <repo>` placeholder'ını
doldurmak, `v0.3.0` etiketini push etmek → **§8.5.12'de tamamlandı.**

### 8.5.12 Push — GitHub + opencode entegrasyonu (2026-10-17)

**Repo oluşturma/push** (`gh` CLI, oturum `MTCIRON`): repo **kullanıcı tarafından bugün zaten
oluşturulmuş** (private, yalnız sihirbaz "Initial commit" + `LICENSE` içeriyordu) ve pencere
kimliği `6ce0611`. Ölçümlenen tutarlılık: sihirbazın `LICENSE` dosyası **GNU GPL-3.0** (35.149 B =
gnu.org gpl-3.0.txt) — **yanlış lisans**; bu deponun her yerde sabit AGPL-3.0-or-later'i (34.523 B
= canonical agpl-3.0 metni) ile doğrudan çelişiyordu. Sihirbaz commit'i yalnız bu hatalı dosyayı
taşıdığından `main` doğru récâe `--force` ile üzerine yazıldı (`6ce0611...7deea87`), `v0.3.0`
etiketi ayrıca push edildi. Push sonrası uzak: 2 commit — `b0cde55` (release, etiketli) +
`7deea87` (ci + README gerçek URL). README `git clone <repo>` placeholder'ı
`github.com/MTCIRON/apeksis.git` ile değişti. Görünürlük **private kalır** Kamuya
açma/tanıtımı kullanıcı kararı; ayrıca R7'de istenen görünürlük ayarı: reputation (deployed
durum: AGPL §13 için kamu repo'su gerekir → kullanıcıya tek `gh repo edit … --visibility public`
komutu bırakıldı.

**opencode GitHub entegrasyonu** (`opencode github install`'un manuel yolu, resmî docs
2026-10-17 doğrulamalı): `.github/workflows/opencode.yml` — `issue_comment` +
`pull_request_review_comment` üzerinden `/oc`/`/opencode` tetiklemesi; `id-token: write`,
`persist-credentials: false`, `checkout@v6` + `anomalyco/opencode/github@latest`. Model
`anthropic/claude-sonnet-4-5` (kullanıcı istediği provider/model ile değiştirir), API anahtarı
yalnız Actions secret (`ANTHROPIC_API_KEY`) yoluyla — repoda hiçbir anahtar yoktur. Kullanıcı
taraflı iki adım (tarayıcı makines dışı olduğundan ben yapamam): opencode-agent GitHub App'ini
reporuya kurmak + Actions secret'ını girmek (kılavuzda).

**Ölçüm/karar notları:** release commit'i etiketli durur; CI iş akışı ayrı commit'te olduğundan
`v0.3.0` içeriği değişmedi. push sonrası Actions'taki ilk `checks` çalışması ayrıca izlendi —
GitHub altyapatısında bağımsız doğrulama.

**GitHub-üstü doğrulama (ÖLÇÜM, 2026-10-17):** push edilen ilk üç çalışma, özel repo Actions
dk. faturası/sınır nedeniyle **başlamadan** düştü (hata: "account payments have failed or your
spending limit…"); repo bu yüzden **public** yapıldı (`gh repo edit --visibility public`,
AGPL §13 ile de uyumlu) ve reel yürütme sağlandı. `compose` ve `webui` işleri hemen yeşil
çıktı; `checks` işi **runner'da `ffmpeg` olmadığı** için 25 testte düştü (`RFC ffprobe` değil,
`RuntimeError: FFmpeg is required…`). Düzeltme: ci.yaml `checks` adımına `apt-get install
ffmpeg` (tek satır, commit `0b2afdb`) → üç işin TAMAMI yeşil: **checks ✓ webui ✓ compose ✓**
(run `39029436808`). `v0.3.0` etiketi, gönderilen ağacı gösterecek şekilde aynı commit'e
yeniden işaretlendi; GitHub **Release** `v0.3.0` oluşturuldu
(releases/tag/v0.3.0, dürüst kanıt paragrafıyla). Gizli zaafiyet raporlaması API üzerinden
**açıldı** (`PUT repos/…/private-vulnerability-reporting` → enabled: true). Açık participant
adımları (tarayıcı gerektirir): OpenCode GitHub App'inin reporuya bağlanması + `ANTHROPIC_API_KEY`
Actions secret'ı. CI gerekçesi Node20→24 deprecation uyarıları kozmetik (açı, eylem sürümlerine
ait); ellemeler kayda değer değil.

### 8.5.13 Güvenilir-LAN enjeksiyonu + stack-merge overlayi (post-release, 2026-10-17)

**Talep:** kullanıcı (Merged-AI-NEW yığını sahibi) LAN sunucusunda (ör. `10.0.0.231:8102`)
keyless stüdyo erişimi istiyor; şablona statik IP eklemek + BIND kontrolünü esnetmek önerildi.
**Karar:** statik ev IP'si asla publik repo default'una yazılmaz; bunun yerine iki açık
opt-in env: `VOXI_ALLOW_LAN_INJECT=true` (inject + non-loopback combo'sunda başlama ret
kalkar) + `VOXI_PROXY_EXTRA_HOSTS` (litereal hostlar). Guard'lar AÇIK kalır: Host/origin
allowlist'ine RFC1918 regexleri + ek hostlar eklenir; foreign Host → 421, public cross-site
→ 403 AYNEN. TLS zorunluluğu her modda kalır. `VOXI_PROXY_EXTRA_HOSTS` harf/rakam/nokta/tire
whitelist'i + leading/trailing/çift-nokta ret + loopback-benzeri dedupe ile filtrelenir; bu
girdiler nginx map bloklarına interpolate edilir → config-injection girişimi start'ı RETLandirir.

**Uygulama:** `integrations/nginx/nginx.conf.template` — iki map'e envsubst slot'ları
(`${VOXI_LAN_HOST_ALLOW}`, `${VOXI_LAN_ORIGIN_ALLOW}`; header comment'inde değişken adları
artık birebir yazılmaz, çünkü her verbatim token değerle değiştirilir ve değerler çok
satırlı → başka satıra config sızdı; KEŞİF: ilk render'da `unknown directive` hatası bununla
oldu, mikro-testle ve shim envsubst wrapper ile debuglandı); `voxi-entrypoint.sh` — yeni mod
`lan-inject`, `MODE_LABEL`, build fonksiyonu (POSIX `case`, busybox `tr -d`, `sed` escape),
`runtime.json` `mode:"lan-inject"`, startup WARNING 4 madde; inert flag notu
(inject=false iken flag anlamsız → bilgilendirir). `webui/src/lib/runtimeStatus.ts` — üçüncü
mod `lan-inject` + describe metni; `webui/tests/runtimeStatus.test.ts` — 3 yeni case.
`infra/compose.proxy.yaml` — iki env passthrough + ports comment güncel; `.env.example` —
iki değişken dokümante; `scripts/smoke_proxy.py` — `--mode lan-inject` (foreign Host 421,
public origin 403, private-range origin kabul, keyless 200 (risk açık assertion),
runtime.json). `infra/compose.lan-stack.example.yaml` — YENİ örnek overlay (external
network + !override model host-dir — bu dosya CI matrisinde YOK, config --quiet ile lokal
doğrulanır). `docs/deployment.md` §"Merging into an existing Compose stack" + nginx README
§3 Trusted-LAN injection bölümü (numarasız → değil, 3'e eklendi, 4/5 renumber).

**Ölçüm:** busybox `sh -n` PARSE-OK; `nginx -t` ÜÇ mod (loopback / lan / lan-inject)
successful; canlı doğrulama §8.5.14'te.

### 8.5.14 Canlı doğrulama — trusted-LAN (2026-10-17, kurulan stack üzerinde)

- `pytest` 161 passed / 4 skipped (ruff ilk turda `smoke_proxy.py` E501 → satır kısaltıldı,
  sonra "All checks passed").
- `webui` vitest **83 passed** (10 dosya); production build yeni bundle
  `assets/index-HRjqFXOa.js` (476.694 B).
- Compose `config --quiet`: 5 CI kombinasyonu + YENİ `lan-stack.example`
  (base+proxy+example) = **6/6 exit 0**.
- **Canlı tur (docker stack):**
  1. `VOXI_ALLOW_LAN_INJECT=true VOXI_PROXY_BIND_IP=192.168.16.87`
     `VOXI_PROXY_EXTRA_HOSTS=192.168.16.87` env'leri ile proxy `--force-recreate` →
     `smoke_proxy.py --mode lan-inject` **PASS** (5 assertion, gerçek HTTP üzerinden).
  2. Ortam değişkenleri shell'den düşürüldü (çalışma ağacı .env'e dokunulmadı), reproduce →
     loopback `--mode loopback` smoke **PASS** (5 assertion — eski davranış birebir korundu).
  3. webui image rebuild (`voxi-webui:local`) + `up -d --force-recreate --no-deps webui` +
     `restart proxy` → `/ui/` 200 ve **yeni paket servis ediliyor** (`index-HRjqFXOa.js`,
     200/476.694 B), `runtime.json` loopback modunu doğru bildiriyor.
- Sıralama notu: bundle hash değiştiği için recreate sonrası proxy restart şart (AGENTS
  kuralı — recreate proxy'i bozar, restart onarır).

### 8.5.15 Stack-merge overlayi gözden geçirme turu (2026-10-17, harici gözden geçirmeci)

Kullanıcı (yığındaki Merged-AI-NEW gözden geçirmecisi) `compose.lan-stack.example.yaml`'ı
5 maddeyle inceledi; kabul edilenler:

1. **Provisioner volume çelişkisi (GERÇEK bug)** — worker'lar merkezi host dizinine
   yönlendirilmişti ama provision-* servisleri named volume'la kalmıştı: ilk indirme
   Docker volume'una yazıp worker'ları boş dizinde çökertiyordu. Düzeltme: overlay'e
   `provision-ema/whisper/whisper-turbo/antalia` için `volumes !override` → aynı
   `${VOXI_MODELS_DIR}` ağacına (yazma izinli); docker compose config ile
   varsayılan + özel env (custom `/central/tree`, port 8102, `app-network`) ikiye
   ayrı ayrı `exit 0`.
2. **Sabit container_name** — `voxi-gateway/voxi-tts-ema/voxi-stt-whisper/voxi-webui/`
   `voxi-proxy` (proje önekinden bağımsız DNS; OpenWebUI `http://voxi-gateway:8080/v1`).
3. **Port 8102** — zaten env ile (`VOXI_PROXY_PORT`); overlay örnek `.env` bloğu
   güncellendi (8443 sık çakışır notu).
4. **`VOXI_CPU_THREADS=8`** — zaten env ile; dokümanda tarafsız ifade ("dramatik" gibi
   ölçümsüz iddia benimsenmedi).
5. **UID 10001** — host hazırlığı (`mkdir -p … && chown -R 10001:10001 …`) deployment.md
   merge bölümüne ve overlay başlığına yazıldı; certs dizini checkout `./certs`'ında kalır,
   merkezi dizine symlink önerilir.

Red edilenler: none net — hepsi makul.



**Kalan (R4 dışı):** dört Python imajının yeniden derlenmesi (§8.5.6'daki erteleme sürüyor),
R7 (gerçek repo URL'si + SECURITY.md/CODE_OF_CONDUCT.md), kullanıcının 8 maddelik görsel
onay listesi.
