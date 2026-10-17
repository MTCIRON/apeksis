// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Resizable / collapsible panel state, persisted per-panel in localStorage.
//
// This is the "panel system" the workspace registers with (the studio's transcript
// and inspector columns) plus the one remembered string the app keeps for the
// settings window's section. Layout survives reloads; widths are clamped so a
// panel can never be dragged shut by accident.

import { useCallback, useState } from "react";

const PREFIX = "voxi.ui.panel.";

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function readNumber(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

function writeNumber(key: string, value: number) {
  try {
    localStorage.setItem(PREFIX + key, String(Math.round(value)));
  } catch {
    /* private mode / storage disabled: layout just won't persist */
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw === null ? fallback : raw === "1";
  } catch {
    return fallback;
  }
}

function writeBool(key: string, value: boolean) {
  try {
    localStorage.setItem(PREFIX + key, value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

/** A persisted, clamped column width with a pointer-drag resize handler. */
export function usePanelWidth(key: string, initial: number, min: number, max: number) {
  const [width, setWidth] = useState(() => clamp(readNumber(key, initial), min, max));

  const startResize = useCallback(
    (side: "left" | "right", e: React.PointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = width;
      let current = startWidth;

      const move = (ev: PointerEvent) => {
        const dx = side === "left" ? ev.clientX - startX : startX - ev.clientX;
        current = clamp(startWidth + dx, min, max);
        setWidth(current);
      };
      const up = () => {
        writeNumber(key, current);
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    },
    [key, max, min, width],
  );

  return { width, startResize };
}

/** A persisted open/closed flag. */
export function usePanelOpen(key: string, initial: boolean) {
  const [open, setOpenState] = useState(() => readBool(key, initial));
  const setOpen = useCallback(
    (value: boolean) => {
      writeBool(key, value);
      setOpenState(value);
    },
    [key],
  );
  const toggle = useCallback(() => setOpen(!open), [open, setOpen]);
  return { open, setOpen, toggle };
}

/** A persisted string value (e.g. last active settings section). */
export function useStoredValue(key: string, initial: string) {
  const [value, setValue] = useState<string>(() => {
    try {
      return localStorage.getItem(PREFIX + key) ?? initial;
    } catch {
      return initial;
    }
  });
  const update = useCallback(
    (next: string) => {
      try {
        localStorage.setItem(PREFIX + key, next);
      } catch {
        /* ignore */
      }
      setValue(next);
    },
    [key],
  );
  return [value, update] as const;
}
