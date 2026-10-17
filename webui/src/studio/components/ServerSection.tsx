// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

// Settings → Sunucu: the gateway's ONE surface (Aşama 9b).
//
// The full-screen "Sunucu" panel that used to hold this is gone. Everything the
// gateway has is here, in one column: the connection, the live status and the
// endpoint catalog.
//
// The status is NOT fetched here. It is the same `gateway` state the status bar
// shows (lib/useGateway.ts), so there is one poll and one truth, and "Yenile" is
// exactly the call that poll makes. The catalog is read only while the section is
// visible — nobody pays for a table they never open. Nothing is fabricated: a
// failing call shows the gateway's own status, code and request id.

import { useEffect, useState } from "react";
import { ApiError, fetchEndpoints, type EndpointEntry } from "../../api/client";
import type { GatewayHealth } from "../../lib/useGateway";
import { ServerConnection } from "./ServerConnection";
import { Badge, Button, Hint, SettingsBlock, Table, Td, Th, Tr } from "./ui";

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const request = error.requestId ? ` · ${error.requestId}` : "";
    return `${error.status} · ${error.code}${request}`;
  }
  return String(error);
}

/** When the last answer arrived, in the user's own clock. */
function checkedAt(at: number | null): string {
  if (at === null) return "henüz kontrol edilmedi";
  return `son kontrol ${new Date(at).toLocaleTimeString("tr-TR", { hour12: false })}`;
}

function Health({ gateway }: { gateway: GatewayHealth }) {
  const workers = Object.entries(gateway.ready?.workers ?? {});
  const known = gateway.at !== null;
  const tone = !known ? "neutral" : gateway.failed ? "bad" : gateway.health === "ok" ? "ok" : "warn";
  const liveness = !known ? "kontrol edilmedi" : gateway.failed ? "erişilemedi" : (gateway.health ?? "?");

  return (
    <SettingsBlock
      title="Durum"
      actions={
        <Button onClick={gateway.refresh} title="Ağ geçidine şimdi sor">
          Yenile
        </Button>
      }
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12.5px] text-fg-2">Canlılık</span>
        <Badge tone={tone}>{liveness}</Badge>
      </div>

      <div className="grid gap-1.5">
        <span className="text-[12.5px] text-fg-2">Servisler</span>
        {workers.length === 0 ? (
          <span className="text-[12px] text-fg-3">
            {gateway.failed ? "Ağ geçidi /readyz yanıtı vermedi." : "Henüz okunmadı."}
          </span>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {workers.map(([name, ok]) => (
              <Badge key={name} tone={ok ? "ok" : "warn"}>
                {name}: {ok ? "hazır" : "bekliyor"}
              </Badge>
            ))}
          </div>
        )}
      </div>

      <Hint>{checkedAt(gateway.at)} · /healthz ve /readyz, durum çubuğuyla aynı yoklamadan.</Hint>
    </SettingsBlock>
  );
}

function Endpoints({ active }: { active: boolean }) {
  const [endpoints, setEndpoints] = useState<EndpointEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by "Yenile": the effect runs again and reads the catalog. */
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (!active) return;
    let alive = true;
    setError(null);
    void fetchEndpoints()
      .then((catalog) => {
        // A body without the array is not a catalog: show the empty state, do
        // not fall through to `endpoints.length`.
        if (alive) setEndpoints(Array.isArray(catalog?.endpoints) ? catalog.endpoints : []);
      })
      .catch((failure) => {
        if (!alive) return;
        setEndpoints(null);
        setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [active, round]);

  return (
    <SettingsBlock
      title="Uçlar"
      actions={
        <Button onClick={() => setRound((n) => n + 1)} title="Kataloğu yeniden oku">
          Yenile
        </Button>
      }
    >
      {error ? (
        <Hint>Katalog alınamadı: {error}</Hint>
      ) : endpoints === null ? (
        <Hint>Katalog okunuyor…</Hint>
      ) : endpoints.length === 0 ? (
        <Hint>Ağ geçidi hiç uç bildirmedi.</Hint>
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Yol</Th>
              <Th>Servis</Th>
            </tr>
          </thead>
          <tbody>
            {endpoints.map((endpoint, index) => (
              <Tr key={`${endpoint.method}-${endpoint.path}-${index}`}>
                <Td>
                  <span className="font-mono text-[11px] text-fg-3">{endpoint.method}</span>{" "}
                  <span className="font-mono text-[11.5px] text-fg">{endpoint.path}</span>
                  <p className="mt-0.5 text-[11px] text-fg-3">{endpoint.purpose}</p>
                  {Array.isArray(endpoint.scopes) && (
                    <p className="mt-0.5 font-mono text-[10.5px] text-fg-3">
                      {endpoint.scopes.length
                        ? `kapsam: ${endpoint.scopes.join(" · ")}`
                        : "kapsam: açık"}
                    </p>
                  )}
                </Td>
                <Td className="whitespace-nowrap">
                  <Badge tone="neutral">{endpoint.service}</Badge>
                </Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      )}
    </SettingsBlock>
  );
}

/**
 * The whole section. `active` is true only while this section is on screen, so
 * the runtime-status and endpoint reads happen when they are looked at.
 */
export function ServerSection({ active, gateway }: { active: boolean; gateway: GatewayHealth }) {
  return (
    <div className="grid gap-4">
      <ServerConnection active={active} />
      <Health gateway={gateway} />
      <Endpoints active={active} />
    </div>
  );
}
