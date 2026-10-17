// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Shared building blocks for /ui/.
//
// Primitive layer is ported from the original studio app (components/ui.tsx, components/Menu.tsx
// panel bits) so the shell reads exactly like the studio. A few Voxi-needed pieces
// (Badge, Card, Field, inputClass, Table, SettingsBlock) are added in the SAME
// visual language — no second styling system.
//
// Tabs, Dialog and Tooltip stay as the design system's generic primitives even
// though nothing uses them right now: they are tree-shaken out of the bundle and
// a future surface should not have to rewrite them. The toast queue was removed
// in Aşama 10 — it was never wired to anything.

import { useEffect, type ComponentProps, type ReactNode } from "react";

// ---- buttons ---- //

const BUTTON_VARIANT = {
  danger:
    "border-[rgba(239,100,78,0.55)] bg-[rgba(239,100,78,0.14)] text-[#ff8b78] hover:not-disabled:border-mercan hover:not-disabled:bg-mercan hover:not-disabled:text-white",
  default:
    "border-line bg-raised text-fg hover:not-disabled:border-[#3f4752] hover:not-disabled:bg-raised-hover hover:not-disabled:text-white",
  primary:
    "border-[rgba(71,109,230,0.7)] bg-linear-to-b from-[#4f74e8] to-[#3e63db] text-white shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.2)] hover:not-disabled:border-cini hover:not-disabled:from-[#5b80f4] hover:not-disabled:to-[#466be5] hover:not-disabled:shadow-[0_2px_8px_rgba(71,109,230,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]",
};

