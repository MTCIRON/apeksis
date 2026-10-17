// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Small status marks shared by the status bar, menus and the stage.

/** Thin progress bar, 0..1. Width comes from `className` (72px by default). */
export function Meter({ value, className = "w-[72px]" }: { value: number; className?: string }) {
  return (
    <span className={`relative block h-[3px] flex-none overflow-hidden rounded-[2px] bg-line ${className}`} aria-hidden>
      <span
        className="absolute inset-0 origin-left bg-linear-to-r from-[#3a62e0] to-[#4f74e8] transition-transform duration-200 ease-linear motion-reduce:transition-none"
        style={{ transform: `scaleX(${value})` }}
      />
    </span>
  );
}

/** Blinking red dot: the microphone is on. */
export const RecDot = () => (
  <span className="size-2 flex-none animate-rec rounded-full bg-mercan motion-reduce:animate-none" aria-hidden />
);
