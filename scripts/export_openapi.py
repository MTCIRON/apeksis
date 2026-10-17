# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

import json
from pathlib import Path
from typing import Annotated, Union

from pydantic import Field, TypeAdapter

from voxi.contracts import (
    RealtimeTranscriptionControl,
    RealtimeTranscriptionStart,
    StreamInboundEvent,
    StreamOutboundEvent,
    TranscriptionOutboundEvent,
    TtsStreamControl,
    TtsStreamOutboundEvent,
    TtsStreamRequest,
    TurnAction,
)
from voxi.gateway import app

path = Path("packages/contracts/openapi.json")
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(app.openapi(), ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(path)
action_path = path.with_name("n8n-action.schema.json")
action_path.write_text(
    json.dumps(TurnAction.model_json_schema(), ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
print(action_path)

AUDIO_FRAME = {
    "description": (
        "Binary frame: 4-byte big-endian header (uint16 generation_id, uint16 sequence) "
        "followed by PCM16 signed little-endian mono samples at the negotiated sample_rate."
    )
}


def frame_schema(*models: type) -> dict:
    """One model becomes its own schema; several become a discriminated union."""
    if len(models) == 1:
        return models[0].model_json_schema()
    variants = Union[*models]
    adapter = TypeAdapter(Annotated[variants, Field(discriminator="type")])
    return adapter.json_schema()


# OpenAPI cannot describe WebSocket routes, so their frames get a standalone contract file.
stream_path = path.with_name("stream-protocol.schema.json")
stream_path.write_text(
    json.dumps(
        {
            "title": "Voxi WebSocket frame contracts (ADR 0005)",
            "description": (
                "Text frames are UTF-8 JSON validated by these strict extra-forbid models on both "
                "directions. Voxi-defined protocols only: no OpenAI Realtime or upstream native "
                "contract is emulated. Bearer scopes are enforced at handshake."
            ),
            "routes": {
                "/v1/sessions/{session_id}/stream": {
                    "scope": "realtime:connect",
                    "inbound": frame_schema(StreamInboundEvent),
                    "inbound_audio": AUDIO_FRAME,
                    "outbound": frame_schema(StreamOutboundEvent),
                    "outbound_audio": AUDIO_FRAME,
                },
                "/v1/tts/stream": {
                    "scope": "audio:write",
                    "inbound": frame_schema(TtsStreamRequest, TtsStreamControl),
                    "outbound": frame_schema(TtsStreamOutboundEvent),
                    "outbound_audio": AUDIO_FRAME,
                },
                "/v1/realtime/transcriptions": {
                    "scope": "audio:write",
                    "inbound": frame_schema(
                        RealtimeTranscriptionStart, RealtimeTranscriptionControl
                    ),
                    "inbound_audio": {
                        "description": (
                            "Raw PCM16 signed little-endian mono at the session.start sample_rate; "
                            "no container header, no frame header."
                        )
                    },
                    "outbound": frame_schema(TranscriptionOutboundEvent),
                },
            },
        },
        ensure_ascii=False,
        indent=2,
    )
    + "\n",
    encoding="utf-8",
)
print(stream_path)
