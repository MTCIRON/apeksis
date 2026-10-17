# Voxi WebUI — önceki uygulama birleştirme planı (Aşama 0 · Keşif)

Amaç: `/ui/` altında **tek** bir React uygulaması. Görsel dil, yerleşim ve
etkileşim modeli önceki uygulama ile birebir; Voxi'nin mevcut özellikleri bu kabuğun
içinde yerel bileşenler olarak yaşar. iframe yok, çift CSS sistemi yok.

Durum: **Aşama 4 tamamlandı — birleştirme bitti.**

## İlerleme

- [x] **Aşama 0 — Keşif:** envanter, uyumsuzluklar, eşleme tablosu (onaylandı).
- [x] **Aşama 1 — Kabuk + tasarım sistemi:** önceki uygulama grid kabuğu + tek CSS + birleşik primitifler (aşağıda ayrıntı).
- [x] **Aşama 2 — önceki uygulama çekirdeği:** motor + worker'lar + Transkript/Timeline/Viewer/Inspector kabuğa taşındı (aşağıda ayrıntı).
- [x] **Aşama 3 — Voxi entegrasyonu:** tek görünüm + Sunucu çekmecesi + köprüler + tek model kataloğu (aşağıda ayrıntı).
- [x] **Aşama 4 — Cila + temizlik:** orphan Voxi dosyaları silindi, ayrı eski `/ui/` derlemesi kaldırıldı, noktalama motoru (transformers) kaldırıldı, responsive/a11y/token kontrolü (aşağıda ayrıntı).

### Aşama 2 teslim listesi (doğrulandı)

