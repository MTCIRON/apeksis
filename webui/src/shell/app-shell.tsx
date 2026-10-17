// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// AppShell — the single layout for /ui/, ported from the studio's App grid:
//
//   46px  toolbar
//   1fr   body   [ left pane │ main │ right pane ]
//   64px  transport bar
//   26px  status bar
//
// Every slot takes a RAW node: the caller supplies the studio's exact elements
// (header/footer/chrome) while the shell owns the grid. Left and right panes are
// resizable (pointer drag) and collapsible; width and open state persist per
// panel under `voxi.ui.panel.*` (see panels.ts).

import type { ReactNode } from "react";
import { IconChevron } from "./icons";
import { usePanelOpen, usePanelWidth } from "./panels";

export interface SidePane {
  /** Shown on the collapsed rail and used for the accessible label. */
  label: string;
  /** The pane element itself (e.g. the studio's `<Pane side="left">`). */
  content: ReactNode;
  /** Initial width in px (persisted afterwards). */
  width?: number;
  min?: number;
  max?: number;
  defaultOpen?: boolean;
}

export function AppShell({
  header,
  left,
  right,
  main,
  transport,
  status,
  dragging = false,
}: {
  header: ReactNode;
  left: SidePane;
  right: SidePane;
  main: ReactNode;
  transport: ReactNode;
  status: ReactNode;
  /** True while a file is dragged over the window (`group/shell` children react). */
  dragging?: boolean;
}) {
  const leftOpen = usePanelOpen("left.open", left.defaultOpen ?? true);
  const rightOpen = usePanelOpen("right.open", right.defaultOpen ?? true);
  const leftWidth = usePanelWidth("left.width", left.width ?? 340, left.min ?? 240, left.max ?? 480);
  const rightWidth = usePanelWidth("right.width", right.width ?? 312, right.min ?? 240, right.max ?? 520);

  const leftCol = leftOpen.open ? `${leftWidth.width}px` : "34px";
  const rightCol = rightOpen.open ? `${rightWidth.width}px` : "34px";

  return (
    <div
      data-dragging={dragging || undefined}
      className="group/shell relative grid h-full grid-rows-[46px_minmax(0,1fr)_64px_26px] max-[860px]:flex max-[860px]:h-auto max-[860px]:min-h-full max-[860px]:flex-col max-[860px]:*:flex-none"
    >
      <header className="flex items-center gap-2 border-b border-line-soft bg-pane pr-3 pl-3.5 select-none max-[860px]:h-11 max-[860px]:gap-1.5 max-[860px]:px-2.5 max-[860px]:*:shrink-0">
        {header}
      </header>

      <div
        className="grid min-h-0 max-[860px]:contents"
        style={{ gridTemplateColumns: `${leftCol} 1px minmax(0,1fr) 1px ${rightCol}` }}
      >
        {leftOpen.open ? (
          <>
            {left.content}
            <ResizeHandle side="left" onStart={leftWidth.startResize} onCollapse={leftOpen.toggle} label={left.label} />
          </>
        ) : (
          <>
            <Rail label={left.label} onExpand={leftOpen.toggle} side="left" />
            <div aria-hidden className="max-[860px]:hidden" />
          </>
        )}

        {main}

        {rightOpen.open ? (
          <>
            <ResizeHandle side="right" onStart={rightWidth.startResize} onCollapse={rightOpen.toggle} label={right.label} />
            {right.content}
          </>
        ) : (
          <>
            <div aria-hidden className="max-[860px]:hidden" />
            <Rail label={right.label} onExpand={rightOpen.toggle} side="right" />
          </>
        )}
      </div>

      {transport}
      {status}
    </div>
  );
}

/** A 1px column divider that also drags to resize and collapses its pane. */
function ResizeHandle({
  side,
  onStart,
  onCollapse,
  label,
}: {
  side: "left" | "right";
  onStart: (side: "left" | "right", e: React.PointerEvent) => void;
  onCollapse: () => void;
  label: string;
}) {
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={`${label} panelini yeniden boyutlandır`}
      onPointerDown={(e) => onStart(side, e)}
      onDoubleClick={onCollapse}
      title="Sürükle: boyutlandır · Çift tıkla: gizle"
      className="group relative cursor-col-resize bg-line-soft/60 hover:bg-cini/70 max-[860px]:hidden"
    />
  );
}

/** The 34px strip shown when a pane is collapsed. */
function Rail({ label, onExpand, side }: { label: string; onExpand: () => void; side: "left" | "right" }) {
  return (
    <div
      className={`flex min-h-0 flex-col items-center gap-2 bg-pane py-2 max-[860px]:hidden ${
        side === "left" ? "border-r border-line-soft" : "border-l border-line-soft"
      }`}
    >
      <button
        type="button"
        onClick={onExpand}
        title={`${label} panelini göster`}
        aria-label={`${label} panelini göster`}
        className="grid size-6 place-items-center rounded-ui-sm text-fg-3 hover:bg-raised hover:text-fg"
      >
        <span className={side === "left" ? "rotate-180" : ""}>
          <IconChevron size={14} />
        </span>
      </button>
      <span className="text-[10.5px] font-semibold uppercase tracking-wider text-fg-3 [writing-mode:vertical-rl]">
        {label}
      </span>
    </div>
  );
}
