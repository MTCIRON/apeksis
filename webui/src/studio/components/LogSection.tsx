// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Settings → Günlük: the single log of /ui/ (Aşama 9b).
//
// Every gateway call (api/client.ts) and every notice the workspace shows land in
// lib/debug.ts, and this is the only place they are read. It used to be a tab of
// the full-screen server panel; it is a settings section now, so the app has one
// place for everything the gateway does.
//
// The health poll is deliberately NOT logged (lib/useGateway.ts), so the list
// stays the calls the user made.

import { useEffect, useState } from "react";
import { clearLogs, getLogs, subscribeLogs, type LogEntry } from "../../lib/debug";
import { Badge, Button, Hint, SettingsBlock, Table, Td, Th, Tr } from "./ui";

export function LogSection() {
  const [logs, setLogs] = useState<LogEntry[]>(getLogs());
  useEffect(() => subscribeLogs(() => setLogs([...getLogs()])), []);

  return (
    <SettingsBlock
      title="Günlük"
      actions={
        <>
          <span className="text-[11px] text-fg-3 tabular-nums">{logs.length} kayıt</span>
          <Button onClick={clearLogs} disabled={logs.length === 0} title="Günlüğü boşalt">
            Temizle
          </Button>
        </>
      }
    >
      {logs.length === 0 ? (
        <Hint>Henüz istek yok. Sunucuya yapılan çağrılar ve çalışma alanının bildirimleri burada listelenir.</Hint>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>zaman</Th>
              <Th>yöntem</Th>
              <Th>yol</Th>
              <Th>olay</Th>
              <Th>durum</Th>
              <Th>süre</Th>
              <Th>istek-id</Th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <Tr key={log.id}>
                <Td className="tabular-nums text-fg-3">{log.ts.slice(11, 19)}</Td>
                <Td className="whitespace-nowrap font-mono">
                  {log.method}
                  {log.kind !== "http" && <span className="ml-1.5 text-fg-3">{log.kind}</span>}
                </Td>
                <Td className="font-mono">{log.path}</Td>
                <Td>{log.detail ?? "—"}</Td>
                <Td>
                  {log.status !== undefined ? (
                    <Badge tone={log.status < 400 ? "ok" : "bad"}>{log.status}</Badge>
                  ) : (
                    <span className="text-fg-3">—</span>
                  )}
                </Td>
                <Td className="tabular-nums">{log.ms !== undefined ? `${log.ms} ms` : "—"}</Td>
                <Td className="font-mono text-fg-3">{log.requestId ?? "—"}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </SettingsBlock>
  );
}
