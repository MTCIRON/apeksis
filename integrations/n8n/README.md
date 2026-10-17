# n8n integrations — decision owner

Import JSON files into your existing self-hosted n8n. Nodes use versions available in [n8n 1.94.1 source](https://github.com/n8n-io/n8n/tree/n8n%401.94.1/packages/nodes-base/nodes); this is a schema reference, not a recommendation to deploy an old n8n release. Use a supported, security-patched n8n deployment. Import/runtime execution has not been verified here.

## Turn agent

`turn-agent.json` is an actual stateless Turkish acknowledgement policy, not an LLM mock: authenticated final utterance → schema validation → deterministic `speak` action. All text selection is inside n8n. The example quotes short utterances and acknowledges long ones without claiming they were persisted. No external cloud provider, memory, tools, or phone control is implied. Replace this n8n policy with your own prompts/LLM/tool workflow if needed; gateway remains a transport/schema boundary.

1. Import workflow. On `Authenticated turn`, create/select **Header Auth** credential: name `Authorization`, value `Bearer <VOXI_N8N_API_KEY>`. This secret must differ from audio/worker credentials. Imported workflow has no credentials embedded and cannot run unauthenticated.
2. Publish/activate workflow. Use production `/webhook/voxi-turn`, not `/webhook-test/voxi-turn`. [Webhook authentication and response modes](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/).
3. Allow gateway container to reach n8n: for an existing local Docker n8n container, `docker network connect voxi_speech <n8n-container>` after bringing up base speech. Set `VOXI_N8N_WEBHOOK_URL=http://<n8n-container>:5678/webhook/voxi-turn` and `VOXI_N8N_API_KEY` in Voxi `.env`; recreate gateway with `docker compose up -d gateway`. Use your actual container hostname and secured deployment route, not host loopback inside Docker.
4. POST `/v1/sessions` using audio key, then POST `/v1/sessions/{session_id}/turns` with `{"transcript":"Merhaba","language":"tr-TR","context":{}}`. Read returned `action`; in M1 this does **not** synthesize/play media automatically. Send `action.text` separately to `/v1/audio/speech` to obtain audio. DELETE session afterward. No SIP runtime exists.

Webhook payload schema: `schema_version="1.0"`, `event_type="utterance.final"`, nonempty string `call_id/session_id/turn_id/correlation_id`, positive integer `sequence/generation_id`, ISO timestamp, transcript, `tr` or `tr-TR`, caller object, context object. Response includes `schema_version`, `action="speak"`, text, language, physical EMA voice and **`idempotency_key=call_id:turn_id`**. No RTP/audio bytes sent to n8n.

Machine-readable action contract: [`packages/contracts/n8n-action.schema.json`](../../packages/contracts/n8n-action.schema.json), generated from the same `TurnAction` model used to validate webhook responses.

Duplicate turns produce identical actions. This policy has no side effects; it does not claim durable transactional exactly-once execution. Before adding bookings, payments, tools, or memory writes, enforce durable idempotency keyed by `call_id:turn_id`, atomic insertion and duplicate replay across process restart/concurrent executions. Gateway rejects stale generations and validates the response; business decisions remain n8n's. Gateway currently makes one timeout-bounded attempt, returns a configured fallback on failure, and does not perform webhook retries. Transfer fields are schema/policy checks only, not implemented phone transfer.

## Realtime session transport (same decision owner)

`POST /v1/sessions/{id}/turns` is the only HTTP turn path: it returns an action but never plays audio. `WS /v1/sessions/{id}/stream` (ADR 0005) is the streaming alternative for a client that carries media. Open the session with an audio key, then connect the socket **with that same key**, which must also hold `realtime:connect`: sessions are owner-scoped, so a different key is refused at handshake. The gateway does VAD endpointing, transcribes the utterance and posts **the identical schema 1.0 `utterance.final` payload** to the same fixed webhook; n8n's returned `speak` action is synthesized and streamed back as framed PCM16, and `transfer`/`hangup` arrive as events for the client to execute. Nothing about n8n's ownership changes: no prompt, LLM call, tool or memory lives in the transport, and no audio bytes are ever sent to n8n.

Client-side pseudocode for the `turn-agent.json` workflow over the socket (protocol reference only; no WebSocket client has been exercised against n8n here):

```python
# after POST /v1/sessions -> {"session_id": ...}
async with ws(f"{base}/v1/sessions/{session_id}/stream?token={REALTIME_KEY}") as sock:
    await send_audio_frames(sock)          # mono PCM16 at 8000/16000 Hz
    # gateway barges in on detected speech, then emits action + audio for the n8n reply
```

The workflow itself needs no modification for either path.

## File speech workflows

`file-tts.json`: authenticated JSON webhook `voxi-file-tts`, body `{"text":"Merhaba dünya."}` → real Voxi WAV request → binary WAV response.

`file-stt.json`: authenticated raw-audio webhook `voxi-file-stt` → `audio` binary → multipart `file/model/language` request → real Voxi transcript JSON. POST WAV as raw body (`Content-Type: audio/wav`), **not** multipart to the webhook; the HTTP node builds multipart for Voxi.

For both workflows select Header Auth on incoming webhook (your own integration key), and a **separate** Header Auth credential on Voxi HTTP Request node: `Authorization: Bearer <VOXI_API_KEY>`. Connect n8n to `voxi_speech` or change HTTP node's fixed URL to a secured reachable gateway address. Never point a Docker peer at `127.0.0.1:8080`; that addresses itself. Never expose the workers.

Responses use real inference; workflow execution needs provisioned/readied workers. n8n's default webhook payload limit is 16 MB, lower than Voxi's 25 MiB. Keep inbound samples below the lower limit or deliberately configure both systems. Execution data saving is disabled in examples; still review n8n logging/retention, failure traces, credentials, backups, and KVKK consent policy.
