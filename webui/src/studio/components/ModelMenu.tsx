// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useState } from "react";
import { MODELS, modelInfo, type ModelId } from "../models";
import { IconCheck, IconChevron, IconWave } from "./icons";
import { Menu, MenuFoot, MenuGroup, MenuItem, MenuNote, MenuTitle } from "./Menu";
import { TbLabel, toolbarButton } from "./ui";

export interface ModelProps {
  value: ModelId;
  onChange: (m: ModelId) => void;
  /** Why GPU-only models cannot run here, if they cannot. */
  gpuReason: string | null;
  /** A transcription is running; switching would abort it. */
  locked: boolean;
  /** The "sunucu" provider is active: this model only applies to the browser path. */
  server: boolean;
}

/** Toolbar control: which speech model transcribes. */
export function ModelMenu(props: ModelProps) {
  const [open, setOpen] = useState(false);
  const current = modelInfo(props.value);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      width="w-[320px]"
      trigger={
        <button
          className={toolbarButton()}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Model: ${current.name} (${current.tier})${props.server ? " · yalnızca tarayıcıda kullanılır" : ""}`}
          onClick={() => setOpen((o) => !o)}
        >
          <span className="inline-grid place-items-center text-fg-2">
            <IconWave />
          </span>
          <TbLabel>{current.name}</TbLabel>
          <IconChevron size={12} />
        </button>
      }
    >
      <ModelChoices {...props} onDone={() => setOpen(false)} />
    </Menu>
  );
}

/** The models to pick from; also in the phone toolbar's "⋯" menu. */
export function ModelChoices({ value, onChange, gpuReason, locked, server, onDone }: ModelProps & { onDone: () => void }) {
  return (
    <>
      <MenuGroup>
        <MenuTitle>Yazıya döken model</MenuTitle>
        {MODELS.map((m) => {
          const unavailable = m.gpuOnly ? gpuReason : null;
          return (
            <MenuItem
              key={m.id}
              choice
              role="menuitemradio"
              aria-checked={m.id === value}
              disabled={locked || (!!unavailable && m.id !== value)}
              onClick={() => {
                onDone();
                if (m.id !== value) onChange(m.id);
              }}
            >
              <span className="grid h-[18px] w-[14px] flex-none place-items-center" aria-hidden>
                {m.id === value && <IconCheck size={14} />}
              </span>
              <span className="grid gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span>{m.name}</span>
                  <MenuNote>
                    {m.tier} · {m.size}
                  </MenuNote>
                </span>
                <MenuNote>{unavailable ?? m.note}</MenuNote>
              </span>
            </MenuItem>
          );
        })}
      </MenuGroup>
      {server ? (
        <MenuFoot>
          Sunucu (Apeksis) seçili: bu model yalnızca "Tarayıcı" seçildiğinde kullanılır.
        </MenuFoot>
      ) : (
        <MenuFoot>Model ilk kullanımda indirilir ve bu tarayıcıda saklanır. Ayarlar → Modeller'den indirilip silinebilir.</MenuFoot>
      )}
      {locked && <MenuFoot>Yazıya dökme sürerken değiştirilemez.</MenuFoot>}
    </>
  );
}