| İş | Durum | Dosya |
|---|---|---|
| önceki uygulama kaynağı `webui/src/studio/` altına taşındı (components, lib, engine, whisper, duyu, tts, punct, mt, captions, render, worker, models) | ✅ | `webui/src/studio/**` (92 dosya) |
| Primitif/ikon/menü **tek kaynak**: shim'ler shell'i yeniden dışa aktarır (ikinci tasarım sistemi yok) | ✅ | `studio/components/{ui,icons,Menu}.tsx` |
| `App` → `useStudioEngine()`: iş mantığı aynı, yalnızca dış yerleşim yuvalara bölündü | ✅ | `webui/src/studio/App.tsx` |
| Kabuk yuvaları ham (önceki uygulama elemanları birebir): header/main/transport/status doğrudan geçer | ✅ | `webui/src/shell/app-shell.tsx` |
| `group/shell` + `data-dragging` sözleşmesi korundu (Viewer sürükleme çerçevesi çalışır) | ✅ | `shell/app-shell.tsx`, `studio/components/Viewer.tsx` |
| Paneller yeniden boyutlandırılabilir/daraltılabilir (önceki uygulama `<Pane>` + kabuk tutamaçları) | ✅ | `shell/panels.ts`, `shell/app-shell.tsx` |
| Uygulama: varsayılan görünüm = önceki uygulama çalışma alanı; "Sunucu" ile Voxi konsolları **aynı kabukta** | ✅ | `webui/src/App.tsx` |
| Marka görselleri + caption fontları + ORT wasm + 4 worker servis ediliyor | ✅ | `webui/public/brand/**`, build çıktısı |
| Model kökü `/models` (SPA base'inden bağımsız) | ✅ | `webui/.env`, `webui/Dockerfile` (`VITE_MODELS_BASE_URL=/models`) |
| TypeScript 7.0.2 (önceki uygulamanın sürümü) — vitest/vite sabit kaldı | ✅ | `webui/package.json` |

**Doğrulama:** `tsc --noEmit` temiz · `vite build` 247 modül (asr/tts/mt/render worker'ları + ORT wasm üretildi) ·
`vitest` 80/80 · imaj yeniden derlendi · `https://127.0.0.1:8443/ui/` → 200 (`COOP`/`COEP` aktif) ·
worker chunk'ları + `/ui/brand/*` → 200, `CORP: same-origin`, `immutable`.

**Not:** Ayrı eski `/ui/` derlemesi hâlâ servis ediliyor ama artık gömülü değil — yalnızca
pixel karşılaştırma referansı; Aşama 4'te kaldırılacak. Model katalogları Aşama 3'te birleştirildi.

### Aşama 3 teslim listesi (doğrulandı)

| İş | Durum | Dosya |
|---|---|---|
| **Tek model kataloğu**: `studio/models.ts` tek model kataloğu | ✅ | `webui/src/studio/models.ts` |
| **Tek görünüm**: ayrı "Sunucu" konsol ekranı kaldırıldı; `/ui/` = önceki uygulama çalışma alanı | ✅ | `webui/src/App.tsx` |
| **Sunucu çekmecesi** (üst çubuktaki "Sunucu" düğmesi; Esc kapatır; yükseklik sürüklenir + kalıcı) | ✅ | `webui/src/shell/server-drawer.tsx`, `shell/panels.ts` |
| Çekmece sekmeleri: Panel · Sunucu (Durum/**Uçlar**) · Seslendir · Tanı · Modeller · Günlük · Ayarlar | ✅ | `shell/server-drawer.tsx` |
| **Köprü — sunucu STT → transkript**: `/v1/audio/transcriptions` (`verbose_json`) → segmentler **gerçek zamanlarıyla** VTT olarak çalışma alanına yüklenir | ✅ | `shell/server-drawer.tsx` (`ServerTranscribe`) |
| **Köprü — oturumlar sol panelde**: Sol panel sekmeleri `Transkript │ Oturumlar`; önceki uygulama paneline enjekte edilir | ✅ | `studio/App.tsx` (`StudioBridges.leftTabs`) |
| Sol panel sekmeleri önceki uygulamanın `PaneHead`/bul-geri al akışını bozmaz (yalnızca Transkript sekmesinde görünür) | ✅ | `studio/App.tsx` |
| Tüm Voxi panelleri kaybolmadan yerleşti (TTS, canlı TTS/STT, STT, Modeller, Günlük, Ayarlar, Dashboard) | ✅ | `shell/server-drawer.tsx` |
| Kabuk `overlay` yuvası + `relative` kök (çekmece için) | ✅ | `webui/src/shell/app-shell.tsx` |

**Doğrulama:** `tsc --noEmit` temiz · `vite build` başarılı · `vitest` 80/80 · imaj yeniden derlendi ·
`https://127.0.0.1:8443/ui/` → 200 (`COOP`/`COEP`) · servis edilen bundle'da çekmece metinleri
("Sunucu çekmecesi", "Sunucuda dök", "Oturumlar", "Günlük", "Seslendir", "Uçlar") mevcut.

**Karar (Aşama 4'te uygulandı):** Voxi'nin *transformers* tabanlı noktalama motoru
(`lib/punctuation/*`, `punctuation-control.tsx`) Voxi `TranscriptDocument`'ine bağlı olduğu için
çekmeceye taşınamadı. Kullanıcıya görünen işlev önceki uygulamanın kendi `punct` paketi + Inspector
noktalama bölümüyle karşılanıyor; kullanıcı kararı ile motor **kaldırıldı**.

### Aşama 4 teslim listesi (doğrulandı)

| İş | Durum | Dosya |
|---|---|---|
| **Orphan Voxi arayüzü silindi** (Proje Stüdyosu ağacı önceki uygulama çekirdeğiyle karşılandığı için) | ✅ | `src/{studio-workspace,transcript-studio,subtitle-studio,export-panel,projects-panel,punctuation-control}.tsx` silindi |
| **Noktalama motoru kaldırıldı** (karar: önceki uygulama yeterli) | ✅ | `src/lib/punctuation.ts`, `src/lib/punctuation/`, `src/lib/turkishCase.ts` silindi |
| Kullanılmayan MediaRecorder MP4 yardımcısı silindi (önceki uygulama `mediabunny` ile yakıyor) | ✅ | `src/lib/mp4.ts` silindi |
| Bağımlılık temizliği | ✅ | `@huggingface/transformers` `package.json`'dan çıktı (`npm install` → 37 paket kaldı) |
| Kaldırılan modüllerin testleri silindi | ✅ | `tests/{punctuation,tokenize,turkishCase}.test.ts` — 80 → **53 test** (7 dosya → 5) |
| **Ayrı eski `/ui/` derlemesi kaldırıldı** (Dockerfile aşaması + COPY + nginx location'ları) | ✅ | `webui/Dockerfile`, `webui/nginx.conf` |
| Çekmece mobil sınırı: yüksekliği görüntü alanının ~%62'siyle sınırlanır | ✅ | `src/shell/server-drawer.tsx` (`useViewportCap`) |
| a11y: `role="tablist"/"tab"`, `aria-selected`, `aria-pressed`, `aria-label`, `role="separator"` | ✅ | `shell/server-drawer.tsx`, `App.tsx` |
| Token tutarlılığı: yeni kod yalnızca önceki uygulama token'larını (`cini`, `firuze`, `mercan`, `line`, `fg-*`, `raised`) kullanır | ✅ | `shell/*` |
| Log listesi zaten sınırlı (500 kayıt ring buffer) — sanallaştırma gerekmedi | ✅ | `src/lib/debug.ts` |
| **Tema: koyu (önceki uygulamada açık tema yok; uydurulmadı)** | ✅ | `src/styles.css` (tek `:root`) |

**Doğrulama:** `tsc --noEmit` temiz · `vite build` başarılı (CSS 74.74 kB → **71.96 kB**; transformers
chunk'ı yok oldu) · `vitest` **53/53** · imaj yeniden derlendi · `https://127.0.0.1:8443/ui/` → **200**
(`COOP: same-origin`, `COEP: require-corp`) · hashed JS/CSS + 4 worker chunk → 200,
`CORP: same-origin`, `immutable` · eski `/ui/…` → SPA fallback (ayrı derleme yok) ·
`/models/antalia-mini/manifest.json` → 200 (`Cache-Control: public, max-age=86400`, gzip kapalı) ·
`/v1/endpoints` → 200.

**Kalan tek bilinen durum:** `seda-v0.1` / `duyu-small` / `punct` / `whisper-*` model paketleri
`models/` altında yok (kullanıcı talimatı gereği sonra indirilecek); modeller gelene kadar
tarayıcı motorları "model yok" gösterir. Sunucu tarafı (gateway TTS/STT/sessions) indirmesiz çalışır.


### Aşama 1 teslim listesi (doğrulandı)

| İş | Durum | Dosya |
|---|---|---|
| Tek CSS kaynağı (önceki uygulama token'ları + `@theme inline` + `slider`/`switch`/animasyonlar) | ✅ | `webui/src/index.css`, `webui/src/styles.css` |
| Eski Voxi CSS'i kaldırıldı | ✅ | `webui/src/theme.css` silindi |
| önceki uygulama primitifleri (Button/LinkButton/IconButton/toolbarButton/TbLabel/Pane\*/EmptyNote/Section/Hint/Row\*/Range/Switch) | ✅ | `webui/src/shell/ui.tsx` |
| Voxi eklentileri aynı dilde (Badge/Card/Field/inputClass/Tabs/Dialog/Tooltip/Toast/Table) | ✅ | `webui/src/shell/ui.tsx` |
| önceki uygulama ikon seti (26 ikon) | ✅ | `webui/src/shell/icons.tsx` |
| Menü ailesi (Menu/MenuGroup/MenuTitle/MenuNote/MenuFoot/MenuError/MenuItem/MenuLink) | ✅ | `webui/src/shell/menu.tsx` |
| Panel sistemi: yeniden boyutlandırma + daraltma + localStorage kalıcılığı | ✅ | `webui/src/shell/panels.ts` |
| önceki uygulama grid kabuğu `46/1fr/64/26` + sol/ana/sağ + taşıma + durum | ✅ | `webui/src/shell/app-shell.tsx` |
| Uygulama yeni kabuğa taşındı (sol nav, sağ "Sunucu/Uçlar", taşıma = proje + kaydet + stüdyo sekmeleri, durum çubuğu) | ✅ | `webui/src/App.tsx` |
| **iframe kaldırıldı** (önceki uygulama artık ayrı pencere değil) | ✅ | `webui/src/App.tsx` |
| Gerçek sağ panel: `/healthz`, `/readyz`, `/v1/models`, `/v1/endpoints` | ✅ | `webui/src/shell/server-pane.tsx` |
| `/ui/` artık COOP/COEP/CORP taşıyor (ORT SharedArrayBuffer) | ✅ | `webui/nginx.conf` |
| Araç zinciri: React 19.3 + önceki uygulama bağımlılıkları (mediabunny, onnxruntime-web, @webgpu/types, fontsource) | ✅ | `webui/package.json` |
| Vite: `worker.format=es`, `optimizeDeps.exclude`, dev/preview izolasyon başlıkları, `__APP_VERSION__` | ✅ | `webui/vite.config.ts` |
| Tip katmanı: ES2023 + WebWorker + @webgpu/types | ✅ | `webui/tsconfig.json` |

**Doğrulama:** `tsc --noEmit` temiz · `vite build` başarılı · `vitest` 80/80 geçti · imaj yeniden derlendi ·
`https://127.0.0.1:8443/ui/` → 200, `COOP: same-origin`, `COEP: require-corp`, `CORP: same-origin`;
hashed JS → `Content-Encoding: gzip` + `immutable` + `CORP`.

**Not (bilinçli sapma):** Kabuk CSS'inde Tailwind **Preflight** korunur (önceki uygulama onu kullanmıyor).
Geçiş boyunca Voxi panelleri aynı sayfada yaşadığı için güvenli olan bu; önceki uygulama bileşenleri
kendi stillerini açıkça verdiğinden görünümleri değişmez. Aşama 4'te, Voxi panelleri tümüyle
önceki uygulama primitiflerine taşındığında Preflight'ı kaldırmak değerlendirilecek.

---


## a) önceki uygulama bileşen envanteri

### Kabuk (App.tsx, 1191 satır)
Grid yerleşim: `46px` üst araç çubuğu / esnek gövde / `64px` taşıma çubuğu / `26px` durum çubuğu.

| Bölge | İçerik |
|---|---|
| Üst araç çubuğu | logo, sürüm, `Dosya aç`, `ProjectsMenu`, `ProjectName`, `ExportMenu`, `ModelMenu`, `ProviderMenu`, `Ayarlar`, GitHub, `MoreMenu` (mobil) |
| Sol panel (Transkript) | `FindBar`, uyarı şeridi (başka modelle üretildi), `Transcript` |
| Orta (Viewer) | `Dropzone` ya da video/ses önizleme + canlı dalga formu |
| Sağ panel (Inspector) | ayarlar, model/method (`MethodPicker`, `ModelSettings`), noktalama, sayılar, `DubPanel`, çeviri |
| Taşıma çubuğu | `RecordButton`, oynat/duraklat, süre, sessize al, `Timeline` |
| Durum çubuğu | `StatusBar` (motor, iş, yazma, uyarı) |

### Bileşenler (`src/components/`)
`About`, `CaptionStudio`, `Dropzone`, `DubPanel`, `ExportMenu`, `FindBar` + `useFind`,
`Indicators` (`Meter`, `RecDot`), `Inspector`, `icons` (26 ikon), `Menu`
(`MenuGroup/Title/Note/Foot/Error/Item/Link`), `MethodPicker` + `methodTitle`,
`ModelMenu` + `ModelChoices`, `ModelSettings`, `MoreMenu`, `ProjectsMenu` +
`ProjectList` + `ProjectName`, `ProviderMenu` + `shownProvider` + `ProviderChoices`,
`RecordButton`, `Select`, `Settings`, `StatusBar`, `StylePicker`, `Timeline` +
`TIMELINE`, `Transcript`, `ui` (Button, LinkButton, IconButton, toolbarButton,
TbLabel, Pane/PaneHead/PaneTitle/PaneMeta/PaneBody, EmptyNote, Section,
SectionActions, Hint, Row/RowGroup/RowLabel/RowValue, Range, Switch), `Viewer`.

### Motorlar / worker'lar
- `engine/*` — Seda/Conformer akış ASR (fbank, lodr, resampler, search, tokens)
- `whisper/*` — Whisper (mel, model, tokenizer, alignment, vad)
- `duyu/*` — Duyu (features, model, search)
- `tts/*` — EMA, mini, `antalia-mini/frontend.js`
- `punct/*` — punctuator, spm, turkish
- `mt/*` — çeviri
- `captions/*` — renderer, style, fonts, emphasis, userFonts
- `render/*` — compositor, aura, glass
- `worker/*` — `asr.worker`, `tts.worker`, `mt.worker`, `render.worker`, `sink`, `protocol`, `modelStore`

### Hooks / lib (`src/lib/`)
`cues`, `decodeFallback`, `edit`, `exporters`, `find`, `format`, `lang`,
`microphone`, `modelLibrary`, `numbers`, `projectStore`, `subtitles`,
`translation`, `useBurner`, `useDubber`, `useFollow`, `usePlayer`, `useProjects`,
`useSourceInfo`, `useTranscriber`, `useTranslator`, `videoOutput`, `models.ts`.

### CSS
`index.css` — Tailwind tema+utilities katmanları, **preflight yok**, `@theme inline`
ile token→utility eşlemesi (`bg-pane`, `text-fg-2`, `border-line`, `bg-cini`,
`font-ui`, `rounded-ui`), `slider`/`switch` `@utility`, animasyonlar.
`styles.css` — `:root` token'ları + öğe varsayılanları.

### Durum kaynağı
önceki uygulama state'i `App` içindeki hook'larda: `useTranscriber`, `usePlayer`,
`useDubber`, `useTranslator`, `useBurner`, `useProjects`, `useFollow`. Kalıcılık:
`localStorage` (ayar) + IndexedDB (`projectStore`).

---

## b) Voxi ekran/özellik envanteri

| Ekran | Dosya | Sorumluluk |
|---|---|---|
| Kabuk (sekmeli) | `App.tsx` | sidebar grupları, header, mobil sekmeler, ana içerik |
| Panel (Dashboard) | `dashboard.tsx` | health/readyz/models/endpoints, son projeler, hızlı işlemler, bağlan formu |
| Konuşma Üretimi (TTS) | `audio.tsx` | `/v1/audio/speech` |
| Konuşma Tanıma (STT) | `audio.tsx` | dosya → `/v1/audio/transcriptions` |
| Canlı TTS | `stream.tsx` | `WS /v1/tts/stream`, PCM oynatıcı |
| Canlı STT | `stream.tsx` | `WS /v1/realtime/transcriptions` + VAD |
| Oturumlar | `sessions.tsx` | `POST /v1/sessions`, turn teslimi, aksiyon + seslendirme |
| Durum/Modeller/Ayarlar/Hata Konsolu | `panels.tsx` | `/healthz`, `/v1/models`, ayar, log bus |
| Proje Stüdyosu | `studio-workspace.tsx` | transkript/altyazı/dışa aktar/projeler tek store |
| Transkript Stüdyosu | `transcript-studio.tsx` | kelime zamanlı düzenleme, oynatma senkronu |
| Altyazı Stüdyosu | `subtitle-studio.tsx` | 5 stil, canlı 16:9 önizleme |
| Dışa Aktar | `export-panel.tsx` | SRT/VTT/TXT/JSON + MP4 (MediaRecorder) |
| Projeler | `projects-panel.tsx` | IndexedDB liste/aç/sil |
| Noktalama | `punctuation-control.tsx` | ONNX motor, öneri/onay akışı |
| Tarayıcı modelleri | `components/browser-models.tsx` | önceki uygulama paketlerini Cache API'ye indir |
| Primitifler | `components/ui.tsx` | Card, Badge, Button, Field, inputClass |
| Paylaşılan store | `lib/studioStore.tsx` | TranscriptDocument + history + player + stil + proje |
| API | `api/client.ts`, `api/stream.ts` | tüm gateway sözleşmeleri |

---

## c) Stack uyumsuzlukları ve çözümler

| Konu | önceki uygulama | Voxi | Karar |
|---|---|---|---|
| React | 19.3 | 19.1 | 19.3'e yükselt (küçük) |
| Build | vite 8, plugin-react 6, TS 7 | vite 6, plugin-react 4, TS 5.8, vitest 3 | **Voxi araç zinciri korunur**; önceki uygulama kaynağı port edilir; TS5'te derlenmezse yalnızca TS yükseltilir (vitest'i kırmamak için vite/vitest sabit) |
| CSS | Tailwind 4.3, preflight yok, `@theme inline` token eşlemesi | Tailwind 4.1, tam `@import "tailwindcss"`, `@theme` renkleri | **önceki uygulamanın `index.css` + `styles.css`'i tek kaynak**; `theme.css` silinir. Voxi sınıfları zaten aynı token adlarını kullanıyor (`bg-pane`, `border-line`, `text-fg-3`, `rounded-ui`…) |
| Router | yok | yok | Durum tabanlı kabuk; isteğe bağlı hash derin bağlantı |
| State | Hook-in-App | `StudioProvider` context | Tek kabuk: önceki uygulama hook'ları editörde; Voxi store'u context olarak kalır; aralarında **açık köprüler** |
| Yeni bağımlılıklar | mediabunny, onnxruntime-web, @webgpu/types, @fontsource/* | @huggingface/transformers | önceki uygulama bağımlılıkları webui'ye eklenir; transformers korunur (F6) |
| COOP/COEP | `vite.config` + hosting başlıkları | yalnızca eski `/ui/` | Başlıklar **`/ui/`'ye** taşınır (SharedArrayBuffer) |
| Worker format | ES modül worker | yok | `worker.format: "es"` webui vite yapılandırmasına eklenir |
| Modeller | kendi `models.ts` (`BASE_URL/models`) | taşınmış `models.ts` (`/models`) | Voxi'nin taşınmış model kataloğu tek kaynak olur |
| Fontlar | @fontsource (Inter + 8 başlık fontu) | yok | Dependencies eklenir |

---

## d) Özellik eşleme tablosu (Voxi → önceki uygulama kabuğunda nereye)

| Voxi özelliği | Yeni yeri | Notlar |
|---|---|---|
| **Panel / Dashboard** | Üst çubukta durum çipi + sağ panelde "Sunucu" sekmesi + Durum Çubuğu | health/readyz/models/endpoints tek yerde; hero kartları kaldırılır |
| **Endpoint kataloğu** (`/v1/endpoints`) | Sağ panel sekmesi **Uçlar** (Inspector yanında) | yöntem/yol/servis/amaç, arama |
| **Hata Konsolu (loglar)** | Alt **çekmece (drawer)** — Durum Çubuğu'na bağlı, aç/kapa | canlı akış + filtre/arama; sanallaştırılmış liste |
| **TTS** (`/v1/audio/speech`) | Sağ panel **Seslendir** bölümü + araç çubuğu aksiyonu | çıktı paylaşılan oynatıcıda; İndir/ExportMenu ile uyumlu |
| **STT** (dosya → `/v1/audio/transcriptions`) | Ana akış zaten `Dosya aç`; STT **sağlayıcı** olarak eklenir (tarayıcı motoru yanında) | sonuç `Transcript` + `Timeline`'a akar |
| **Canlı STT** (`WS /v1/realtime/transcriptions`) | `RecordButton` mikrofonda Voxi WS seçeneği | canlı kelimeler Transkript + Timeline'a akar |
| **Canlı TTS** (`WS /v1/tts/stream`) | Taşıma çubuğu / Viewer; `PcmPlayer` ile | oynatma önceki uygulama oynatıcı stiliyle |
| **Oturumlar** | Sol panelde sekme **Oturumlar** (`ProjectList` stili) | oturum aç/turn teslim/a Aksiyon; bir oturumu timeline'da aç köprüsü |
| **Proje Stüdyosu** | Zaten önceki uygulama çekirdeği | transkript/altyazı/dışa aktar/projeler → mevcut pane/menü |
| **Modeller (tarayıcı)** | `ModelMenu` + `ModelSettings` | indirme/önbellek zaten taşındı |
| **Modeller (sunucu)** | `ModelSettings` içinde "Sunucu modelleri" | `/v1/models` |
| **Ayarlar** | `Settings` diyaloğu + **Voxi** bölümleri | api anahtarı, sunucu adresi, runtime modu |
| **Noktalama** | `Inspector` noktalama bölümü | Voxi ONNX motoru + önceki uygulama akışı birleşir |
| **Dışa Aktarma** | `ExportMenu` + `CaptionStudio` | SRT/VTT/TXT/JSON/MP4 tek menüde |

### Köprüler (iki ürünü tek ürün gibi gösteren bağlantılar)
- Log satırı → ilgili oturum/turn ve transkript noktası.
- Oturum → "timeline'da aç" (kelime bazlı).
- STT sonucu → doğrudan düzenlenebilir Transkript; ardından Altyazı/Dışa Aktar.
- Canlı STT kelimeleri → Transkript + Timeline gerçek zamanlı.
- TTS çıktısı → ExportMenu ve `DubPanel` ile aynı oynatıcı.

---

## Aşama planı (onaydan sonra)

- **Aşama 1 — Kabuk + tasarım sistemi:** önceki uygulama `App` yerleşimi `webui/src/shell`'e; tek CSS (`index.css`+`styles.css`); primitifler birleşir; panel sistemi (yeniden boyutlandırılabilir/aç-kapa, kalıcı).
- **Aşama 2 — önceki uygulama çekirdeği:** Transkript/Timeline/Viewer/ModelMenu + hook'lar birebir; pixel karşılaştırma; backend adaptörü.
- **Aşama 3 — Voxi entegrasyonu:** yukarıdaki eşleme tablosuna göre her özellik + köprüler.
- **Aşama 4 — Cila:** dark/light, responsive, a11y, sanallaştırma, token tutarlılığı; typecheck/lint/build + smoke testler.

## Riskler
1. İki CSS tabanının birleşmesi Voxi bileşenlerinde küçük görsel kaymalar yaratabilir → Aşama 1'de ekran ekran denetim.
2. TS5 ile önceki uygulama kaynağı derlenmezse TS yükseltmesi gerekebilir (vitest sürümü etkilenmesin diye izole edilir).
3. 26 MB ORT wasm + COEP: `/ui/`'ye taşınan başlıklar diğer gömülü içerikleri etkileyebilir → yalnızca gerekli location'larda tutulur.
4. Kapsam büyük (önceki uygulama ~9 bin satır) → aşamalı, geri alınabilir adımlar.