const BUTTON_SIZE = {
  md: "h-[29px] rounded-ui px-3 text-[12.5px] font-medium",
  lg: "h-9 rounded-lg px-5 text-[13.5px] font-[550]",
};

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...props
}: ComponentProps<"button"> & {
  /** `ghost` is accepted as a legacy alias for `default`. */
  variant?: keyof typeof BUTTON_VARIANT | "ghost";
  size?: keyof typeof BUTTON_SIZE;
}) {
  const fill = BUTTON_VARIANT[variant === "ghost" ? "default" : variant];
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 border tracking-[-0.01em] transition-all duration-150 ease-[ease] disabled:opacity-45 ${fill} ${BUTTON_SIZE[size]} ${className}`}
      {...props}
    />
  );
}

/** Underlined text button. */
export const LinkButton = ({ className = "", ...props }: ComponentProps<"button">) => (
  <button
    className={`cursor-pointer border-0 bg-transparent p-0 text-[12px] text-wave-played underline underline-offset-[0.18em] ${className}`}
    {...props}
  />
);

/** Small square button holding an icon. */
export const IconButton = ({ className = "", ...props }: ComponentProps<"button">) => (
  <button
    className={`grid h-[22px] w-6 place-items-center rounded-ui-sm border-0 bg-transparent p-0 text-fg-2 hover:bg-line hover:text-fg ${className}`}
    {...props}
  />
);

// ---- toolbar buttons ---- //

const TB_FILL = {
  default:
    "border-line bg-pane-2 text-fg hover:not-disabled:border-[#3b444f] hover:not-disabled:bg-raised-hover hover:not-disabled:text-white",
  primary:
    "border-[rgba(71,109,230,0.6)] text-white shadow-[0_1px_2px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.2)] hover:not-disabled:border-cini hover:not-disabled:shadow-[0_2px_6px_rgba(71,109,230,0.35),inset_0_1px_0_rgba(255,255,255,0.25)]",
};
const TB_GRADIENT = "bg-linear-to-b from-[#4f74e8] to-[#3e63db] hover:not-disabled:from-[#5b80f4] hover:not-disabled:to-[#466be5]";
/** A light sweep while the button's work runs (replaces the fill). */
const TB_BUSY =
  "bg-[linear-gradient(90deg,transparent,rgba(255,255,255,0.18),transparent)] bg-size-[200%_100%] animate-busy motion-reduce:animate-none";

/**
 * Classes for a toolbar button (also used on links). `compact` buttons get
 * narrower on phones, where their label (TbLabel) is hidden.
 */
export function toolbarButton({ primary = false, busy = false, compact = false } = {}) {
  return `inline-flex h-[29px] items-center gap-1.5 rounded-ui border px-[11px] text-[12.5px] font-medium tracking-[-0.01em] no-underline transition-all duration-150 ease-[ease] disabled:opacity-45 max-[860px]:whitespace-nowrap ${
    TB_FILL[primary ? "primary" : "default"]
  } ${busy ? TB_BUSY : primary ? TB_GRADIENT : ""} ${compact ? "max-[480px]:px-2" : ""}`;
}

/** Toolbar button text; phones show only the icon. */
export const TbLabel = ({ children }: { children: ReactNode }) => <span className="max-[480px]:hidden">{children}</span>;

// ---- panes ---- //

/** A side column: transcript/nav on the left, inspector on the right. */
export function Pane({
  side,
  label,
  children,
}: {
  side: "left" | "right";
  label?: string;
  children: ReactNode;
}) {
  const Tag = side === "left" ? "section" : "aside";
  return (
    <Tag
      aria-label={label}
      className={`flex min-h-0 flex-col border-line-soft bg-pane max-[480px]:max-h-[60vh] max-[480px]:border-0 max-[480px]:border-t ${
        side === "left" ? "border-r max-[860px]:order-3" : "border-l max-[860px]:order-4"
      }`}
    >
      {children}
    </Tag>
  );
}

export const PaneHead = ({ children }: { children: ReactNode }) => (
  <div className="flex items-center justify-between gap-2 border-b border-line-soft px-3.5 pt-3 pb-2.5">{children}</div>
);

export const PaneTitle = ({ children }: { children: ReactNode }) => (
  <h2 className="m-0 text-[13px] font-semibold tracking-[-0.015em] text-fg">{children}</h2>
);

/** Small pill next to a pane title, e.g. a word count. */
export const PaneMeta = ({ children }: { children: ReactNode }) => (
  <span className="rounded-[10px] border border-line-soft bg-white/5 px-[7px] py-px text-[11px] font-medium text-fg-3 tabular-nums">
    {children}
  </span>
);

/** The scrolling part of a pane. */
export const PaneBody = ({ children }: { children: ReactNode }) => (
  <div
    data-scroll
    className="min-h-0 flex-1 overflow-auto [scrollbar-color:var(--raised)_transparent] [scrollbar-width:thin]"
  >
    {children}
  </div>
);

export const EmptyNote = (props: ComponentProps<"p">) => (
  <p className="mx-3.5 my-3 text-[12.5px] leading-[1.6] text-fg-3" {...props} />
);

// ---- inspector sections and rows ---- //

export const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="grid gap-2.5 border-b border-line-soft px-3.5 pt-3.5 pb-4">
    <h3 className="m-0 text-[11px] font-semibold tracking-[0.05em] text-fg-3 uppercase">{title}</h3>
    {children}
  </section>
);

export const SectionActions = ({ children }: { children: ReactNode }) => <div className="flex gap-2">{children}</div>;

export const Hint = ({ children }: { children: ReactNode }) => (
  <p className="m-0 text-[12px] leading-normal text-fg-3">{children}</p>
);

const ROW = "flex min-h-7 items-center gap-2.5";

/** Label and control on one line; a <label>, so clicking the text works. */
export const Row = ({ children }: { children: ReactNode }) => <label className={ROW}>{children}</label>;

/** A row that is not a label (it holds its own buttons). */
export const RowGroup = ({ wrap = false, ...props }: ComponentProps<"div"> & { wrap?: boolean }) => (
  <div className={`${ROW} ${wrap ? "flex-wrap" : ""}`} {...props} />
);

export const RowLabel = ({ wide = false, children }: { wide?: boolean; children: ReactNode }) => (
  <span className={`text-[12.5px] whitespace-nowrap text-fg-2 ${wide ? "flex-1" : "w-[66px] flex-none"}`}>
    {children}
  </span>
);

export const RowValue = ({ children }: { children: ReactNode }) => (
  <span className="w-8 text-right text-[12px] text-fg-3 tabular-nums [font-feature-settings:'tnum'_1]">{children}</span>
);

export const Range = (props: Omit<ComponentProps<"input">, "type">) => (
  <input type="range" className="slider m-0 h-[18px] min-w-0 flex-1" {...props} />
);

export const Switch = (props: Omit<ComponentProps<"input">, "type">) => (
  <input type="checkbox" className="switch" {...props} />
);

// ---- Voxi extensions (same language) ---- //

export type BadgeTone = "ok" | "warn" | "bad" | "neutral";

const BADGE_TONE: Record<BadgeTone, string> = {
  ok: "border-firuze/30 bg-firuze/15 text-firuze",
  warn: "border-mercan/30 bg-mercan/15 text-mercan",
  bad: "border-mercan/40 bg-mercan/20 text-mercan",
  neutral: "border-line bg-raised text-fg-2",
};

export function Badge({ tone = "neutral", children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-ui-sm border px-[7px] py-px text-[11px] font-medium ${BADGE_TONE[tone]}`}>
      {children}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  className = "",
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-ui border border-line bg-pane ${className}`}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-line-soft px-3.5 py-2.5">
          <h2 className="text-[13px] font-semibold tracking-[-0.015em] text-fg">{title}</h2>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-3.5">{children}</div>
    </section>
  );
}

/**
 * A titled block inside a settings section: a raised surface with its heading on
 * one line and optional actions beside it. Used by Settings → Sunucu and
 * Settings → Günlük, so both read as one page (Aşama 9b).
 */
export function SettingsBlock({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3 rounded-[10px] border border-line-soft bg-pane-2 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="m-0 text-[11px] font-semibold tracking-[0.05em] text-fg-3 uppercase">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-[11px] font-semibold uppercase tracking-[0.04em] text-fg-3">{label}</span>
      {children}
    </label>
  );
}

export const inputClass =
  "w-full rounded-ui border border-line bg-pane-2 px-2.5 py-1.5 text-[12.5px] text-fg outline-none transition-colors placeholder:text-fg-3 focus:border-cini";

/** Segmented control, in the same style as the studio's TRANSCRIPT/EN toggle. */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className = "",
}: {
  items: { id: T; label: ReactNode }[];
  value: T;
  onChange: (id: T) => void;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={`inline-flex gap-0.5 rounded-ui border border-line-soft bg-[#101316] p-0.5 ${className}`}
    >
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="tab"
          aria-selected={value === item.id}
          onClick={() => onChange(item.id)}
          className={`rounded-ui-sm border-0 px-2 py-1 text-[11.5px] font-semibold tracking-[0.02em] transition-colors ${
            value === item.id ? "bg-raised text-white" : "bg-transparent text-fg-3 hover:text-fg"
          }`}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** Modal dialog, visually matching the dropdown menus (glass pane). */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-lg",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/55 p-4 backdrop-blur-[2px]"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className={`w-full ${width} max-h-[calc(100dvh-40px)] overflow-y-auto rounded-[10px] border border-[#363e48] bg-[rgba(34,39,46,0.97)] shadow-[0_16px_40px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05)]`}
      >
        {title && (
          <header className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3">
            <h2 className="text-[13px] font-semibold text-fg">{title}</h2>
            <IconButton onClick={onClose} aria-label="Kapat">
              <span aria-hidden className="text-[14px] leading-none">
                ×
              </span>
            </IconButton>
          </header>
        )}
        <div className="p-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-line-soft px-4 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

/** Hover/focus tooltip; no dependency, positioned by a relative wrapper. */
export function Tooltip({
  label,
  side = "top",
  children,
}: {
  label: ReactNode;
  side?: "top" | "bottom";
  children: ReactNode;
}) {
  const pos =
    side === "top"
      ? "bottom-[calc(100%+6px)] left-1/2 -translate-x-1/2"
      : "top-[calc(100%+6px)] left-1/2 -translate-x-1/2";
  return (
    <span className="group/tt relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute z-40 ${pos} hidden whitespace-nowrap rounded-ui-sm border border-line bg-[rgba(34,39,46,0.97)] px-2 py-1 text-[11px] text-fg-2 shadow-[0_8px_24px_rgba(0,0,0,0.5)] group-hover/tt:block group-focus-within/tt:block`}
      >
        {label}
      </span>
    </span>
  );
}

/** Table helpers, styled to the shell (used by the log panel). */
export const Table = ({ children, className = "" }: { children: ReactNode; className?: string }) => (
  <div className={`w-full overflow-x-auto rounded-ui border border-line-soft ${className}`}>
    <table className="w-full border-collapse text-left text-[12px]">{children}</table>
  </div>
);

export const Th = (props: ComponentProps<"th">) => (
  <th
    className="bg-pane-2 px-3 py-1.5 text-[10.5px] font-semibold uppercase tracking-wide text-fg-3"
    {...props}
  />
);

export const Td = (props: ComponentProps<"td">) => (
  <td className="border-t border-line-soft px-3 py-2 align-top text-fg-2" {...props} />
);

export const Tr = (props: ComponentProps<"tr">) => <tr className="hover:bg-pane-2/60" {...props} />;
