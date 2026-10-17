// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import type { ReactNode } from "react";

/** The welcome screen inside the empty player (and its "pick the media again" variant). */
export function Dropzone({
  title,
  text,
  actions,
  fine,
  children,
}: {
  title: string;
  text: ReactNode;
  actions: ReactNode;
  fine: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div
      data-dropzone
      className="grid max-w-[440px] justify-items-center gap-3 px-8 py-9 text-center max-[860px]:gap-2.5 max-[860px]:px-5 max-[860px]:py-7"
    >
      <img
        className="mb-2 block h-[58px] w-[58px] opacity-95 drop-shadow-[0_4px_20px_rgba(71,109,230,0.3)] transition-[transform,filter] duration-200 ease-[ease] max-[860px]:h-11 max-[860px]:w-11"
        src={`${import.meta.env.BASE_URL}icon.svg`}
        alt=""
      />
      <h2 className="m-0 text-[22px] font-[650] tracking-[-0.025em] text-white max-[860px]:text-[20px]">{title}</h2>
      <p className="m-0 text-[13.5px] leading-[1.6] text-fg-2">{text}</p>
      <div className="mt-2 flex items-center gap-3 max-[480px]:flex-col max-[480px]:gap-2 max-[480px]:self-stretch">
        {actions}
      </div>
      <p className="mt-2.5 mb-0 text-[12px] leading-[1.55] text-fg-3">{fine}</p>
      {children}
    </div>
  );
}
