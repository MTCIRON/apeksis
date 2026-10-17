// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

export type LogKind = "http" | "ws" | "error" | "ui";

export interface LogEntry {
  id: number;
  ts: string;
  kind: LogKind;
  method: string;
  path: string;
  status?: number;
  ms?: number;
  requestId?: string;
  detail?: string;
}

const MAX_ENTRIES = 500;

let sequence = 0;
const entries: LogEntry[] = [];
const listeners = new Set<() => void>();

export function pushLog(entry: Omit<LogEntry, "id" | "ts">): void {
  entries.unshift({ ...entry, id: ++sequence, ts: new Date().toISOString() });
  if (entries.length > MAX_ENTRIES) entries.pop();
  listeners.forEach((notify) => notify());
}

export function getLogs(): LogEntry[] {
  return entries;
}

export function subscribeLogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearLogs(): void {
  entries.length = 0;
  listeners.forEach((notify) => notify());
}
