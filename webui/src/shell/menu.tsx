// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Toolbar dropdowns: a trigger and a panel that closes on an outside click or Escape.
// Ported from the original studio app (components/Menu.tsx).

import { useEffect, useRef, type ComponentProps, type ReactNode } from "react";

export function Menu({
  open,
  onOpenChange,
  trigger,
  align = "right",
  width = "w-[300px]",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The button; it toggles `open` itself. */
  trigger: ReactNode;
  align?: "left" | "right";
  width?: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => {
      // A dropdown list opened from inside the menu lives on the body (data-floating) but belongs to it.
      const inside = root.current?.contains(e.target as Node) || (e.target as Element).closest?.("[data-floating]");
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !inside) onOpenChange(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open, onOpenChange]);

  return (
    <div className="relative" ref={root}>
      {trigger}
      {open && (
        <div
          className={`absolute top-[calc(100%+6px)] z-20 max-h-[calc(100dvh-64px)] max-w-[calc(100vw-20px)] overflow-y-auto rounded-[10px] border border-[#363e48] bg-[rgba(34,39,46,0.96)] p-1.5 shadow-[0_16px_40px_rgba(0,0,0,0.6),0_0_0_1px_rgba(255,255,255,0.05)] backdrop-blur-[16px] ${align === "left" ? "left-0" : "right-0"} ${width}`}
          role="menu"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export const MenuGroup = ({ children }: { children: ReactNode }) => (
  <div className="grid border-line py-1 [&+&]:border-t">{children}</div>
);

export const MenuTitle = ({ children }: { children: ReactNode }) => (
  <span className="px-2 py-1 text-[11px] font-semibold tracking-[0.04em] text-fg-3 uppercase">{children}</span>
);

/** Small grey text; turns white with its item on hover. */
export const MenuNote = ({ children }: { children: ReactNode }) => (
  <span className="text-[11.5px] text-fg-3 group-[:hover:not(:disabled)]/item:text-white/85">{children}</span>
);

export const MenuFoot = ({ children }: { children: ReactNode }) => (
  <p className="mx-2 mt-1 mb-0.5 text-[11.5px] text-fg-3">{children}</p>
);

export const MenuError = ({ children }: { children: ReactNode }) => (
  <p className="mx-2 my-1 text-[12px] text-mercan">{children}</p>
);

const ITEM =
  "group/item flex rounded-ui-sm border-0 bg-transparent px-2 py-1.5 text-left text-[12.5px] no-underline transition-all duration-120 ease-[ease] hover:not-disabled:bg-cini hover:not-disabled:text-white disabled:opacity-40";

/** Label and note side by side; `choice` stacks an icon, label and note instead. */
const itemClass = (choice: boolean) =>
  `${ITEM} ${choice ? "items-start justify-start gap-2" : "items-baseline justify-between gap-3"} text-fg`;

export const MenuItem = ({ choice = false, ...props }: ComponentProps<"button"> & { choice?: boolean }) => (
  <button className={itemClass(choice)} role="menuitem" {...props} />
);
