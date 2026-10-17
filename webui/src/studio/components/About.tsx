// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Settings → Hakkında: what the app is, its version and who makes it.

import { Wordmark } from "../../shell/wordmark";

const SITE = "https://caliskangroup.com/";
const AUTHOR = "Mustafa Tayyar Çalışkan";

export function About() {
  return (
    <div className="grid justify-items-start gap-4">
      <Wordmark className="text-[24px] text-white" />
      <div className="grid gap-1.5">
        <span className="text-[12px] text-fg-3 tabular-nums">Sürüm {__APP_VERSION__}</span>
        <p className="m-0 max-w-[460px] text-[13px] leading-normal text-fg-2">
          Türkçe ses ve videoyu tarayıcında yazıya dök, altyazı ekle, dışa aktar. Her şey senin bilgisayarında
          çalışır; dosyan hiçbir yere gönderilmez.
        </p>
        <p className="m-0 max-w-[460px] text-[12.5px] leading-normal text-fg-3">
          Projelerin bu cihazda kalır (IndexedDB). Yazıya dökme ya da seslendirme için <b>Sunucu (Apeksis)</b>{" "}
          sağlayıcısını seçtiğinde ses, senin ağ geçidindeki uçlarda işlenir.
        </p>
      </div>
      <a
        className="text-[12.5px] text-fg no-underline underline-offset-2 hover:underline"
        href={SITE}
        target="_blank"
        rel="noopener noreferrer"
      >
        caliskangroup.com
      </a>
      <p className="m-0 border-t border-line-soft pt-3 text-[12px] text-fg-3">
        <a
          className="text-fg-2 no-underline hover:text-fg hover:underline"
          href={SITE}
          target="_blank"
          rel="noopener noreferrer"
        >
          {AUTHOR}
        </a>{" "}
        tarafından geliştiriliyor.
      </p>
    </div>
  );
}
