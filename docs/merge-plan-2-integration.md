# Plan 2 — Birebir iç içe geçme (tek yetenek, tek yol)

> Plan 1 (`docs/ui-merge-plan.md`) bitti: `/ui/` artık tek React uygulaması, tek kabuk, tek CSS,
> tek model kataloğu. Ama iki program hâlâ **iki paralel uygulama** gibi duruyor: aynı yetenekler
> hem önceki uygulamanın tarayıcı motorlarıyla hem Voxi'nin sunucu worker'larıyla ayrı ayrı yapılıyor.
> Bu plan, **aynı olan özellikleri tek yola indirir**: tek yüzey, tek sonuç yolu; sağlayıcı ise
> yalnızca "nerede çalışsın" ekseni olur.

**Durum:** Aşama 5, 6, 7, 8, 9 ve 10 tamamlandı (aşağıda §5-§9 teslim tabloları; Aşama 8 §8b marka +
tam ekran revizyonuyla, marka §8c'de **Apeksis**'e geçti, §8b'nin tam ekran "Sunucu" paneli §9b'de
Ayarlar'a gömüldü, Aşama 10 §10'da kod düzeyinde doğrulandı). §11'de **varsayılan sağlayıcı sunucu**
oldu (kullanıcı isteği): tarayıcı yolu isteğe bağlı kalır, ilk açılışta indirme gerekmez. §13'te model
envanteri kayda geçti ve tutarlılık düzeltmeleri yapıldı (`npm run models` mesajları, README,
`/v1/models`'a `tts-1`, `manifest.json` çakışma notu). Geriye kullanıcıya kalan tek şey **birebir
kabul testinin tarayıcıda elle yapılması** (§10) ve istenirse derin yeniden adlandırma (§12).

---

## 1. Çekirdek tespit

Voxi'nin sunucu worker'ları (`tts-ema`, `stt-whisper`) ile önceki uygulamanın tarayıcı motorları
(`seda`/`ema` ses paketi, `whisper-turbo`, `duyu`) **aynı yeteneklerdir** — yalnızca yürütme
yerleri farklı. Örnek: **EMA Lightning** sesi hem tarayıcı ONNX paketi (`VOICE_PACKS.ema`,
`dir: "ema-lightning"`) hem sunucu servisi (`/v1/audio/speech`) olarak iki kez mevcut.

önceki uygulamada bu eksen için **hazır bir seam var**: `ProviderChoice = "auto" | "webgpu" | "wasm"`
(`studio/worker/protocol.ts`) ve `ProviderMenu`. Birebir iç içe geçme = bu seam'i
`"tarayıcı" | "sunucu"` ekseniyle genişletmek ve **her yeteneği tek UI + tek sonuç yoluna indirmek**.

Iki yol bugün nasıl ayrışıyor:

| # | Yetenek | önceki uygulama yolu (tarayıcı) | Voxi yolu (sunucu) | Durum |
|---|---|---|---|---|
| 1 | Konuşma tanıma | `studio/whisper/*`, `useTranscriber`, `job` | `POST /v1/audio/transcriptions`, `SttPanel`, `ServerTranscribe` | **çift** |
| 2 | Canlı tanıma | `studio/duyu/*` + `goLive` (`job.live`) | canlı STT WS + `StreamSttPanel` | **çift** |
| 3 | Seslendirme | `studio/tts/*` + `useDubber` + `VOICE_PACKS` (ema/mini) | `POST /v1/audio/speech` + `TtsPanel` + `knownVoices` | **çift** (aynı EMA) |
| 4 | Canlı seslendirme | seda streaming | `WS /v1/tts/stream` + `StreamTtsPanel` | **çift** |
| 5 | Ses çalma | `studio/lib/usePlayer.ts` | `lib/player.ts` → `useAudioPlayer` | **çift** |
| 6 | Model indirme yüzeyi | motor içi indirme + `ModelMenu`/`ModelSettings` | ayrı bir model kitaplığı + `components/browser-models.tsx` | **çift** |
| 7 | Model deposu | `studio/worker/modelStore.ts` | `lib/modelStore.ts` (aynı cache adı, ayrı kod) | **çift** |
| 8 | Sunucu model listesi | — | `panels.tsx ModelsPanel` (`/v1/models`) | 3. yüzey |
| 9 | Projeler | `studio/lib/useProjects.ts` (FSA + IndexedDB) | `lib/studioStore.tsx` + `lib/idb.ts` + `lib/voxiProject.ts` | **çift** |
| 10 | Transkript veri modeli | `Word[]` + `studio/lib/edit.ts` | `lib/transcript.ts` (document/segments) | **çift** |
| 11 | Altyazı oku/yaz | `studio/lib/subtitles.ts` | `lib/subtitles.ts` | **çift** |
| 12 | Noktalama | `studio/punct/*` | — (kaldırıldı) | ✅ tek |
| 13 | Dışa aktarma | `ExportMenu` + `render/` + mediabunny | — (kaldırıldı) | ✅ tek |
| 14 | Çeviri | `useTranslator` + `mt` paketi | — | ✅ tek |
| 15 | Ayarlar | `components/Settings.tsx` (models/about) | `panels.tsx SettingsPanel` + `lib/settings.ts` | **çift** |
| 16 | Durum/sağlık | `StatusBar` (motor fazı) | `StatusPanel` + Dashboard (`/healthz`, `/readyz`) | **çift** |
| 17 | Günlük/bildirim | `setNotice` şeridi | `lib/debug.ts` + `DebugPanel` | **çift** |
| 18 | Oturumlar | — | `/v1/sessions` + `SessionsPanel` | yeni → entegre edilecek |

**Gateway'in sunduğu tek gerçek yetenek seti** (uydurma yok): `/healthz`, `/readyz`, `/metrics`,
`/v1/models`, `/v1/endpoints`, `POST /v1/audio/speech`, `POST /v1/audio/transcriptions`,
`POST /v1/sessions` + `/turns` + `DELETE`, `WS /v1/sessions/{id}/stream`, `WS /v1/tts/stream`,
`POST /v1/auth/socket`. **Çeviri uç noktası yok** → çeviri tek yolda (önceki uygulama `mt`) kalır. ✔

---

## 2. İlke (kabul kuralı)

1. **Tek yetenek = tek yüzey = tek sonuç yolu.** Sağlayıcı değişince yalnızca *nerede çalıştığı*
   değişir; akış, ilerleme, hata mesajı, geri alma (undo) ve sonucun düştüğü yer **aynı** olur.
2. **Sonuç her zaman aynı yere düşer**: düzenlenebilir Transkript + Zaman Çizelgesi. Sunucu sonucu
   "ikinci bir görünüm" değildir; aynı `job`a girer.
3. **İki tane kalmaz**: iki ayar penceresi, iki oynatıcı, iki proje listesi, iki model indirme
   yüzeyi, iki durum çubuğu olmayacak.
4. **Uydurma yok**: zamanlar/ölçüler sunucudan veya modelden gelir; hesaplanamıyorsa "bilinmiyor".
5. **Voxi'den işlev kaybı yok**: her kaldırılan yüzeyin karşılığı tek yolda mevcut olacak.

---

## 3. Aşamalar

### Aşama 5 — Sağlayıcı iskeleti (STT + modeller) ✅

**Amaç:** "Nerede çalışsın?" tek kavram olsun; sunucu STT, tarayıcı STT ile *aynı* iş akışına sahip olsun.

| İş | Dosya |
|---|---|
| `ProviderChoice` → `"auto" \| "webgpu" \| "wasm" \| "sunucu"` (yetenek başına ayrı değer) | `studio/worker/protocol.ts`, `studio/lib/useTranscriber.ts` |
| Sunucu motor adaptörü: dosya → `/v1/audio/transcriptions` (`verbose_json`) → **aynı `job`** (kelime/segment + gerçek zamanlar), ilerleme/hata/iptal aynı kanaldan | yeni `studio/lib/serverEngine.ts` |
| `ProviderMenu`'ye "Sunucu (Voxi)" seçeneği + durum çubuğunda "Sunucu" etiketi | `studio/components/ProviderMenu.tsx`, `StatusBar.tsx` |
| Sesli/yazılı sonuç yolu tek: sunucu sonucu da düzenlenebilir + zaman çizelgesinde + undo'da | `studio/App.tsx` |
| Çekmecedeki `ServerTranscribe` kaldırılır (artık sağlayıcı olarak var) | `shell/server-drawer.tsx` |

**Doğrulama:** Aynı dosya ile `Tarayıcı` ve `Sunucu` sağlayıcısı → aynı transkript yapısı, aynı
timeline davranışı, aynı undo; sağlayıcı seçimi kalıcı. `tsc`/`vitest`/`build` temiz.

**Risk:** Sunucu için API anahtarı/adres gerekir → Aşama 8'deki tek ayar penceresiyle bağlanır;
ilk kullanımda yönlendirme gerekir.

---

### Aşama 6 — Ses: tek oynatıcı, tek ses listesi, TTS sağlayıcısı ✅

**Amaç:** Seslendirme ve çalma tek yolda; EMA iki kez değil, bir kez ve seçilebilir.

| İş | Dosya |
|---|---|
| Tek ses listesi: tarayıcı paketleri (ema, mini) ∪ sunucu sesleri (`/v1/models`), her ses "Tarayıcı/Sunucu" etiketli | `lib/models.ts`, yeni `studio/lib/voices.ts` |
| Tek "Seslendir" eylemi; sağlayıcı = Tarayıcı (ema/mini paketi) \| Sunucu (`/v1/audio/speech`); sonuç **aynı dub kanalına/timeline'a** | `studio/lib/useDubber.ts`, `studio/lib/serverTts.ts`, `studio/App.tsx`, `studio/components/DubPanel.tsx` |
| Tek oynatıcı veriyolu: önizleme proje medyasını duraklatır (aynı anda tek ses); Voxi `useAudioPlayer` (`lib/player.ts`) silinir | `studio/lib/useDubber.ts`; silme → Aşama 7 (yalnız `studioStore` kullanır) |
| Canlı seslendirme: tek canlı yüzey — çekmecede **"Canlı"** sekmesi (canlı TTS + canlı STT birlikte); Aşama 9 bu yüzeyi sohbet moduna taşır | `shell/server-drawer.tsx` |
| Çekmeceden dosya-TTS paneli kaldırılır (artık çalışma alanında, sağlayıcı anahtarlı) | `shell/server-drawer.tsx`, `audio.tsx` silinir |

**Doğrulama:** Aynı metin iki sağlayıcıda da dinlenebilir + timeline'a yazılabilir; aynı anda iki ses
çalmaz; ses listesi tek yerde; EQ/hız/volume tek.

**Risk:** Sunucu sesi indirilen yerel sese göre gecikmeli → ilerleme/iptal aynı kanaldan gösterilir.

---

### Aşama 7 — Tek proje deposu ve tek veri modeli ✅

**Amaç:** İki proje listesi ve iki transkript modeli tek olsun.

| İş | Dosya |
|---|---|
| Tek depo: önceki uygulama `useProjects` (FSA handle + IndexedDB medya). Voxi deposu kaldırılır | `studio/lib/useProjects.ts`; silinecek: `lib/studioStore.tsx`, `lib/idb.ts`, `lib/voxiProject.ts`, `lib/transcript.ts`, `lib/transcriptEdit.ts`, `lib/subtitles.ts`, `lib/player.ts` |
| Dashboard "son projeler" → tek depodan okur (veya bölüm kaldırılır — **karar**) | `dashboard.tsx` |
| Voxi `App.tsx` içindeki `StudioProvider` kaldırılır | `src/App.tsx` |
| Karşılık gelen Voxi testleri kaldırılır | `tests/{transcript,transcriptEdit,subtitles,voxiProject}.test.ts` |

**Doğrulama:** Tek proje listesi (menü + Dashboard aynı kaynak); erişilebilirlik grafiğinde ölü
modül yok; `tsc`/`vitest`/`build` temiz.

**Karar (kullanıcı):** Mevcut Voxi IndexedDB projeleri **tek seferlik içe aktarılır** (aşağıda §7).
Dashboard'un "son projeler" listesi kaldırılır: tek liste çalışma alanının proje menüsüdür (Dashboard
zaten Aşama 8'de tamamen kalkıyor).

---

### Aşama 8 — Tek yüzey: ayarlar, durum, günlük, modeller ✅

**Amaç:** Voxi'nin ayrı yüzeyleri önceki uygulamanın mevcut pencerelerine gömülür.

| İş | Dosya |
|---|---|
| önceki uygulama `Settings` bölümleri: **Sunucu** (api anahtarı, adres, çalışma modu), **Modeller** (birleşik), **Hakkında** + gateway durumu. ("Ses" bölümü açılmadı — aşağıda "Sapma") | `studio/components/Settings.tsx`, yeni `studio/components/ServerSettings.tsx` |
| Tek model yüzeyi: tarayıcı paketleri + sunucu modelleri tek listede, tek indirme/ilerleme mantığı | `components/browser-models.tsx` → `Settings` "Modeller" bölümü; `ModelsPanel` kaldırılır |
| Tek model deposu kodu | `lib/modelStore.ts` silinir; `studio/worker/modelStore.ts` tek |
| `StatusBar`: motor fazı + gateway sağlığı (`/healthz`, `/readyz`) tek satırda | `studio/components/StatusBar.tsx` |
| Tek günlük: önceki uygulama bildirimleri + gateway çağrıları `lib/debug.ts` kuyruğuna; `DebugPanel` çekmecede kalır | `studio/App.tsx`, `lib/debug.ts` |
| Panel daralır: yalnızca "Sunucu/Uçlar", "Canlı", "Günlük" (kalanlar çalışma alanında ya da Ayarlar'da). **8b: çekmece değil, tam ekran panel** | `shell/server-drawer.tsx` |

**Doğrulama:** Tek ayar penceresi (Voxi `SettingsPanel` yok); sağlık tek çubukta; bildirimler tek
günlükte; model indirme tek yüzey.

**Karar (kullanıcı):** Dashboard ("Panel" sekmesi) **kaldırılır**; içeriği dağıtılır. Dağıtım tablosu:

| Dashboard öğesi | Nereye gitti |
|---|---|
| Hero (başlık, "＋ Yeni proje") | **Kaldırıldı** — araç çubuğunda "Yeni proje" ve proje menüsü zaten var. |
| 4 işlem kartı (Konuşma Üretimi / Konuşma Tanıma / Proje Stüdyosu / Canlı Mikrofon) | **Kaldırıldı** — kartlar yalnızca yönlendiriyordu; her hedef tek yolda: TTS → çalışma alanı "Seslendirme" (Aşama 6), STT → çalışma alanı sağlayıcısı (Aşama 5), Proje Stüdyosu → çalışma alanının kendisi, Canlı Mikrofon → çekmece "Canlı" (Aşama 9 emer). |
| Kimlik durumu (otomatik kimlik / bağlı / "Sunucuya bağlan" formu) | **Ayarlar → Sunucu** (anahtar, adres, çalışma modu, "Kaydet ve bağlan" testi). |
| Metrik şeridi (Toplam proje / Yüklü model / Hazır servis / Canlılık) | **Toplam proje** → çalışma alanının proje menüsü (Aşama 7); **Yüklü model** → Ayarlar → Modeller; **Hazır servis + Canlılık** → durum çubuğu (tek satır) + Ayarlar → Sunucu. |
| Servis Durumu kartı (healthz/readyz worker rozetleri) | **Durum çubuğu** (tek satır, sessiz yoklama) + çekmece **Sunucu → Durum** (ayrıntı). |
| Modeller kartı (gateway `/v1/models`) | **Ayarlar → Modeller** — tarayıcı paketleriyle **tek yüzeyde**. |
| Endpoint Kataloğu kartı (`/v1/endpoints`) | Çekmece **Sunucu → Uçlar** (zaten daha zengin). |
| Gizlilik şeridi | **Ayarlar → Hakkında** (metnin doğru yeri); dekoratif kutu kaldırıldı. |

| Sunucu paneli sekmesi | Durum |
|---|---|
| Panel (Dashboard) | **Kaldırıldı** — Dashboard silindi. |
| Sunucu (Durum + Uçlar) | Kaldı; modeller listesi Ayarlar → Modeller'e taşındı. |
| Canlı (canlı TTS + canlı STT) | Kaldı (Aşama 9 emer). |
| Modeller (tarayıcı paketleri + gateway modelleri) | **Kaldırıldı** → Ayarlar → Modeller. |
| Günlük | Kaldı — tek günlük (önceki uygulama bildirimleri + gateway çağrıları). |
| Ayarlar (Voxi `SettingsPanel`) | **Kaldırıldı** → önceki uygulama Ayarlar → Sunucu. |

**Sapma (bilinçli):** Plandaki "Ses" ayar bölümü **açılmadı**: seslendirme/ses seçimi zaten Denetçi'nin
"Seslendirme" sekmesinde (Aşama 6) ve sağlayıcı/ses menülerinde tek yolda yaşıyor; Ayarlar'a ikinci bir
kopya koymak Plan 2'nin "yetenek başına tek yüzey" kuralını çiğnerdi. Bölümler: **Sunucu · Modeller ·
Hakkında**.

---

### Aşama 9 — Canlı sohbet: oturumlar çalışma alanına ✅

**Amaç:** Oturumlar ayrı bir panel değil, çalışma alanının bir modu olsun.

| İş | Dosya |
|---|---|
| Oturum çubuğu transkript panelinin üstünde; "Oturum başlat" hem sunucuda oturum açar hem mikrofonu açar (sağlayıcı seçimli) | yeni `studio/components/SessionBar.tsx`, `studio/App.tsx` |
| Tur, dökümden gider (seçim ya da son tur) → `POST /v1/sessions/{id}/turns`; dönen `action` alan alan gösterilir | yeni `studio/lib/useSession.ts`, yeni `studio/lib/turns.ts` |
| Yanıt sunucu TTS'iyle okunur (`WS /v1/tts/stream`); önce medya duraklatılır (tek ses kuralı) | yeni `studio/lib/useServerSpeak.ts` |
| **Canlı sunucu STT:** mikrofon → `WS /v1/realtime/transcriptions` → gerçek VAD aralığı → sözcükler; dalga yerelden ölçülür | yeni `studio/lib/serverLive.ts`, `studio/lib/useTranscriber.ts` |
| Sol panelden "Oturumlar" sekmesi ve çekmeceden "Canlı" sekmesi kalkar; `sessions.tsx` + `stream.tsx` silinir | `studio/App.tsx`, `shell/server-drawer.tsx` |

**Doğrulama:** Tek oturum akışı: mikrofon → düzenlenebilir metin → sunucu yanıtı → ses + timeline.
Uydurma zaman yok; sunucudan gelen veriler kullanılır.

**Risk:** Canlı WS için tek kullanımlık bilet (`POST /v1/auth/socket`) gerekir → adaptörde.

---

### Aşama 10 — Cila + gerçek temizlik + kabul testi ✅

- Kalan yüzeyleri gözden geçir; her biri tek yolda yaşıyorsa kaldır. (Tam ekran "Sunucu" paneli
  §9b'de kalktı: ayarlar artık gateway'in tek yüzeyi.)
- Erişilebilirlik grafiğiyle **ölü modül taraması** (Plan 1'deki betik), sıfır orphan hedefi.
- **Ölü dışa aktarım taraması**: kalan tek tüketicisi silinmiş yüzeylerden artakalan kod.
- `tsc` · `vitest` · `vite build` · imaj · `/ui/` (200 + COOP/COEP).
- **Birebir kabul testi** (elle, tarayıcıda): aşağıdaki liste birebir geçmeli. Ajan tarayıcı
  göremiyor; bu yüzden her madde **kod düzeyinde kanıtla** doğrulandı (§10) — kalan tek adım
  kullanıcının tarayıcıda gözle onaylaması.

**Birebir kabul listesi**
1. Tek sağlayıcı menüsü: her yetenek için Tarayıcı/Sunucu; seçim kalıcı. **Varsayılan Sunucu** (§11):
   temiz bir tarayıcıda ilk açılışta ikisi de "Sunucu (Apeksis)" ile gelmeli, hiçbir model
   indirilmemeli.
2. Aynı dosya iki sağlayıcıda da **aynı yere** sonuç verir (transkript + timeline), undo dahil.
3. Aynı metin iki sağlayıcıda da seslendirilebilir; sonuç aynı dub kanalına düşer.
4. Tek oynatıcı: aynı anda iki ses çalmaz.
5. Tek proje listesi (menü ve Dashboard aynı kaynağı gösterir).
6. Tek ayar penceresi; tek sağlık çubuğu; tek günlük.
7. Tek model yüzeyi ve tek model deposu.
8. Hiçbir yerde aynı işi yapan ikinci bir yüzey yok.

---

## 4. Beklenen sonuç

Sonunda `/ui/` şöyle davranır: **tek uygulama, tek yetenek seti, tek sonuç yolu.** önceki uygulama
tasarımı ve editör davranışları birebir kalır; Voxi'nin sunucu gücü aynı düğmelerin altında
bir "sağlayıcı" olarak durur. Kullanıcı "hangi programda olduğunu" değil, yalnızca "bu işi
tarayıcıda mı sunucuda mı yapmak istediğini" seçer.

---

## 5. Aşama 5 teslimi — Konuşma tanıma tek yolda

Sunucu STT artık ayrı bir panel değil, tarayıcı motorlarıyla **aynı sağlayıcı ekseninde** bir seçenek.

| Ne yapıldı | Dosya |
|---|---|
| Yeni tip: `SttProvider = "auto" \| "webgpu" \| "wasm" \| "sunucu"`; worker protokolü değişmedi (`ProviderChoice` aynı kaldı, "sunucu" worker'a hiç gitmez) | `studio/worker/protocol.ts` |
| Sunucu motor adaptörü: dosya → `/v1/audio/transcriptions` (`verbose_json` + `segment,word`) → gerçek kelime/segment zamanları → **aynı `Word[]`**. Zaman yoksa uydurmak yerine hata verir. 401/403'te "Ayarlar → Sunucu" ipucu. | yeni `studio/lib/serverEngine.ts` |
| `useTranscriber`: `provider` artık `SttProvider`; `start()` sunucuysa istek atar (worker'a hiç dokunmaz), sonucu **aynı `job`a** yazar; `cancel()` isteği iptal eder (`AbortController`); `setProvider("sunucu")` worker'ı yeniden yüklemez; `setModel` sunucu seçiliyken worker sağlayıcısını bozmaz | `studio/lib/useTranscriber.ts` |
| `api/client`: `TranscriptionOptions.signal`; iptal edilen istek artık "ağ hatası" sayılmaz (AbortError aynen geçer) | `api/client.ts` |
| `Job.server?: true` — sunucu dökümü işaretlenir; `canResume` sunucu işini devam ettirmez (tek istek, offset yok) | `studio/lib/useTranscriber.ts` |
| Sağlayıcı menüsüne **"Sunucu (Voxi)"** (yeni `IconServer`); başlık "Yazıya dökme nerede çalışsın"; sunucu seçiliyken "dalga biçimi/aura boş kalır" notu | `shell/icons.tsx`, `studio/components/ProviderMenu.tsx` |
| Durum çubuğu: sunucu seçiliyken "Sunucu (Voxi) /v1/audio/transcriptions"; sunucu işi "Sunucuda yazıya dökülüyor…" (yüzde yok), bitince "… · sunucudan" | `studio/components/StatusBar.tsx` |
| Denetçi: sunucu seçiliyken deşifre yöntemi yerine açıklama (yerel çözümleme kontrolleri sunucuda geçersiz) | `studio/components/Inspector.tsx` |
| Sol panel: sunucu dökümü de düzenlenebilir + zaman çizelgesinde + undo'da; "başka yerde yapıldı" şeridi sunucuyu da kapsar (Tarayıcı↔Sunucu geçişinde "yeniden dök") | `studio/App.tsx` |
| Sunucu dökümü sunucu Whisper'ın noktalamasını korur (yerel noktalama modeli uygulanmaz); canlı kayıt sunucu sağlayıcısında kapalı ve nedeni yazılır | `studio/App.tsx` |
| **Kaldırıldı:** çekmecedeki `ServerTranscribe` (VTT köprüsü) ve `SttPanel` (ikinci STT yüzeyi) + `StudioBridge`/`bridge` prop'u | `shell/server-drawer.tsx`, `audio.tsx`, `src/App.tsx`, `shell/index.ts` |

**Doğrulama (Aşama 5):** `tsc --noEmit` temiz · `vite build` OK (CSS 70.94 kB) · `vitest` **53/53**.

**Bilinen ve açıkça belirtilen sınır:** sunucu sağlayıcısında dalga biçimi (peaks) ve aura (bands/loudness)
boş kalır — dosya yerelde çözülmediği için. Menüde ve menü altlığında bu yazılı; tarayıcı sağlayıcısı
tam analizi verir. Uydurma veri üretilmez.

**Kabul edilen kararlar (kullanıcı):** Voxi projeleri tek seferlik içe aktarılacak (Aşama 7) ·
Dashboard kaldırılacak (Aşama 8) · sağlayıcı **yetenek başına**, tek menüde (Aşama 6 TTS'i ekler).

**Kalan:** Docker daemon kapalı olduğundan imaj yeniden kurulup tarayıcıdan doğrulanamadı;
`docker compose -f compose.yaml -f infra/compose.proxy.yaml build webui` + `up -d webui` ile
`https://127.0.0.1:8443/ui/` üzerinden elle kontrol gerekiyor.

---

## 6. Aşama 6 teslimi — Seslendirme tek yolda

Aynı yetenek (metni sese çevirme) iki kez duruyordu: önceki uygulamanın tarayıcı paketleri (EMA Lightning /
Antalia Mini) ve Voxi'nin sunucu servisi (`tts-ema` / `POST /v1/audio/speech`). Artık **tek eylem,
tek sonuç yolu**, sağlayıcı yalnızca "nerede üretilsin" sorusunu yanıtlar.

| Ne yapıldı | Dosya |
|---|---|
| Tek ses kataloğu: `VoiceChoice` ayrık birleşimi — tarayıcı yalnız gerçekten sahip olduğu `pitch`/`seed`'i, sunucu yalnız `speed`'i taşır. Tarayıcı paketleri `VOICE_PACKS`'tan; sunucu sesleri `/v1/models` ∩ `knownVoices` (sesi bilinmeyen model sunulmaz, çünkü ağ geçidi yanlış sese 400 verir). `useInstalledModels` + `knownVoices` buraya taşındı | yeni `studio/lib/voices.ts` |
| Sunucu dublaj adaptörü: satır başına `POST /v1/audio/speech` (`response_format:"pcm"`, `sample_rate:48000`) → ham `pcm_s16le` **çözme ve yeniden örnekleme olmadan** Float32'ye (önceki uygulamanın dublaj hızı zaten 48 kHz) → `DubClip[]`. Aynı `dubWav`, aynı oynatıcı, aynı WAV indirme | yeni `studio/lib/serverTts.ts` |
| `useDubber`: `dub(words, duration, choice)` sağlayıcıya dallanır — tarayıcı worker'ı **veya** sunucu istekleri; ikisi de aynı `DubClip[]`/`dubWav`'a yazar. `DubState.done` artık `choice` taşır (bayatlık karşılaştırması `sameChoice`). `cancel()` sunucu isteklerini `AbortController` ile iptal eder. Önizleme (`listen`) iki sağlayıcıda da çalışır ve **önce proje medyasını duraklatır** | `studio/lib/useDubber.ts` |
| `DubPanel`: "Nerede seslendirilsin" radyo grubu (Tarayıcı \| Sunucu (Voxi)); sağlayıcıya özel kontroller (tarayıcı: model/ton/yarım ton/seed; sunucu: model/hız) ve sağlayıcıya özel notlar; `PreviewState` artık hata durumu da gösterir | `studio/components/DubPanel.tsx` |
| `App`: ses seçimi `VoiceChoice`; kaydedilen eski `{model,pitch,seed}` biçimi `loadChoice` ile tarayıcı sağlayıcısına **taşınır** (ayar kaybı yok); `onListen` proje oynatıcısını geçirir | `studio/App.tsx`, `studio/components/Inspector.tsx` |
| **Kaldırıldı:** ikinci dosya-TTS yüzeyi (`TtsPanel`, `<audio controls>` ile ayrı oynatıcı) ve tüm `audio.tsx`; çekmecedeki "Seslendir" sekmesi. Canlı TTS + canlı STT tek **"Canlı"** sekmesinde toplandı; eski "ses"/"tanı" sekme değeri localStorage'dan gelirse Panel'e düşer | `shell/server-drawer.tsx`, silinen `audio.tsx` |
| Yeni testler: `sameChoice` (sağlayıcılar arası asla eşleşmez), `loadChoice` (eski biçim göçü + bozuk veri onarımı), `browserVoice`, `serverVoiceFor` (sunucunun bildirdiği ses adı öncelikli; bilinmeyen model uydurulmaz), katalog kapsamı | yeni `tests/voices.test.ts` (21 test) |

**Doğrulama (Aşama 6):** `tsc --noEmit` temiz · `vite build` OK (CSS 70.83 kB) · `vitest` **74/74** (6 dosya).

**Docker/tarayıcı doğrulaması (yapıldı):** imaj yeniden kuruldu (`voxi-webui:local`) ve `up -d` ile
servis edildi. `https://127.0.0.1:8443/ui/` 200, `http://…:8443/ui/` 400. Servis edilen demette yeni
metinler var ("Seslendirme nerede çalışsın", "Sunucu (Voxi)", "Seslendirilemedi", "Dinlenemedi",
"Yarım ton", "Canlı") ve kaldırılan yüzey yok ("Konuşma Üretimi · TTS" **yok**). Sunucu yolunun verisi
gerçek uçtan doğrulandı: `POST /v1/audio/speech` `{response_format:"pcm", sample_rate:48000}` →
`200`, `Content-Type: audio/pcm`, `x-sample-rate: 48000`, `x-audio-encoding: pcm_s16le`, 188160 bayt =
1.960 s @48 kHz, tepe 0.259 / %91.3 sesli kare — yani `pcmToFloat`'un beklediği biçim ve önceki uygulamanın
dublaj hızı birebir.

**Bilinçli kararlar / sapmalar:**
- **Canlı seslendirme** çalışma alanına değil, çekmecede tek bir **"Canlı"** sekmesine alındı. Canlı
  akışın önceki uygulamada karşılığı yok (çift yetenek değil, Voxi'ye özgü); Aşama 9 (canlı sohbet)
  oturumları çalışma alanına taşırken bu yüzeyi de emer. İnce Denetçi sütununa sıkıştırmak yerine
  tek yerde toplamak seçildi.
- **`lib/player.ts` silinmedi:** tek tüketicisi `lib/studioStore.tsx` (Aşama 7'de kalkıyor). Aşama 6
  bunun yerine asıl birleştirmeyi yapar: önizleme/dublaj proje medyasıyla aynı anda çalmaz (önizleme
  medyayı duraklatır) ve ikinci `<audio controls>` oynatıcısı kalktı. Silme Aşama 7'ye bırakıldı.

**Sunucu sağlayıcısının açık sınırı:** sunucu `speed`'i sesi çeker; bir satır kendi aralığına sığmazsa
taşar (tarayıcı sesi satırı hızlandırarak sığdırır). Panelde yazılı. Sunucu dalga biçimi/aura üretmez
(Aşama 5'teki gibi), dublaj çıkışı gerçek ses örneklerinden gelir — uydurma veri yok.

**Kalan:** tarayıcıda elle tıklama turu (başsız tarayıcı yok): ses listesinde Tarayıcı/Sunucu geçişi,
"Sunucu" ile bir seslendirme çalıştırıp WAV'ı dinlemek/indirmek, "Dinle"nin proje medyasını
duraklattığını görmek. Tarayıcı paketleri (`ema`, `mini`) indirilmediği için tarayıcı yolu model
indirmesi ister; sunucu yolu indirmesiz çalışır.

---

## 7. Aşama 7 teslimi — Tek proje deposu, tek veri modeli

Aynı yetenek (proje saklama) iki kez duruyordu: Voxi'nin `StudioProvider` deposu (`voxi-webui` /
`projects`; ms cinsinden transkript + altyazı stili + medya Blob'u) ve önceki uygulamanın `useProjects`
deposu (`apeksis` / `projects` + `media`; saniye cinsinden kelimeler, caption ayarları, gerçek dalga
biçimi). Artık **tek depo, tek veri modeli, tek liste** var.

| Ne yapıldı | Dosya |
|---|---|
| Tek depo: önceki uygulama `useProjects` kaldı; Voxi deposu ve yardımcıları **silindi** | silinen: `lib/studioStore.tsx`, `lib/idb.ts`, `lib/voxiProject.ts`, `lib/transcript.ts`, `lib/transcriptEdit.ts`, `lib/subtitles.ts`, `lib/player.ts` |
| Tek seferlik içe aktarma: eski `voxi-webui`/`projects` kayıtları okunur, önceki uygulama projesine çevrilir, önceki uygulama deposuna yazılır, `localStorage`'da işaretlenir. Kendi kendine yeterli (eski modüller silindiği için hiçbirini import etmez); eski veriyi **silmez** (güvenlik ağı) | yeni `studio/lib/importVoxiProjects.ts` |
| İçe aktarma, liste okunmadan **önce** çalışır → projeler ilk açılışta oradadır; kaç projenin taşındığı çalışma alanı bildiriminde bir kez söylenir | `studio/lib/useProjects.ts`, `studio/App.tsx` |
| `StudioProvider` kaldırıldı | `src/App.tsx` |
| Dashboard: tek depodan **proje sayısı** okunur; yinelenen "Son projeler" listesi kaldırıldı (tek liste = çalışma alanının proje menüsü; Dashboard zaten Aşama 8'de kalkıyor) | `dashboard.tsx` |
| Voxi testleri kaldırıldı; içe aktarmanın saf dönüşümleri için yeni testler | silinen `tests/{transcript,transcriptEdit,subtitles,voxiProject}.test.ts`; yeni `tests/importVoxiProjects.test.ts` (12 test) |

**Dönüşüm (uydurma yok):**
- **Kelimeler:** `startMs`/`endMs` → saniye, olduğu gibi. Geçersiz/bozuk kayıtlar (boş metin, ters
  zaman, sayı olmayan zaman) atılır — zaman uydurulmaz.
- **Yalnız segment varsa:** her segment tek zamanlı satır olur ve `cue` ile işaretlenir (içe aktarılan
  altyazı dosyasıyla aynı bayrak). Kelime zamanları varsa `cue` konmaz: satır gruplaması önceki uygulamanın
  kendi kurallarına bırakılır (veri korunur, sunum önceki uygulamanın).
- **Stil:** Voxi'nin beş stili önceki uygulamanın beş eşleşen ön ayarına birebir düşer (`klasik/karaoke/
  vurgu/pop/sade`). Konum (`center`→`middle`), büyük harf, renkler, `transparent`→`outline`, iki
  tarafta da olan font (ör. `Inter`→`inter`) taşınır. Punto px cinsindendir ve önceki uygulamanınki kareye
  göre orandır → dürüst çevrim yok, ön ayarın değeri kalır. Değişen anahtarlar `overrides`'a yazılır
  (stil seçicinin kuralı), böylece ön ayar değişince korunur.
- **Dalga biçimi:** medyadan **yeniden hesaplanır** — `PEAK_STEP` (0.1 s) başına bir tepe, o pencerenin
  en büyük mutlak örneği (tanıyıcının doldurduğu birimle aynı). Video/çözülemeyen kap → boş dizi
  (dalga yok), hiçbir şey uydurulmaz. **Bantlar ve ses düzeyi boş kalır:** onlar önceki uygulamanın kendi
  log-mel geçişinden gelir, Voxi'de yoktu.
- **Model/işlem iddiası yok:** Voxi hiçbir zaman önceki uygulama modeli çalıştırmadı → `model` alanı
  **konmaz**; `method` önceki uygulamanın kendi okuyucusunun eksik-işlem için kullandığı geri dönüşü
  (`beam-lm`) alır.
- **Kimlik:** `voxi-<eski id>` — yeniden çalıştırma ikinci kopya değil, aynı projeyi yazar (idempotent).
  Eşzamanlı çağrılar tek koşuyu paylaşır (StrictMode çift bağlaması için).

**Doğrulama (Aşama 7):** `tsc --noEmit` temiz · `vitest` **40/40** (3 dosya) · `vite build` OK
(ana demet 523.5 kB → **508.7 kB**, CSS 70.83 → 70.56 kB).

**Docker/tarayıcı doğrulaması (yapıldı):** imaj yeniden kuruldu ve `up -d` ile servis edildi; tüm
servisler sağlıklı. `https://127.0.0.1:8443/ui/` **200**, `http://…:8443/ui/` **400**. Servis edilen
demet (`index-BNkvjTm8.js`, 508720 bayt) ayrıştırılıyor ve içinde yeni metinler var ("Voxi projesi içe
aktarıldı", "apeksis.voxiImported", "voxi-webui", "İçe aktarılan proje", "Dalga biçimi medyadan
yeniden hesaplandı"); kaldırılan Voxi deposu **yok** ("Yeni proje oluşturuldu", "StudioProvider",
"useStudio" hiçbiri yok).

**Kalan (elle tıklama turu):** eski `voxi-webui` kayıtları olan bir tarayıcıda ilk açılışta bildirimin
görünmesi ve projelerin çalışma alanının proje menüsünde açılması; içe aktarılan bir projede dalga
biçiminin medyadan geldiğini görmek.

**İçe aktarmayı yeniden çalıştırmak (belgelenmiş yol):** içe aktarma tek seferliktir ve
`localStorage`'daki `apeksis.voxiImported` işaretiyle korunur. Eski kayıtlar **silinmediği** için
gerekirse yeniden taşınabilir: tarayıcı konsolunda `localStorage.removeItem("apeksis.voxiImported")`
yazıp sayfayı yenile. İçe aktarılan projeler `voxi-<eski id>` kimliğini taşıdığından ikinci koşu kopya
üretmez, aynı projeyi tazeler. (Aynı yol, bir içe aktarma yarıda kalırsa da geçerlidir.)

---

## 8. Aşama 8 teslimi — Tek yüzey: ayarlar, durum, günlük, modeller

Voxi'nin kendi yüzeyleri hâlâ önceki uygulamanın yanında ayrı ayrı duruyordu: bir **Panel** (ana ekran),
çekmecede ayrı **Ayarlar** ve **Modeller** sekmeleri, ve sağlık/model bilgisi üç yerde (Panel, çekmece
"Sunucu", Voxi panelleri). Artık **tek ayar penceresi, tek durum çubuğu, tek günlük, tek model yüzeyi**
var.

| Ne yapıldı | Dosya |
|---|---|
| **Tek ayar penceresi:** önceki uygulamanın `Settings` penceresine **Sunucu** bölümü eklendi (anahtar, adres, çalışma modu, "Kaydet ve sına"). Voxi'nin çekmecedeki "Ayarlar" sekmesi ve ana ekrandaki "Sunucuya bağlan" kartı kaldırıldı | yeni `studio/components/ServerSettings.tsx`, `studio/components/Settings.tsx` |
| **Tek model yüzeyi:** tarayıcı paketleri (indir/sil/yer) **ve** ağ geçidinin `/v1/models` listesi aynı bölümde. Çekmecedeki "Modeller" sekmesi ve çekmece "Sunucu → Durum" içindeki model listesi kaldırıldı | `studio/components/ModelSettings.tsx`, `shell/server-pane.tsx` |
| **Tek model deposu kodu:** `lib/modelStore.ts` (sayfa kopyası) **silindi**; `studio/worker/modelStore.ts` tek uygulama (aynı `seda-models-v1` önbelleği, yani indirilmiş dosyalar kaybolmaz) | silinen `lib/modelStore.ts`, ayrı model kitaplığı, `components/browser-models.tsx` |
| **Tek durum çubuğu:** önceki uygulama durum çubuğunun sağına ağ geçidi sağlığı eklendi (`/healthz` + `/readyz`, 30 sn'de bir **sessiz** yoklama — günlüğü kirletmez). "Sunucu —" (henüz bakılmadı), "Sunucu çevrimiçi · 2/2 hazır", "Sunucu erişilemedi" | yeni `lib/useGateway.ts`, `studio/components/StatusBar.tsx` |
| **Tek günlük:** çalışma alanının kendi bildirimleri de `lib/debug.ts` kuyruğuna düşer (`kind:"ui"`), yani çekmecedeki **Günlük** hem ağ geçidi çağrılarını hem uygulama bildirimlerini gösterir | `studio/App.tsx`, `lib/debug.ts`, `panels.tsx` |
| **Çekmece daraldı:** yalnız **Sunucu · Canlı · Günlük**. `Dashboard`, `SettingsPanel`, `ModelsPanel`, `StatusPanel` (zaten ölü) silindi; çekmece artık `onFocusStudio` almıyor | `shell/server-drawer.tsx`, `src/App.tsx`, silinen `dashboard.tsx`, `panels.tsx` (yalnız `DebugPanel`) |
| **Gizlilik cümlesi** Dashboard şeridinden **Hakkında** bölümüne taşındı (metnin doğru yeri) | `studio/components/About.tsx` |
| Yeni testler: durum çubuğunun ağ geçidi etiketi (uydurma yok: "—" / "erişilemedi" / gerçek `/healthz` durumu ve worker sayısı) | yeni `tests/useGateway.test.ts` (6 test) |

**Doğrulama (Aşama 8):** `tsc --noEmit` temiz · `vitest` **46/46** (4 dosya) · `vite build` OK
(ana demet 508.7 → **489.3 kB**, CSS 70.56 → **67.56 kB**).

**Docker/tarayıcı doğrulaması (yapıldı):** imaj yeniden kuruldu ve `up -d` ile servis edildi; tüm
servisler sağlıklı. `https://127.0.0.1:8443/ui/` **200**, `http://…:8443/ui/` **400**. Servis edilen
demet (`index-DBLC97dL.js`, 489337 bayt) ayrıştırılıyor; içinde yeni metinler var ("Sunucu çevrimiçi",
"Sunucu erişilemedi", "Sunucu modelleri", "Kaydet ve sına", "Gelişmiş bağlantı ayarları", "Hata
Konsolu", "Sunucu panelleri"), kaldırılan ana ekran **yok** ("Konuşma Üretimi", "Proje Stüdyosu",
"Canlı Mikrofon", "Toplam proje", "Hazır servis", "Yüklü model" hiçbiri yok). Ağ geçidi yanıtları
gerçek: `/healthz` → `{"status":"ok"}`, `/readyz` → `{"status":"ready","workers":{"tts":true,"stt":true}}`
(→ çubukta "Sunucu çevrimiçi · 2/2 hazır"), `/v1/models` → `ema-lightning` + `capabilities`.
`dashboard.tsx`/`browser-models.tsx`/eski model kitaplığı/`modelStore.ts` kaynakta da demette de yok;
ölü modül taraması yalnız barrel/`.d.ts` dosyalarını (yanlış pozitif) gösteriyor.

**Bilinçli kararlar / sapmalar:**
- **"Ses" ayar bölümü açılmadı** (planda geçiyordu): seslendirme/ses seçimi zaten Denetçi'nin
  "Seslendirme" sekmesinde ve sağlayıcı/ses menülerinde **tek yolda**; Ayarlar'a ikinci bir kopya
  koymak "yetenek başına tek yüzey" kuralını çiğnerdi. Bölümler: **Sunucu · Modeller · Hakkında**.
- **Ağ geçidi model listesi** çekmecedeki "Sunucu → Durum"dan kaldırıldı ve Ayarlar → Modeller'e
  taşındı; "Sunucu" sekmesi artık yalnız **durum + uçlar**.
- **Sağlık yoklaması sessiz** (`call(..., silent)`): durum çubuğu 30 sn'de bir `/healthz`+`/readyz`
  sorar ama Günlük'e satır yazmaz; Günlük yalnız **kullanıcının yaptığı** çağrıları ve bildirimleri
  tutar. "Kaydet ve sına" ise bilinçli olarak günlüğe düşer (kullanıcı eylemi).
- **Durum çubuğu telefon genişliğinde gizli** (`max-[860px]:hidden`): 26 px'lik tek satıra iki öğe
  sığmıyor; telefonda ayrıntı zaten çekmecedeki **Sunucu** sekmesinde.
- **Ayarlar artık "Sunucu" bölümüyle açılır** (eskiden "Modeller"): bağlantı durumu ilk bakılacak şey.

**Kalan (elle tıklama turu):** Ayarlar → Sunucu'da "Kaydet ve sına"nın gerçek bir `/v1/models` turu
atması ve sonucu yazması; çalışma alanında bir sunucu çağrısı yapınca hem durum çubuğunun hem Günlük
sekmesinin güncellenmesi; Ayarlar → Modeller'de tarayıcı paketleriyle sunucu modellerinin aynı listede
görünmesi; panelde yalnız üç sekmenin kalması.

---

## 8b. Aşama 8 revizyonu — Marka + tam ekran panel (kullanıcı isteği)

Kullanıcı Aşama 8'i onaylamadan üç değişiklik istedi: **önceki uygulama logo ve isimleri kalksın**, yerine
**Mustafa Tayyar Çalışkan** ve **https://caliskangroup.com/** yazılsın; **GitHub adresi kalksın**;
Sunucu yüzeyi **çekmece gibi değil, bütün bir ekran** olarak açılsın.

| Ne yapıldı | Dosya |
|---|---|
| **Marka:** başlıktaki önceki uygulama logosu (görsel) yerine **metin "Voxi"** kelime işareti; sürüm artık bağlantısız düz metin; **GitHub düğmesi ve `IconGitHub` simgesi kaldırıldı** | `studio/App.tsx`, `shell/icons.tsx` |
| **Hakkında:** logo görseli, eski alan adı, "Kaynak kod / Sürüm notları / Hata bildir" (hepsi GitHub) ve eski yazar adı (LICENSE'daki hatalı kayıtlı isim; bkz. plan §8.5.5 düzeltme) kaldırıldı; yerine **"caliskangroup.com"** bağlantısı ve **"Mustafa Tayyar Çalışkan"** yazısı | `studio/components/About.tsx` |
| **Karşılama ekranı:** önceki uygulama işareti görseli yerine uygulamanın kendi ikonu (`/ui/icon.svg`, zaten Voxi dalga işareti) | `studio/components/Dropzone.tsx` |
| **Eski marka görselleri silindi:** `public/brand/*.png` (4 dosya) kaldırıldı; hiçbir yerde kalmadı | silinen `public/brand/` |
| **Proje dosyası markası:** uzantı **`.voxi`**, biçim **`voxi-project`**, hata metinleri "Voxi" | `studio/lib/projectStore.ts`, `studio/App.tsx`, `studio/components/ProjectsMenu.tsx` |
| **Tam ekran panel:** "Sunucu" yüzeyi artık `absolute inset-0` ile **tüm uygulamayı kaplar** (araç çubuğu ve durum çubuğu dâhil), kendi başlığı (ad + sekmeler + kapat) vardır; yeniden boyutlandırma tutamacı ve yükseklik deposu kaldırıldı | `shell/server-drawer.tsx` |
| **İç isimler:** konsol önekleri `[voxi]`, mikrofon worklet'i `voxi-tap`, altyazı font aileleri `Voxi Caption/Probe`, model modülü **`lib/models.ts`** | `studio/lib/useTranscriber.ts`, `studio/render/compositor.ts`, `studio/lib/microphone.ts`, `studio/captions/{fonts,userFonts}.ts`, `lib/models.ts` |
| Yeni testler: proje dosyası biçimi — yeni biçim yazılır, **eski biçim okunur**, uzantı kontrolü | yeni `tests/projectStore.test.ts` (4 test) |

**O aşamadaki karar (sonradan değişti):** `localStorage` anahtarları, IndexedDB veritabanı adı ve
medya kimliği veri güvenliği için bilinçli olarak **değiştirilmemişti**; kod yorumlarındaki ürün adı
da kökeni anlatan dürüst mühendislik notu olarak bırakılmıştı. **Bu karar sonradan tersine çevrildi:**
ürün adı hiçbir yerde istenmediği için anahtarlar `apeksis.*` adlarına taşındı ve o dönemin dosya
uzantısı/biçimi artık okunmuyor (bkz. `docs/plan-3-server-first.md` §8.5.7).

**Doğrulama (8b):** `tsc --noEmit` temiz · `vitest` **50/50** (5 dosya) · `vite build` OK
(ana demet 489.3 → **486.7 kB**, CSS 67.56 → 67.08 kB).

**Docker/tarayıcı doğrulaması (yapıldı):** imaj yeniden kuruldu, tüm servisler sağlıklı.
`https://127.0.0.1:8443/ui/` **200**, `http://…` **400**. Servis edilen demet (`index-D9N5QvAC.js`,
486687 bayt) ayrıştırılıyor; içinde **"caliskangroup.com"**, **"Mustafa Tayyar Çalışkan"**,
**".voxi"**, **"voxi-project"**, "Sunucu panelini kapat" var; **"github.com"**, eski GitHub
kullanıcı adı,
**ürün adı**, **logo kimlikleri**, **eski yazar adı**,
**eski alan adı** hiçbiri yok. Eski `/ui/brand/` logo yolları artık **görseli değil**, SPA
yedek `index.html`'i (1005 bayt, `<!doctype html>`) döndürüyor — yani eski logo sunulmuyor.
`/ui/icon.svg` **200** (karşılama ekranının yeni işareti).

---

## 8c. Marka geçişi — Apeksis (kullanıcı isteği)

Kullanıcı projenin adını **Apeksis** olarak belirledi ve değiştirilebilen her yerde bu adın
görünmesini istedi.

| Ne yapıldı | Dosya |
|---|---|
| **Kelime işareti:** "Apeksis" artık uygulamanın kendi ekran fontuyla (Google Sans Flex) yazılıyor; görsel yok, font yüklenene kadar gizli | yeni `shell/wordmark.tsx`, `studio/App.tsx`, `studio/components/About.tsx` |
| **Sayfa/meta:** başlık, açıklama, manifest adı ("Apeksis Ses Çalışma Alanı"), paket adı `apeksis-webui` | `index.html`, `public/manifest.webmanifest`, `package.json` |
| **Proje dosyası:** uzantı `.voxi` → **`.apeksis`**, biçim `voxi-project` → **`apeksis-project`**; **eski `.voxi` dosyaları + `voxi-project` biçimi okunur, asla yazılmaz** | `studio/lib/projectStore.ts` |
| **Arayüz etiketleri:** "Sunucu (Voxi)" → **"Sunucu (Apeksis)"**; sağlayıcı menüsü, durum çubuğu, seslendirme paneli, denetçi, model ayarları | `ProviderMenu.tsx`, `StatusBar.tsx`, `DubPanel.tsx`, `Inspector.tsx`, `ModelSettings.tsx`, `ServerSettings.tsx` |
| **İç adlar:** konsol önekleri `[apeksis]`, mikrofon worklet'i `apeksis-tap`, PCM worklet'i `apeksis-pcm-source`, font aileleri `Apeksis Caption/Probe` | `studio/lib/{useTranscriber,microphone}.ts`, `lib/audio.ts`, `captions/{fonts,userFonts}.ts`, `render/compositor.ts` |
| Yeni testler: geçerli uzantı ve ondan önceki uzantı okunur, yalnız `.apeksis`/`apeksis-project` yazılır | `tests/projectStore.test.ts` (4 test) |

**O aşamadaki karar (sonradan değişti):** `localStorage` anahtarları (`apeksis.*`, `voxi.apiKey`,
`voxi.baseUrl`, `voxi.ui.panel.*`, `apeksis.voxiImported`) ve IndexedDB veritabanı adları
(`apeksis`, `voxi-webui`) ile medya kimliği (`apeksis-media`). `voxi.*` ve `voxi-webui` kimlikleri
**hâlâ korunur**; arayüz anahtarları ise sonradan ad temizliğinde `apeksis.*`'e taşındı (§8.5.7).

**Sunucu tarafı adı henüz değişmedi:** Python paketi `src/voxi`, `VOXI_*` ortam değişkenleri, compose
servis/imaj adları (`voxi-webui:local`, `voxi_safe` nginx bölgesi). Bu, **çalışan yığını** etkilediği
için ayrı ve açık bir adım olarak önerilecek.

**Doğrulama (8c):** `tsc --noEmit` temiz · `vitest` **50/50** · `vite build` OK · imaj yeniden kuruldu ·
`https://127.0.0.1:8443/ui/` **200**, HTTP **400** · servis edilen demet marka kontrolünden geçti
(Apeksis/caliskangroup.com/Mustafa Tayyar Çalışkan/`.apeksis`/`apeksis-project` var; "Voxi",
"github.com", "önceki uygulama" ve eski yazar adı yok).

---

## 9. Aşama 9 teslimi — Canlı sohbet çalışma alanında

**Sonuç:** Oturum ayrı bir panel değil; **çalışma alanının bir modu**. Transkript panelinin üstünde
tek bir **oturum çubuğu** var. İkinci bir metin kutusu, ikinci bir liste, ikinci bir oynatıcı yok.

| Ne yapıldı | Dosya |
|---|---|
| **Oturum çubuğu:** "Oturum başlat" → sunucuda oturum; **boş çalışma alanında mikrofonu da açar**, açık bir döküm varsa ona bağlanır (kaydı ezmez). Açıkken: mikrofon düğmesi, tur sayısı, "Seçileni gönder", "Son turu gönder", "Bitir" | yeni `studio/components/SessionBar.tsx` |
| **Tur seçimi:** "Seçileni gönder" dökümdeki gerçek seçimi (`selectionchange`) kullanır; "Son turu gönder" en yeni **cue** sınırını, yoksa son cümleyi, yoksa son 25 sözcüğü alır — hiçbir sınır uydurulmaz | yeni `studio/lib/turns.ts` (5 test) |
| **Oturum durumu:** `POST /v1/sessions`, `POST …/turns`, `DELETE /v1/sessions/{id}`; dönen `action` (kind + metin + ses) alan alan gösterilir; hata sunucudan geldiği gibi yazılır | yeni `studio/lib/useSession.ts` |
| **Yanıtı okuma:** `WS /v1/tts/stream` (48 kHz PCM, 100 ms) → `PcmPlayer`; **önce medya duraklatılır**; "ilk ses" ve süre sunucunun kendi değerleridir | yeni `studio/lib/useServerSpeak.ts` |
| **Canlı sunucu STT:** bilet (`audio:write`) → `WS /v1/realtime/transcriptions` (`session.start`: `whisper-1`, `tr`, 16 kHz) → el sıkışma → mikrofon (Float32 + MediaRecorder) → `resampleLinear` + `floatTo16BitPcm` → PCM16 gönderilir | yeni `studio/lib/serverLive.ts` |
| **Zaman dürüstlüğü:** her final, sunucunun **gerçek** `speech.started`/`speech.ended` aralığına oturur; sözcükler o aralıkta eşit dağıtılır (akış protokolü sözcük zamanı vermiyor — altyazı içe aktarmayla aynı sözleşme) ve ilk sözcük `cue: true` işaretlenir, böylece altyazı satır sınırı sunucunun sınırı olur | `studio/lib/serverLive.ts` (5 test) |
| **Dalga yerelden ölçülür:** tepe 100 ms'de bir (`PEAK_STEP`), bant ve gürlük `BAND_RATE` çerçevelerine yayılır; hiçbiri dökümden uydurulmaz | `studio/lib/useTranscriber.ts` (`withAudioBlock`), `render/aura.ts` (`LiveMeter`) |
| **Kayıt dosyası:** canlı sunucu yolunda da iş **gerçek bir `File`** alır (`mic.stop()`), böylece proje kaydı, dub ve dışa aktarma aynı yoldan çalışır; `decoded`/`elapsed`/`speed` gerçek ölçümlerdir | `studio/lib/useTranscriber.ts` |
| **İki yüzey kalktı:** sol panelin "Oturumlar" sekmesi (`leftTabs` köprüsü tamamen kaldırıldı) ve çekmecenin "Canlı" sekmesi; `sessions.tsx` + `stream.tsx` silindi | `studio/App.tsx`, `shell/server-drawer.tsx`, `src/App.tsx`, silinen `sessions.tsx`/`stream.tsx` |
| **Ölü kod:** `MicPcmSource` + worklet + `rmsLevel` (tek kullanıcısı silinen `stream.tsx`'ti) kaldırıldı | `lib/audio.ts` |
| **Yanlış mesaj düzeltildi:** "Canlı kayıt sunucu sağlayıcısında yok" uyarısı kalktı; sunucu sağlayıcısı artık kaydı engellemiyor | `studio/App.tsx` (`micBlocked`) |

**Bilinçli sınır (Aşama A'da kaldırıldı — bkz. §15):** Oturumun kendisi (`/v1/sessions`) sunucuda
**n8n** yapılandırması ister. Bu depoda `VOXI_N8N_API_KEY` boş olduğu için `POST /v1/sessions`
`n8n_unconfigured` döndürür; çubuk bu hatayı olduğu gibi gösterir. Bu, eski `SessionsPanel`'in de
sınırıydı — yeni bir kısıt değil. **Aşama A bu bağımlılığı kaldırdı:** canlı mod artık ajan oturumundan
bağımsız, oturum ilk gönderimde açılıyor.

**Doğrulama (9):** `tsc --noEmit` temiz · `vitest` **60/60** (7 dosya) · `vite build` OK (ana demet
487.1 → **477.3 kB**, CSS 66.98 → 65.62 kB) · imaj yeniden kuruldu · `https://127.0.0.1:8443/ui/`
**200**, HTTP **400**.

**Canlı uçtan uca (yapıldı):** tek kullanımlık bilet → `WS /v1/realtime/transcriptions` →
`session.start` (`whisper-1`/`tr`/16 kHz) → **`session.started`** (`mode=windowed`, gerçek VAD
parametreleri) → 1,5 s PCM16 → `speech.started`/`speech.ended` (0 → 1500 ms) → `transcript.final` →
`session.stop` → **`session.ended`**. Ayrıca `WS /v1/tts/stream`: `meta` 48 kHz `pcm_s16le` →
14 parça → `done` (1360 ms, 130 616 bayt). Servis edilen demette "Oturum başlat", "Seçileni gönder",
"Son turu gönder", "ilk ses", `v1/realtime/transcriptions`, `/v1/sessions` var; `"canli"` ve
`"oturumlar"` sekme kimlikleri ile `voxi-pcm-source` yok.

---

## 9b. Sunucu yüzeyi Ayarlar'a gömüldü (kullanıcı isteği)

**İstek:** "Sunucu kısmını ayarların içine gömelim; tüm sistemler birbiriyle uyumlu olsun, optimize
et, test et, üretime hazır hale getir."

**Sonuç:** §8b'nin **tam ekran "Sunucu" paneli kalktı**. Gateway'in tamamı artık **Ayarlar'ın bir
bölümü** — tek pencere, tek günlük, tek sağlık kaynağı. Ayarlar dört bölüm: **Sunucu · Modeller ·
Günlük · Hakkında**.

| Ne yapıldı | Dosya |
|---|---|
| **Tek pencere:** dört bölüm, solda liste. Görünen bölüm **uygulamada** tutulur ve hatırlanır (`settings.section`); bayat bir kimlik boş sayfa açmaz, `settingsSection()` varsayılana düşer | `studio/components/Settings.tsx`, yeni `studio/lib/settingsSections.ts` (6 test) |
| **Sunucu bölümü üç blok:** **Bağlantı** (anahtar/URL + "Kaydet ve sına") · **Durum** (canlılık + servisler + son kontrol) · **Uçlar** (`/v1/endpoints` kataloğu) | yeni `studio/components/ServerSection.tsx`, `studio/components/ServerConnection.tsx` (eski `ServerSettings.tsx`) |
| **Tek sağlık kaynağı:** Durum bloğu **kendi isteğini atmaz**; durum çubuğunun gördüğü aynı `gateway` durumunu okur. "Yenile" tam olarak o yoklamayı tetikler. `/healthz` + `/readyz` için **tek çağıran** kaldı | `lib/useGateway.ts` (`GatewayHealth.refresh`), `studio/components/ServerSection.tsx` |
| **Tembel katalog:** `/v1/endpoints` yalnızca bölüm görünürken okunur; görünmeyen bölüm veri çekmez (`active`) | `studio/components/Settings.tsx` |
| **Tek günlük:** eski "Hata Konsolu" kartı yerine Ayarlar → Günlük; aynı `lib/debug.ts` deposu, kabuk diliyle aynı tablo | yeni `studio/components/LogSection.tsx` (eski `src/panels.tsx`) |
| **Durum çubuğu artık bir düğme:** gateway satırına basmak **Ayarlar → Sunucu**'yu açar; başlık/`aria-label` bunu söyler | `studio/components/StatusBar.tsx` (`onOpenServer`) |
| **Kabuk sadeleşti:** `overlay` yuvası, `ServerDrawer`, `ServerPane`, `useStoredFlag`, `usePanelHeight`, `useLatest` kaldırıldı (hepsi tek kullanıcısını yitirdi) | `shell/app-shell.tsx`, `shell/index.ts`, `shell/panels.ts`, silinen `shell/server-drawer.tsx`/`shell/server-pane.tsx`/`src/panels.tsx` |
| **Erişilebilirlik:** bölüm listesi gerçek bir **sekme listesi** (`role=tablist/tab/tabpanel`, `aria-controls`, `aria-selected`, roving `tabindex`, ok/Home/End tuşları, görünür odak halkası) | `studio/components/Settings.tsx` |
| **Ortak blok dili:** `SettingsBlock` (başlık + isteğe bağlı eylemler) tasarım sistemine eklendi; Sunucu ve Günlük bölümleri aynı dili konuşur | `shell/ui.tsx` |

**Bilinçli olarak yapılmayanlar:** "Bağlantıyı sına" hâlâ gerçek bir `/v1/models` çağrısıdır (Modeller
bölümü listeyi gösterir; sına, erişilebilirliği sınar — aynı uç, farklı soru). "Sunucu (Apeksis)"
etiketleri, `.apeksis` biçimi ve iç veri kimlikleri (`voxi.*`, `apeksis.*`) §8c kararıyla aynen kalır.

**Doğrulama (9b):** `tsc --noEmit` temiz · `vitest` **66/66** (8 dosya) · `vite build` OK (ana demet
477,3 → **475,3 kB**, CSS 65,62 → **65,76 kB**) · imaj yeniden kuruldu + `up -d webui` (healthy) ·
`https://127.0.0.1:8443/ui/` **200**, HTTP **400**, COOP/COEP yerinde, `/readyz` 2/2 · ölü modül
taraması: **0 orphan** (yalnızca 6 barrel/`.d.ts`) · servis edilen demet (`index-BU7d9zsr.js`)
`check9b` + `check9` (Aşama 9 regresyonu) + `check8c`'den geçti · **gerçek gateway verisiyle** duman
testi: `/healthz` 200 · `/readyz` `tts:true stt:true` · `/v1/endpoints` **6 uç** (hepsi
method/path/service/purpose dolu) · `/v1/models` **3 model** · `/ui/runtime.json` `loopback
needKey=false`.

---

## 10. Aşama 10 teslimi — Cila, gerçek temizlik, kabul kanıtı

**Gerçek temizlik (ölü dışa aktarım taraması).** `src` ağacındaki her dışa aktarımın adı tüm
ağaçta sayıldı; yalnızca kendi bildiriminde geçenler "ölü" sayıldı. 10 adaydan, tek tüketicisini
yitirenler silindi, motor/kütüphane yardımcıları bilinçli olarak bırakıldı:

| Silindi | Neden |
|---|---|
| `src/components/ui.tsx` (ve boşalan `src/components/`) | Yalnızca silinen `src/panels.tsx`'in kullandığı "uyumluluk barrel"ı — gerçek orphan modül (orphan taraması basename eşlediği için kaçırmıştı) |
| `shell/ui.tsx` → `Toast`, `useToasts`, `TOAST_TONE`, `ToastViewport` | Hiçbir yere bağlanmamış yarım bildirim özelliği; kaldırılınca CSS de 65,76 → **65,02 kB** düştü |
| `shell/menu.tsx` → `MenuLink`, `itemClass`'ın `ready` parametresi | İndirme bağlantısı menüsü ModelSettings'e taşınınca tek kullanıcısını yitirdi |
| `shell/icons.tsx` → `IconCopy` | Kopyala/GitHub düğmeleri §8b'de kalktı |
| `api/client.ts` → `shortId`, `_sessionPathForDebug` | Hata ayıklama artığı; yolu zaten `redactPath` kısaltıyor |
| `lib/settings.ts` → `setApiKey`, `setBaseUrl` | Silinen giriş kartının artığı (`hasStoredKey` kalır) |

**Bilinçli olarak bırakılanlar** (ölü ama zararsız — ağaç-sarsıntısıyla paketten çıkıyor,
sürüm denetimi yok, ileride bir yüzey yeniden yazmasın): tasarım sisteminin genel primitifleri
`Tabs`, `Dialog`, `Tooltip`; motor yardımcıları `spellNumber`, `ordinalWord` (`numbers.ts`),
`hasFont` (`fonts.ts`), `LANG_NAMES` (`translation.ts`), `VoiceProvider` (`voices.ts`). Bunlar
`shell/ui.tsx` başlığında da not edildi.

**Yüzey denetimi (madde 8).** Her yetenek tek yüzeyde: sağlayıcı seçimi `ProviderMenu` (STT) ve
Inspector → Seslendirme (TTS); model **seçimi** `ModelMenu`, model **deposu/indirme**
`ModelSettings`, model **listesi** Ayarlar → Modeller; anahtar/URL yalnızca Ayarlar → Sunucu
(`saveSettings`'in tek çağıranı); sağlık yalnızca `useGateway` (tek çağıran: `studio/App.tsx`);
günlük yalnızca Ayarlar → Günlük; proje listesi tek kaynak (`useProjects`), menü + karşılama
ekranı aynı diziyi gösterir; Inspector sekmeleri `captions/transcribe/dub` — Sunucu/Model/Sağlık
ile çakışma yok.

**Birebir kabul listesi — kod düzeyinde kanıt**

| # | Madde | Kanıt |
|---|---|---|
| 1 | Tek sağlayıcı menüsü, kalıcı seçim | `useTranscriber.ts` `PROVIDER_KEY = "apeksis.provider"`; TTS seçimi `VoiceChoice` Inspector → Seslendirme |
| 2 | İki sağlayıcı aynı yere yazar, undo dahil | `runServer` aynı `Job`'u doldurur (`words`/`duration`/`elapsed`); undo `App.tsx` `history` yalnızca `job.words` üzerinde çalışır |
| 3 | İki sağlayıcı aynı dub kanalına düşer | `useDubber` her iki yol da `{status:"done", clips, url, words, choice, elapsed}` üretir |
| 4 | Tek oynatıcı | `useDubPlayback`: dub çalarken `el.volume = 0`, ana oynatıcı duraklatınca dub duraklar; `useServerSpeak` konuşmadan önce `player.el`'i duraklatır |
| 5 | Tek proje listesi | `listProjects` tek çağıran `useProjects`; Dashboard §8'de kalktı; menü + karşılama aynı `saved` dizisi |
| 6 | Tek ayar penceresi, tek sağlık çubuğu, tek günlük | §9b: `Settings` 4 bölüm; `gatewayLabel` yalnızca `StatusBar`; `LogSection` tek tablo |
| 7 | Tek model yüzeyi ve deposu | `downloadPacks` yalnızca `ModelSettings`; `lib/modelStore.ts`/`browser-models.tsx` §8'de silindi |
| 8 | İkinci yüzey yok | Yukarıdaki yüzey denetimi |

**Doğrulama (10):** `tsc --noEmit` temiz · `vitest` **66/66** (8 dosya) · `vite build` OK (ana demet
**475,33 kB** sabit, CSS 65,76 → **65,02 kB**) · ölü dışa aktarım **10 → 5** (hepsi bilinçli) ·
ölü modül taraması **0 orphan** (6 barrel/`.d.ts`) · imaj yeniden kuruldu + `up -d webui` (healthy) ·
`/ui/` **200**, HTTP **400**, COOP/COEP yerinde · servis edilen demet (`index-DZuHN0Ha.js`)
`check9b` + `check9` + `check8c` + gerçek gateway duman testi (`smoke9b`) → **hepsi geçti**.

**Kalan tek adım:** birebir kabul listesinin tarayıcıda gözle onaylanması (madde 1-8) — ajanın
tarayıcısı yok.

---

## 11. Varsayılan sağlayıcı: Sunucu (kullanıcı isteği)

**İstek:** "Hem sunucuda hem isteğe göre kullanıcının bilgisayarında çalışacak şekilde
yapılandırdık değil mi? Varsayılan olarak sunucu seçili olarak gelebilir mi? Docker'da da."

**Önce mevcut durum (cevap):** İki eksen de kuruluydu ama **varsayılan tarayıcıydı** — STT
`loadProvider()` kayıtlı seçim yoksa `"auto"` (WebGPU→WASM) dönüyordu, seslendirme `DEFAULT_CHOICE`
ise tarayıcı EMA Lightning'ti.

**Sonuç:** Varsayılan **sunucu** oldu, iki eksende de. Gerekçe: `/ui/` zaten gateway dağıtımının
içinde servis edilir (nginx `/ui/`'yi sunar, `/v1`'i aynı kaynaktan proxy'ler), yani sunucu yolu
**ilk açılışta** çalışır — tarayıcı paketleri ise henüz indirilmemiştir. "Tarayıcı" tek tık
uzakta ve seçim hatırlanır.

| Ne değişti | Dosya |
|---|---|
| STT varsayılanı `"auto"` → `"sunucu"`; kayıtlı seçim yine birebir korunur | `worker/protocol.ts` (`DEFAULT_STT_PROVIDER`, `providerOrDefault`), `studio/lib/useTranscriber.ts` (`loadProvider`) |
| Seslendirme varsayılanı sunucu sesi (`ema-lightning`/`ema-tr`) oldu; tarayıcı varsayılanı ayrı sabit olarak kaldı | `studio/lib/voices.ts` (`DEFAULT_CHOICE` = sunucu, yeni `BROWSER_CHOICE`, `DEFAULT_SERVER_VOICE`), `studio/components/DubPanel.tsx` ("Tarayıcı" düğmesi artık `BROWSER_CHOICE`) |
| Kayıtlı seçim **asla** ezilmez: eski tarayıcı şekli (`{model,pitch,seed}`) tarayıcıya taşınır | `studio/lib/voices.ts` (`loadChoice` yalnızca `raw == null` iken varsayılana düşer) |
| **Uyum:** model menüsü sunucu seçiliyken "bu model yalnızca Tarayıcı seçildiğinde kullanılır" der; başlık ipucu da öyle | `studio/components/ModelMenu.tsx` (`server` bayrağı), `studio/App.tsx` (`modelProps.server`) |

**İlk açılışta indirme yok.** Sunucu seçiliyken worker'a hiç `init` gitmez
(`useTranscriber`: `if (!server) prepare()`), yani tarayıcı ASR/TTS paketi indirilmez.

**Sunucu yolu uçtan uca gerçek veriyle sınandı** (TTS ile üretilen bir WAV, aynı gateway'in STT'sine
geri verildi): `POST /v1/audio/speech` → 200 (113.324 bayt) · `POST /v1/audio/transcriptions`
(`verbose_json`, segment+word) → 200, `"Merhaba Dünya. Bu bir deneme cümlesidir."` — **noktalama ve
büyük harf sunucudan geliyor**, kelime zamanları gerçek. `App.tsx` sunucu işlerinde tarayıcı
noktalama modelini zaten atlar (`if (job.server) { … applyNumbers(); return; }`), yani bu yolda
noktalama modeli indirilmez.

**Bilinçli olarak değişmeyen davranış (dürüstçe):** sunucu yolu dosya dalga biçimini (peaks/bands/
loudness) üretmez — bu §5 kararıdır ve menüde/ayakta yazılıdır. Sunucu varsayılan olduğunda ilk
kullanıcı zaman çizelgesinde **dalga biçimi görmez**; kelimeler, zamanlar, altyazılar ve seslendirme
tam çalışır. Dalga biçimini geri istersen tek küçük adım yeter: dosyayı tarayıcıda yalnızca
peaks/bands için çözmek (tanıma yine sunucuda) — istenirse yapılır.

**Doğrulama (11):** `tsc --noEmit` temiz · `vitest` **72/72** (9 dosya; yeni `tests/provider.test.ts`
+ `voices.test.ts` varsayılan testleri) · `vite build` OK (ana demet 475,33 → **475,67 kB**) · ölü
dışa aktarım **5** (değişmedi), ölü modül **0 orphan** · imaj yeniden kuruldu + `up -d webui`
(healthy) · `/ui/` **200**, HTTP **400**, COOP/COEP yerinde · **servis edilen demette** doğrulandı
(`index-etlOG_M9.js`): `const Mv="sunucu";function e3(l){return l==="auto"||l==="webgpu"||l==="wasm"||l==="sunucu"?l:Mv}`
ve `Ig={provider:"sunucu",model:Tc.model,voice:Tc.voice,speed:1}` (tarayıcı sabiti `Uk` ayrı duruyor)
· yeni `check10b` (8/8) + `check9b` + `check9` + `check8c` + `smoke9b` → **hepsi geçti**.

---

## 12. Sonraki adım (öneri) — derin Apeksis yeniden adlandırması

§8c **kullanıcıya görünen** her şeyi Apeksis yaptı ve **veri kimliklerini** bilinçli olarak bıraktı.
Geriye **çalışan yığını** etkileyen iç adlar kaldı: paket `src/voxi`, `VOXI_*` ortam değişkenleri,
compose servis/imaj adları, nginx `voxi_safe`, Docker imajı `voxi-webui:local`. Bunlar bir
`compose down/up`, `.env` ve nginx değişikliği gerektirir; bu yüzden ayrı bir adım olarak
sunulur — istenirse yapılır.

---

## 13. Model envanteri + tutarlılık düzeltmeleri (kullanıcı isteği)

**İstek:** "Belirlenmiş olan her model hem stüdyomuzda hem de sunucu API tarafında kullanılabilir
durumda mı?" Ardından (Adım 1, **yığını yeniden başlatmadan**): yanıltıcı `npm run models`
mesajlarını ve eskimiş README bölümünü düzelt; OpenAI uyumlu istemcilerin model keşfi için
`/v1/models`'a `tts-1` ekle; envanteri ve `prepare_models.py` ↔ sunucu `manifest.json` çakışmasını
belgeye kaydet.

**Kısa cevap:** İki katalog **simetrik değil** — ve stüdyonun **tarayıcı** tarafında bugün **hiçbir**
paket kurulu değil (hepsi indirme bekliyor). Sunucu tarafı çalışıyor. Bu bir hata değil: §11 ile
varsayılan **sunucu** olduğu için ilk açılış hiç indirme gerektirmiyor.

### 13.1 Sunucu API envanteri (`/v1/models`, canlı ölçüm)

`/v1/models`, worker'ların `/internal/models` listelerinin birleşimidir (`gateway.py`).

| id | tür | motor | durum |
|---|---|---|---|
| `ema-lightning` | TTS | EMA (PyTorch) | ✅ çalışıyor · tek fiziksel ses `ema-tr` |
| `whisper-small` | STT | faster-whisper-small | ✅ çalışıyor |
| `whisper-1` | STT **takma adı** | faster-whisper-small | ✅ çalışıyor (aynı motor; `stt.py` duyuruyor) |
| `tts-1` | TTS **takma adı** | ema-lightning | ✅ **bu adımda eklendi** (`tts.py`; yalnızca EMA worker'ı duyurur) |

Katalogda olmayan ama var olan / desteklenen:

- **`antalia-mini`:** dosyalar hem `models/antalia-mini/` hem `voxi_antalia-models` volume'ünde
  **hazır**, servis tanımı var — ama `profiles: [antalia]` ve `.env`'de `ANTALIA_URL=` boş, yani
  **başlatılmıyor ve yönlendirilmiyor**. İki opt-in gerekiyor (Adım 2).
- **`whisper-large-v3-turbo`:** envanterde (`inventory.py`) tanımlı; ne servis ne dosya var.
- **Noktalama (`punctuation-tr`)** ve **çeviri:** sunucuda **hiç uç yok** — ikisi de tarayıcıya özel
  (`/v1/endpoints` altı uç verir, hiçbiri bunlar değil).

### 13.2 Stüdyo (tarayıcı) envanteri — katalog 8 paket, kurulu **0**

| Paket | `dir` | manifest | diskte? |
|---|---|---|---|
| Seda (ASR) | `seda-v0.1` | `model.json` | ❌ |
| Duyu (ASR) | `duyu-small` | `model.json` | ❌ |
| Whisper Turbo Hafif / Turbo | `whisper-large-v3-turbo` | `model.json` | ❌ |
| Noktalama | `punct` | `punct.json` | ❌ |
| İngilizce çeviri | `opus-mt-tc-big-tr-en` | `model.json` | ❌ |
| EMA Lightning (TTS) | `ema-lightning` | `model.json` | ❌ (diskte **sunucu** biçimi: `.pt`) |
| Antalia Mini (TTS) | `antalia-mini` | `model.json` | ❌ (diskte **sunucu** biçimi: `.safetensors`) |

**Kanıt (canlı proxy'den):** `/models/seda-v0.1/encoder.webgpu.onnx` → **404**,
`/models/ema-lightning/text.onnx` → **404**, `/models/punct/punct.int8.onnx` → **404**; ayrıca
`models/` ağacında **tek bir `model.json` manifesti yok** (stüdyo önce onu okur).

**Sunulma yolu doğru kurulu:** `webui` konteyneri `./models` dizinini
`/usr/share/nginx/html/models`'a bind-mount eder ve `webui/nginx.conf` `/models/` altını
`gzip off` + `default_type application/octet-stream` ile sunar (ORT-Web aralıklı okur). Yani
boru hattı hazır; **dosyalar yok**.

### 13.3 Neden böyle — iki farklı artefakt biçimi

Sunucu **PyTorch/safetensors/CTranslate2** kullanır (`.pt`, `.safetensors`, `model.bin`); tarayıcı
**ONNX** ister. Aynı modelin iki tarafı **farklı dosya** ister. Tarayıcı paketlerini üreten betik
(`example-projects/reference-app/scripts/prepare_models.py`) çıktıyı **önceki uygulamanın `public/models/`
dizinine** yazar — Voxi'nin `models/` dizinine değil. Köprü hiç kurulmamış.

**Kurulum yolu (istenirse):** `prepare_models.py` çalıştır → çıkan `public/models/<paket>/`
dizinlerini bu deponun `models/` dizinine kopyala. (Adım 1'de **yapılmadı**: ~3 GB indirme ve
aşağıdaki çakışma nedeniyle kullanıcı kararıyla ertelendi.)

### 13.4 ⚠️ Çakışma: `antalia-mini/manifest.json`

`models/` dizini iki ad alanını **paylaşır**: sunucu biçimi ve (kurulduğunda) tarayıcı biçimi.
Çoğu dizinde çakışma yok (`.pt` ↔ `.onnx`, `whisper-small/` ↔ `whisper-large-v3-turbo/`,
`punctuation-tr/` ↔ `punct/`). **Tek çakışma `antalia-mini/manifest.json`:**

- Sunucunun provisioner'ı (`scripts/provision_models.py`) her modele **hash-doğrulamalı**
  `manifest.json` yazar (`schema_version`, `repo`, `revision`, `files[].sha256`); `--verify-only`
  bunu okur. `models/antalia-mini/manifest.json` bu dosyadır.
- `prepare_models.py`'nin `prepare_mini()`'si, HF Space'ten indirdiği **başka bir `manifest.json`**'ı
  **aynı yola** yazar (kendi `model.json`'unu ondan türetir).

Kopyalama sırasında bu dosya **ezilirse** sunucunun bütünlük doğrulaması kırılır.

**Çözüm (karar):** tarayıcı paketinin `manifest.json`'ı **`manifest.web.json`** adıyla saklanır
(veya hiç kopyalanmaz — tarayıcı onu okumaz, yalnız `model.json`'ı okur). Sunucunun
`manifest.json`'ı **asla** ezilmez. `prepare_ema()` zaten `manifest.json` yazmaz (yalnız
`meta.json` + `model.json`), yani EMA tarafında çakışma yoktur.

### 13.5 Bu adımda yapılan düzeltmeler

| Düzeltme | Dosya |
|---|---|
| **Yanıltıcı `npm run models` mesajları kaldırıldı** (bu projede öyle bir script **yok**). Yerine dürüst, eyleme dönük mesaj: paketin **kurulu olmadığı dizin** + **HTTP durumu** + iki gerçek çare ("paketi sunucuya kurun" / `"Sunucu"` sağlayıcısını seçin). ASR/çeviri/noktalama için sunucu karşılığı olmadığından yalnız kurulum yolu yazılır | `studio/worker/{tts,mt,asr}.worker.ts` (4 yer) |
| **`tts-1` alias'ı `/v1/models`'a eklendi** (OpenAI uyumlu istemci keşfi). Gerçeği söyler: alias'ı **yalnızca** onu gerçekten sunan EMA worker'ı duyurur; `antalia-mini` worker'ı duyurmaz (gateway `tts-1`'i EMA'ya yönlendirir) | `src/voxi/workers/tts.py` |
| **Çift ses önlendi:** `tts-1` ile `ema-lightning` aynı fiziksel sesi (`ema-tr`) sürer; seslendirme menüsü artık **fiziksel ses başına tek satır** gösterir ve **gerçek model kimliği** alias'ı yener (sıradan bağımsız). Saf fonksiyon `uniqueServerVoices` + 6 test | `studio/lib/voices.ts`, `tests/voices.test.ts` |
| **README'nin eskimiş "önceki uygulama studio tab" bölümü** tek `/ui/` uygulaması + Apeksis + Tarayıcı/Sunucu ekseni + gerçek paket kurulum yolu (ve `manifest.web.json` notu) ile değiştirildi | `README.md` |
| **`webui/nginx.conf` model yorumu** düzeltildi: "önceki uygulama model packs" → "browser model packs"; doğrulamanın yapıldığı dosya `manifest.json` değil **`model.json`** | `webui/nginx.conf` |
| **Önceden var olan 6 `ruff check` E501 ihlali** (`/v1/endpoints` katalog satırları, davranış değişmeden çok satıra alındı) — depo kendi lint komutundan geçsin diye | `src/voxi/gateway.py` |
| Yeni testler: `uniqueServerVoices` (tek satır/fiziksel ses, sıradan bağımsızlık, farklı sesler, yalnız-alias durumu, STT dışlama, bilinmeyen ses dışlama) | `tests/voices.test.ts` (+6) |
| Yeni test sözleşmesi: `/internal/models` EMA'da `["tts-1", "ema-lightning"]`, Antalia'da yalnız kendi id'si | `tests/test_providers.py` |

### 13.6 Doğrulama (Adım 1)

- `tsc --noEmit` **temiz** · `vitest` **78/78** (9 dosya; +6 yeni) · `vite build` OK
  (ana demet 475,67 → **475,85 kB**, CSS **65,02 kB** sabit).
- Python: `pytest` **137/137** · `ruff check src tests` → **All checks passed** · `mypy src` →
  **Success: no issues found in 21 source files**.
- **Yığın yeniden başlatılmadı** (kullanıcı kuralı): değişiklikler kaynakta doğrulandı; imaj
  yeniden kurulumu ve `/ui/` + `/v1/models` canlı kontrolü **Adım 2**'de (Antalia ile birlikte).

### 13.7 Dürüst notlar (değiştirilmeyenler)

- **Tarayıcı paketleri kurulmadı** (Adım 3 kullanıcı kararıyla atlandı): ~3 GB indirme + §13.4
  çakışması. Stüdyonun tarayıcı yolu bugün paket ister; sunucu yolu indirmesiz çalışır.
- **`Ayarlar → Modeller` artık `tts-1`'i de listeler** — bilinçli: o bölüm `/v1/models`'ın
  dürüst aynasıdır ve alias gerçekten çağrılabilir bir kimliktir. Seslendirme **menüsünde** ise
  tekilleştirme sayesinde çift satır yoktur.
- **`modelLibrary.sizesOf` 404 ile "ağ yok"u aynı sayar** (`offline: true`): paket sunucuda yoksa
  Modeller bölümü "Sunucuya ulaşılamadı; indirme şu an yapılamaz" der. Ayrım (404 = paket yok)
  ayrı bir iyileştirme olarak duruyor; bu adımda davranış değiştirilmedi.
- **`ruff format` sapması:** `gateway.py`'da benim değişikliğimle ilgisiz, önceden var olan bir imza
  satırı `ruff format --check`'ten geçmez; `ruff format` belgelenmiş akışta (`ruff check .`) yok,
  bu yüzden dokunulmadı.

---

## 14. Antalia Mini'yi sunucuda etkinleştirme (Adım 2)

**İstek:** belge/kod düzeltmelerinden sonra Antalia'yı **sunucu tarafında** aktif et, servisi/yığını
yeniden başlat, sonra `--verify-only` ile bütünlüğü doğrula.

### 14.1 Ne yapıldı

| Adım | Ayrıntı |
|---|---|
| **`.env`** | `ANTALIA_URL=http://tts-antalia:8083` (önceden boştu). Gateway `/readyz` ve `/v1/models` artık Antalia'yı görür |
| **Profil** | `docker compose --profile antalia up -d` → `tts-antalia` servisi başlar (`compose.yaml`'da `profiles: [antalia]`) |
| **İmajlar** | Kaynak değiştiği için yeniden kuruldu: `voxi-tts:local` (EMA, `tts-1` alias'ı), `voxi-antalia:local` (parite), `voxi-gateway:local`, `voxi-webui:local` |
| **Veri** | `voxi_antalia-models` volume'ü zaten doluydu (`antalia-mini/`, 6 dosya) — **indirme gerekmedi** |

Antalia artık gerçekten yönlendiriliyor: `resolve_tts` `model == "antalia-mini"` + `settings.antalia_url`
→ `antalia-tr` sesi, `antalia_url` worker'ı.

### 14.2 Doğrulama (canlı, `https://127.0.0.1:8443`)

| Kontrol | Sonuç |
|---|---|
| `/readyz` | `{"status":"ready","workers":{"tts":true,"stt":true,"antalia":true}}` ✅ |
| `/v1/models` | **5 model**: `tts-1`, `ema-lightning` (ses `ema-tr`), `antalia-mini` (ses `antalia-tr`), `whisper-1`, `whisper-small` ✅ |
| `POST /v1/audio/speech` `antalia-mini`/`antalia-tr` | **200**, 94764 bayt, `audio/wav`, `RIFF` ✅ |
| `POST /v1/audio/speech` `tts-1`/`ema-tr` | **200**, 53804 bayt, `audio/wav`, `RIFF` ✅ |
| `provision_models.py --verify-only` | `antalia-mini` **6** · `ema-lightning` **4** · `whisper-small` **5** asset **verified** ✅ |
| `/ui/` HTTPS / HTTP | **200** / **400 Bad Request** ✅ |
| Sunulan demet | `index-kJC3T2_F.js` (475850 B) yerel derlememle **bayt-birebir aynı**; worker chunk'ları yeni `npm run models` düzeltmelerini içeriyor, eski metin **yok** ✅ |

### 14.3 Operasyonel bulgular (dürüst notlar)

- **⚠️ Gateway yeniden oluşturulunca proxy bayat IP'ye gider.** `integrations/nginx/nginx.conf.template`
  `proxy_pass http://gateway:8080` kullanır ama **`resolver` yönergesi yok**; nginx upstream IP'sini
  başlangıçta bir kez çözüp önbelleğe alır. `gateway` konteyneri yeniden oluşturulunca (bu adımda
  olduğu gibi) proxy **eski IP'ye** gidip **502** döner; `docker compose restart proxy` düzeltir.
  Kalıcı çözüm: şablona `resolver 127.0.0.11 valid=10s;` + değişkenli `proxy_pass` eklemek —
  **bu adımda yapılmadı**, ayrı bir iyileştirme olarak duruyor.
- **`/v1/models` tek bir worker'a bağımlı.** Gateway worker listelerini birleştirirken `worker()`
  herhangi bir worker **≥400** dönerse `PlatformError(503)` yükseltir. Yani `ANTALIA_URL` ayarlıyken
  `tts-antalia` sağlıksızsa **model keşfi tamamen 503** olur. Dayanıklılık (bozuk worker'ı atlayıp
  diğerlerini listelemek) bu adımda **değiştirilmedi**; öneri olarak duruyor.
- **Yerel `vite build` ile konteyner derlemesi CSS'te 868 bayt ayrışıyor** (yerel 65023 B
  `index-DcCyUDR9.css`, konteyner 65891 B `index-BlF…css`). Konteyner çıktısı yerelin **üst kümesi**
  (yalnızca +5 kullanılmayan utility: `.transition`, `.inline`, `.transform\!`, `.filter\!`, `.block\!`);
  uygulamanın gerçekten kullandığı hiçbir sınıf eksik değil. Fark, Tailwind v4'ün **otomatik kaynak
  taraması**nın iki ortamda farklı dosya kümesi görmesinden geliyor (adaylar `webui/preview.html` —
  servis edilmeyen tasarım önizlemesi — gibi dosyalardaki elle yazılmış CSS'te de geçiyor).
  **Kesin kök neden belirlenemedi** (Docker derleme katmanı önbellekte kaldığı için hipotez test
  edilemedi). Kalıcı çözüm önerisi: `webui/src/index.css`'e **açık `@source`** yönergesi eklemek →
  tarama kümesi ortamdan bağımsız ve tekrarlanabilir olur. **Değiştirilmedi.**
- **JS ana demeti birebir aynı** olduğu için uygulama davranışı iki ortamda da aynıdır; ayrışma
  yalnızca ölü CSS'tir.

---

## 15. Aşama A — canlı mod ajan oturumundan ayrıldı (Plan 3)

**İstek/bulgu (kullanıcı):** "burada n8n ne alaka?" — Oturum çubuğundaki "Oturum başlat" düğmesi,
mikrofonu ve canlı sunucu STT'yi **n8n'e bağlı** `POST /v1/sessions` çağrısının arkasına koyuyordu:
çağrı `n8n_unconfigured` (503) dönerse `App.tsx` erken çıkıyor ve `goLive()` **hiç çalışmıyordu**. Oysa
`goLive()` (mikrofon + `WS /v1/realtime/transcriptions`) oturuma **hiç dokunmuyor**. n8n yalnızca
gönderilen turun ajan eylemine (`speak`/`listen`/…) dönüşmesi için gerekli.

**Kök neden (kanıt):** `studio/App.tsx:942` (eski) `if (!(await session.start())) return;` →
`session.start()` = `POST /v1/sessions` → `TurnBroker.create()` (`src/voxi/n8n.py:75`) →
`VOXI_N8N_WEBHOOK_URL`/`VOXI_N8N_API_KEY` boşken `503 n8n_unconfigured`.

### 15.1 Ne değişti

| Ne | Önce | Sonra | Dosya |
|---|---|---|---|
| **Başlatma** | "Oturum başlat" → n8n oturumu; başarısızsa mikrofon açılmaz | "Oturum başlat" → **canlı mod** (`setLiveMode(true)`), boş çalışma alanında mikrofonu açar; n8n'e dokunmaz | `studio/App.tsx` |
| **Ajan oturumu** | Başlatmada açılır | **İlk gönderilen turda tembel** açılır; n8n yoksa hata yalnızca gönderimde, sunucudan geldiği gibi | `studio/lib/useSession.ts` (`send`) |
| **Çubuk durumu** | Tek `open` = sunucu oturumu; tüm denetimler ona bağlı | İki durum **ayrı**: canlı mod (mikrofon) ve ajan oturumu ("ilk gönderimde açılır" / "açık") | `studio/components/SessionBar.tsx` |
| **Bitir** | `session.end()` | canlı modu kapatır, mikrofonu kapatır, ajan oturumu varsa sonlandırır | `studio/App.tsx` |

**Canlı mod bağımsızdır:** `goLive()` her çağrıldığında (çubuk düğmesi, araç çubuğu mikrofonu,
kısayol) canlı mod açılır; ajan oturumu **hiç** açılmaz. Çubuğun dürüst metni saf bir fonksiyonda
(`sessionBarStatus`) toplanıp test edildi — çubuk sessizce "başlatmak n8n oturumu açar" izlenimine
dönemez.

### 15.2 Doğrulama

| Kontrol | Sonuç |
|---|---|
| `tsc --noEmit` | temiz ✅ |
| `vitest` | **81/81** (10 dosya; yeni `tests/sessionBar.test.ts` 3 test) ✅ |
| `vite build` | OK — ana demet 476.40 kB (yerel `index-Dl4WxcOP.js`) ✅ |
| `docker compose build webui` + `up -d webui` | OK — konteyner demeti `index-CqRw7BCI.js` ✅ |
| `/ui/` HTTPS | **200**; sunulan `index.html` → `index-CqRw7BCI.js` ✅ |
| Sunulan demet metinleri | `ajan oturumu ilk gönderimde açılır` (3) · `ajan oturumu açık` (1) · `Konuşma modu` (1) · `Canlı modu açar` (2) · `Ajan oturumu ilk gönderimde açılır` (3) **var**; `Sunucuda bir konuşma açar` (0) · `Oturum açık` (0) **yok** ✅ |

**Not:** Bu adım yalnızca `webui` imajını yeniden kurup `webui` konteynerini yeniledi; gateway/proxy
yeniden oluşturulmadı, bu yüzden bayat-IP 502 tuzağı tetiklenmedi.

---

## 16. Aşama B — sözleşme + kapsamlar + OpenAI-uyum doğrulaması (Plan 3, 2026-10-16)

Plan 3'ün ayrıntılı kaydı `docs/plan-3-server-first.md` §7'de. Buradaki özet, Plan 2'nin izlediği
kanıt biçimini korur.

### 16.1 Ne değişti

| Ne | Önce | Sonra | Dosya |
|---|---|---|---|
| **Uç kataloğu** | `/v1/endpoints` 6 rota | **14 rota**, her biri `method/path/service/scopes/purpose`; açık rotalar `scopes: []` | `src/voxi/gateway.py` |
| **İstemci tipi** | `EndpointEntry` kapsamsız | isteğe bağlı `scopes?: string[]` | `webui/src/api/client.ts` |
| **Ayarlar tablosu** | Kapsam sütunu yok | `kapsam: …` / `kapsam: açık`, yalnızca `scopes` diziyse çizilir | `studio/components/ServerSection.tsx` |
| **mypy (Step 1 artığı)** | `tts.py:98` hatası | `names: tuple[str, ...] = (current.model_id,)` | `src/voxi/workers/tts.py` |
| **Smoke** | Yalnız `http://…:8080` | `--ca-bundle` / `--insecure`; `verify` hem yoklamada hem taşımada | `scripts/smoke.py` |
| **compose.proxy yorumu** | `exec gateway python smoke.py` (yanlış) | `--profile smoke` imajı ya da host + `--ca-bundle` | `infra/compose.proxy.yaml` |
| **Kapsam dokümanı** | `telephony:admin` rezerve | + rezerve `text:process` (bugün hiçbir uç yok) | `docs/deployment.md` |
| **Uyum dokümanı** | Doğrulama bölümü yok | "Verified against a running deployment" + istemci/anahtar matrisi | `docs/api-compatibility.md` |

### 16.2 Doğrulama

| Kontrol | Sonuç |
|---|---|
| `ruff check` | temiz ✅ |
| `mypy` | temiz (21 dosya) ✅ |
| `pytest` | **137/137** ✅ |
| `tsc --noEmit` | temiz ✅ |
| `vitest` | **81/81** ✅ |
| `vite build` | OK ✅ |
| `GET /v1/endpoints` (proxy üzerinden) | 14 rota, kapsamlar dahil ✅ |
| `/ui/` HTTPS | **200** → `index-CPyhoOa5.js` ✅ |
| `/readyz` | `{"status":"ready","workers":{"tts":true,"stt":true,"antalia":true}}` ✅ |

**OpenAI SDK E2E** (`openai==1.78.1`, `scripts/smoke.py`,
`https://127.0.0.1:8443/v1 --ca-bundle certs/voxi.crt`) — üç model de geçti; sayılar koşunun kendi
raporundan (uydurma yok):

| Model / ses | WAV (mono PCM16 24 kHz) | MP3 | STT `whisper-1` |
|---|---|---|---|
| `ema-lightning` / `ema-tr` | 3.360 s (istek 0.735 s) | 3.408 s (0.391 s) | boş değil ✅ |
| `tts-1` / `ema-tr` | 3.360 s (0.297 s) | 3.408 s (0.297 s) | boş değil ✅ |
| `antalia-mini` / `antalia-tr` | 3.627 s (0.266 s) | 3.696 s (0.297 s) | boş değil ✅ |

`/v1/models` tam olarak `antalia-mini, ema-lightning, tts-1, whisper-1, whisper-small` döndürdü.

**Tuzak (kanıtla):** Proxy overlay'i gateway'in host portunu **kaldırır** (`ports: !reset []`), bu
yüzden host'tan `http://127.0.0.1:8080` **yoktur** — ilk smoke denemeleri bu yüzden
`WinError 10061` ile düştü. Doğru yol: konteyner içi yerine `--profile smoke` istemci imajı ya da
host'tan proxy + `--ca-bundle certs/voxi.crt`. Ayrıca gateway imajında `openai` **yok**
(`import openai` → `False`), yani `exec gateway … smoke.py` hiç çalışmaz; yorum düzeltildi.

### 16.3 Dürüst sınırlar

- `text:process` **rezerve**; kayıt defteri her kapsam dizesini kabul ettiği için bugün bir şey vermez
  (Plan 3 D/E'de karşılığı gelecek).
- Doğrulanmayanlar: OpenAI Realtime, gerçek istemciyle WebSocket taşımaları, OpenWebUI/Hermes
  sürüm-özel davranışı, canlı mikrofonda ilk-ses gecikmesi, eşzamanlı oturum kapasitesi.
- `tts-ema` imajı bu adımda yeniden kurulmadı: `tts.py` değişikliği yalnızca tip anotasyonu, çalışma
  zamanı etkisi sıfır.
- Kullanıcı sorusu üzerine yeni boşluk **G10** (sunucu STT model kapsamı) Plan 3 §7.4'te kayda geçti
  ve F0–F3 aşamalarına ayrıldı; bu adımda **kod yazılmadı**.

## 17. Aşama F1 + F1b — turbo STT ve turnkey model kurulumu (Plan 3, 2026-10-16)

Ayrıntılı kayıt `docs/plan-3-server-first.md` §8.2–§8.3'te. Özet, Plan 2'nin kanıt biçimini korur.

### 17.1 Ne değişti

| Ne | Önce | Sonra | Dosya |
|---|---|---|---|
| **STT yönlendirme** | tek worker (`stt_url`) | `resolve_stt(model)`: `whisper-1` → varsayılan, başka id → kendi worker'ı | `src/voxi/gateway.py` |
| **`/v1/models`** | listeleri birleştirir | + turbo worker **ve id'ye göre tekilleştirme** (`whisper-1` bir kez) | `src/voxi/gateway.py` |
| **Hata mesajı** | genel | gerçekten kurulu id'leri listeler | `src/voxi/gateway.py` |
| **Turbo worker** | yok | `stt-whisper-turbo` (port 8084, `profiles: [stt-turbo]`) + hacim + env | `compose.yaml` |
| **Provision** | `--profile provision*` ile elle | **profil dışı**; worker'lar `depends_on: … service_completed_successfully` | `compose.yaml` |
| **Smoke** | yalnız `--model` | + `--stt-model`; raporda `tts_model` / `stt_model` | `scripts/smoke.py` |
| **Testler** | 137 | **139** | `tests/test_gateway.py` |

### 17.2 Doğrulama

| Kontrol | Sonuç |
|---|---|
| `ruff check src tests scripts` | temiz ✅ |
| `mypy` | temiz (21 dosya) ✅ |
| `pytest` | **139/139** ✅ |
| Tam yığın `docker compose up -d --wait --wait-timeout 900` | **exit 0**; dört provision `Exited (0)` ✅ |
| `/v1/models` | 6 id, 6 tekil (turbo dahil) ✅ |
| `smoke.py --stt-model whisper-large-v3-turbo` | transkript boş değil, **6,91 s** ✅ |
| `smoke.py --stt-model whisper-small` | transkript boş değil, **1,89 s** ✅ |
| `/readyz` · `/ui/` | `ready` · HTTP 200 ✅ |

### 17.3 Dürüst sınırlar

- Turbo CPU'da gerçek zamandan yavaş (RTF ≈ 2,1) → varsayılan `whisper-small` kalır (S5); canlı kullanım
  için uygun değil.
- Studio'da **sunucu STT modeli seçicisi yok**; turbo bugün yalnız API'den seçilebilir (G10 kapanmadı).
- **Literal `git clone && docker compose up -d` hâlâ çalışmaz**: `.env` (worker anahtarı) ve `certs/`
  (TLS) gerekli, ikisi de `.gitignore`'da; turnkey araç `infra/bootstrap.ps1` ve yalnız Windows.
- Varsayılan kurulum artık ~1,6 GB turbo indirir, turbo çalışmasa bile.

---

## 18. Aşama T1 — taze kopyada sırlar ve TLS kendiliğinden kurulur (Plan 3, 2026-10-16)

Ayrıntılı kayıt `docs/plan-3-server-first.md` §8.4'te, karar kaydı `docs/adr/0007-compose-native-bootstrap.md`.
Bu bölüm §17.3'ün ilk maddesini **kapatır**.

### 18.1 Ne değişti

| Ne | Önce | Sonra | Dosya |
|---|---|---|---|
| **Sır okuma** | yalnız ortam değişkeni | `environment → <NAME>_FILE → VOXI_SECRETS_DIR/<dosya>` | `src/voxi/secrets.py` (yeni) + `gateway.py`, `auth.py`, `workers/common.py`, `scripts/smoke.py` |
| **İlk kurulum** | `infra/bootstrap.ps1` (yalnız Windows) ya da elle `.env` | tek seferlik **`secrets` servisi** üretir | `scripts/bootstrap_secrets.py` (yeni), `compose.yaml` |
| **TLS** | kullanıcı `certs/voxi.crt`+`voxi.key` vermek zorunda | yoksa bir kez loopback sertifikası üretir; `REQUIRE_PROVIDED_CERTS=1` ile katı kip | `scripts/bootstrap_secrets.py`, `integrations/nginx/voxi-entrypoint.sh` |
| **Worker anahtarı** | `${VOXI_WORKER_API_KEY:?}` (zorunlu) | `${VOXI_WORKER_API_KEY:-}` + dosyadan okuma | `compose.yaml` |
| **Proxy** | yalnız `VOXI_WEBUI_KEY` ortam değişkeni | boşsa `webui.key` dosyası; strict modda üretilmiş sertifikayı reddeder | `voxi-entrypoint.sh` |
| **Anahtarlık** | — | üretilen kayıt, geçersizse kendini tazeler (anahtar döndürmez) | `scripts/bootstrap_secrets.py` |
| **Testler** | 139 | **161** (+22; 4'ü host'ta `openssl` yok diye skip) | `tests/test_secrets.py` (yeni) |

### 18.2 Doğrulama

| Kontrol | Sonuç |
|---|---|
| `ruff check src scripts tests infra` | temiz ✅ |
| `mypy` | temiz (22 dosya) ✅ |
| `pytest` | **161/161**, 4 skip ✅ |
| Compose `config` (5 kombinasyon) | beşi de `exit 0` ✅ |
| Üretici, gerçek imajda: üretim/izinler/SAN'lar/log sessizliği | ✅ (§8.4.2a) |
| Üretici: ikinci koşu bit bit aynı | ✅ |
| Strict mod: sertifika yok / üretilmiş / kullanıcı | `1` / `1` / `0` ✅ |
| Ortam önceliği: `VOXI_WORKER_API_KEY` ve `VOXI_WEBUI_KEY` | üretmez; anahtarlık SHA'sı ortamla aynı ✅ |
| Proxy giriş noktası, gerçek nginx imajına karşı | strict redleri + `0600` render + bearer dosyadan ✅ |
| **Taze kopya E2E** (`.env` ve `certs/` yok, hacim silinmiş) | `up -d --wait` **exit 0**; 5 servis healthy; 5 tek-seferlik `Exited (0)` ✅ |
| `/readyz` · `/ui/` · `/v1/models` (anahtar vermeden) | `ready` · HTTP 200 · 4 id, 4 tekil ✅ |
| Geçersiz anahtar | HTTP 401 ✅ |
| İkinci `up -d` | 4 anahtar + işaret + sertifika bit bit aynı ✅ |
| Kullanıcı sertifikası önceliği | değişmedi, işaret eklenmedi ✅ |
| Geri yükleme | `.env` ve `certs/voxi.crt` sha256 olay öncesiyle birebir; sunulan sertifika parmak izi aynı; 6 id ✅ |
| Kullanıcı malzemesi varken | log: *"wins at read time, nothing generated"*; hacim **boş** ✅ |

### 18.3 Dürüst sınırlar

- **İki `-f` bayrağı zorunlu:** `proxy` yalnız `infra/compose.proxy.yaml`'da tanımlı, dolayısıyla çıplak
  `docker compose up -d` API'yi TLS/UI kenarı olmadan başlatır. Belgeler (README, `deployment.md`,
  ADR 0007) buna göre düzeltildi; çıplak komutun da tam olması ek bir karar gerektirir (§8.4.3).
- **`0600` yerine `0640 root:voxi`:** UID 10001'in okuduğu dosyalar için; root sahipli `0600` root
  olmayan okuyucuya kapalıdır. Dünyaya açık hiçbir dosya yok, üretilen değer env'e konmaz.
- **Üretilen sertifika sunucu kimliği kanıtlamaz** (loopback şifreleme); LAN/üretim katı kip ister.
- **Sertifika üretim birim testleri bu host'ta atlanır** (host'ta `openssl` yok); yol imajın içinde
  canlı doğrulandı.
- **Taze kopya E2E elle simülasyon**, otomatik test değil (sahte proje adı tüm modelleri yeniden indirir).
- **İlk `up -d --wait` bir kez `exit 1`** (yeniden oluşturulan `tts-ema`'nın SIGTERM çıkışı 143 sayıldı);
  hemen ardından aynı komut `exit 0`. Taze makinede yeniden oluşturulacak konteyner yoktur.
- **İmaj tazelemesi tamamlandı (2026-10-17).** Beş imaj da T1 koduyla yeniden derlendi; ağır `torch`
  katmanı bu makinede motoru birkaç kez düşürdüğü için derlemeler tek tek yapıldı
  (`gateway` → `tts` → `stt` → `smoke` → `antalia`; `stt-whisper-turbo` `voxi-stt:local`'ı paylaşır).
  Yenilenen `smoke` imajı canlı yığına karşı tam OpenAI SDK E2E'sini geçti (`exit 0`, boş olmayan
  Türkçe transkript, WAV 3.360 s / MP3 3.408 s, STT 1.883 s).


