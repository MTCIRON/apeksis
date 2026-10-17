// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** 75.3 -> "01:15", or "1:02:05" past an hour. */
export function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** Subtitle timestamp: "00:01:15,300" (SRT) or "00:01:15.300" (VTT). */
export function stamp(sec: number, sep: "," | "."): string {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)}${sep}${pad(ms % 1000, 3)}`;
}

export function megabytes(bytes: number): string {
  return (bytes / 1_000_000).toLocaleString("tr-TR", { maximumFractionDigits: bytes < 10_000_000 ? 1 : 0 });
}

/** 73_000_000 -> "73 MB", 1_500_000_000 -> "1,5 GB". */
export function fileSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toLocaleString("tr-TR", { maximumFractionDigits: 1 })} GB`;
  return `${megabytes(bytes)} MB`;
}

export function duration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)} sn`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} dk`;
  return `${Math.floor(m / 60)} sa ${m % 60} dk`;
}

/** Time left, roughly: "1 dakikadan az", "12 dk", "1 sa 5 dk". */
export function remaining(sec: number): string {
  if (sec < 60) return "1 dakikadan az";
  const m = Math.round(sec / 60);
  return m < 60 ? `${m} dk` : `${Math.floor(m / 60)} sa${m % 60 ? ` ${m % 60} dk` : ""}`;
}
