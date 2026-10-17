// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { GatewayHealth } from "../../lib/useGateway";
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../lib/settingsSections";
import { About } from "./About";
import { IconClose } from "./icons";
import { LogSection } from "./LogSection";
import { ModelSettings } from "./ModelSettings";
import { ServerSection } from "./ServerSection";
import { IconButton } from "./ui";

// The settings window: sections on the left, the chosen one on the right. It
// stays mounted while closed, so a model download keeps going and the log keeps
// its place.
//
// Aşama 8 made this the ONE settings surface; Aşama 9b folded the full-screen
// "Sunucu" panel into it, so the gateway has exactly one surface too — its
// connection, live status, endpoint catalog and log are all sections here.
// There is deliberately no "Ses" section: dubbing and voice choices live in the
// Inspector's "Seslendirme" tab (one surface per capability).
//
// The visible section is owned by the app (studio/App.tsx) and remembered, so the
// status bar can deep-link straight into "Sunucu".

const TAB =
  "rounded-ui-sm border-0 px-2.5 py-1.5 text-left text-[12.5px] transition-colors duration-120 outline-none focus-visible:ring-2 focus-visible:ring-cini/50";

export function Settings({
  open,
  section,
  onSection,
  onClose,
  gateway,
}: {
  open: boolean;
  /** The visible section; the app owns it so any surface can open one. */
  section: SettingsSectionId;
  onSection: (id: SettingsSectionId) => void;
  onClose: () => void;
  /** The gateway's health: the same state the status bar shows. */
  gateway: GatewayHealth;
}) {
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) element.showModal();
    if (!open && element.open) element.close();
  }, [open]);

  /** The arrow keys walk the section list, the way a tab list should. */
  const onNavKey = (event: KeyboardEvent<HTMLElement>) => {
    const here = SETTINGS_SECTIONS.findIndex((item) => item.id === section);
    const last = SETTINGS_SECTIONS.length - 1;
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? (here + 1) % SETTINGS_SECTIONS.length
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? (here + last) % SETTINGS_SECTIONS.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? last
              : -1;
    if (next < 0) return;
    event.preventDefault();
    const id = SETTINGS_SECTIONS[next].id;
    onSection(id);
    document.getElementById(`settings-tab-${id}`)?.focus();
  };

  /** Only the section on screen refreshes its own data. */
  const visible = (id: SettingsSectionId) => open && section === id;

  const content: Record<SettingsSectionId, ReactNode> = {
    server: <ServerSection active={visible("server")} gateway={gateway} />,
    models: <ModelSettings active={visible("models")} />,
    log: <LogSection />,
    about: <About />,
  };

  return (
    <dialog
      ref={dialog}
      aria-label="Ayarlar"
      onClose={onClose}
      // A click on the backdrop lands on the dialog itself.
      onClick={(e) => e.target === e.currentTarget && onClose()}
      className="m-auto h-[min(640px,calc(100dvh-32px))] w-[min(780px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-pane p-0 text-fg shadow-[0_24px_64px_rgba(0,0,0,0.6)] backdrop:bg-black/55 backdrop:backdrop-blur-[2px] open:flex open:flex-col"
    >
      <div className="flex items-center justify-between border-b border-line-soft px-4 py-3">
        <h2 className="m-0 text-[14px] font-semibold tracking-[-0.015em]">Ayarlar</h2>
        <IconButton onClick={onClose} title="Kapat" aria-label="Kapat">
          <IconClose size={14} />
        </IconButton>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[168px_minmax(0,1fr)] max-[600px]:grid-cols-1 max-[600px]:grid-rows-[auto_minmax(0,1fr)]">
        <nav
          role="tablist"
          aria-orientation="vertical"
          aria-label="Ayarlar bölümleri"
          onKeyDown={onNavKey}
          className="flex flex-col gap-0.5 border-r border-line-soft p-2 max-[600px]:flex-row max-[600px]:overflow-x-auto max-[600px]:border-r-0 max-[600px]:border-b"
        >
          {SETTINGS_SECTIONS.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`settings-tab-${item.id}`}
              aria-selected={item.id === section}
              aria-controls={`settings-panel-${item.id}`}
              // Roving focus: Tab reaches the list once, the arrows walk it.
              tabIndex={item.id === section ? 0 : -1}
              onClick={() => onSection(item.id)}
              className={`${TAB} ${
                item.id === section ? "bg-cini-wash text-fg" : "bg-transparent text-fg-2 hover:bg-raised hover:text-fg"
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto p-4 [scrollbar-color:var(--raised)_transparent] [scrollbar-width:thin]">
          {/* Every section stays mounted, so switching does not drop its state. */}
          {SETTINGS_SECTIONS.map((item) => (
            <div
              key={item.id}
              id={`settings-panel-${item.id}`}
              role="tabpanel"
              aria-labelledby={`settings-tab-${item.id}`}
              hidden={item.id !== section}
            >
              {content[item.id]}
            </div>
          ))}
        </div>
      </div>
    </dialog>
  );
}
