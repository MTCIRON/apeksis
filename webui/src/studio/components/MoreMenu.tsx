// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useState } from "react";
import { modelInfo } from "../models";
import { IconChevron, IconMore, IconSettings } from "./icons";
import { Menu, MenuGroup, MenuItem, MenuNote } from "./Menu";
import { ModelChoices, type ModelProps } from "./ModelMenu";
import { ProviderChoices, shownProvider, type ProviderProps } from "./ProviderMenu";
import { toolbarButton } from "./ui";

// Phones: the toolbar has no room for the model, provider and settings
// buttons, so they share one "⋯" menu. A row opens its list in place.

type View = "main" | "model" | "provider";

export function MoreMenu({
  model,
  provider,
  onSettings,
}: {
  model: ModelProps;
  provider: ProviderProps;
  onSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>("main");
  const close = () => setOpen(false);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      width="w-[300px]"
      trigger={
        <button
          className={toolbarButton({ compact: true })}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Diğer"
          title="Diğer"
          onClick={() => {
            setView("main");
            setOpen((o) => !o);
          }}
        >
          <IconMore />
        </button>
      }
    >
      {view === "main" && (
        <>
          <MenuGroup>
            <Row label="Model" value={modelInfo(model.value).name} onClick={() => setView("model")} />
            <Row
              label="Çalıştırma"
              value={shownProvider(provider).shown.label.split(" (")[0]}
              onClick={() => setView("provider")}
            />
          </MenuGroup>
          <MenuGroup>
            <MenuItem
              onClick={() => {
                close();
                onSettings();
              }}
            >
              <span className="flex items-center gap-2">
                <IconSettings /> Ayarlar
              </span>
            </MenuItem>
          </MenuGroup>
        </>
      )}
      {view !== "main" && (
        <MenuItem onClick={() => setView("main")}>
          <span className="flex items-center gap-1.5 text-fg-2">
            <span className="inline-grid rotate-90">
              <IconChevron size={12} />
            </span>
            Geri
          </span>
        </MenuItem>
      )}
      {view === "model" && <ModelChoices {...model} onDone={close} />}
      {view === "provider" && <ProviderChoices {...provider} onDone={close} />}
    </Menu>
  );
}

const Row = ({ label, value, onClick }: { label: string; value: string; onClick: () => void }) => (
  <MenuItem onClick={onClick}>
    <span>{label}</span>
    <span className="flex items-center gap-1">
      <MenuNote>{value}</MenuNote>
      <span className="inline-grid -rotate-90 text-fg-3">
        <IconChevron size={12} />
      </span>
    </span>
  </MenuItem>
);
