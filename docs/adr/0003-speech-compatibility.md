# ADR 0003: Explicit audio compatibility subset
Status: Accepted

Expose OpenAI-style models, speech and file transcription only. WAV/PCM/MP3 must contain their advertised encoding. One physical EMA voice, optional explicit alloy compatibility alias with warning. Antalia has its own single voice. Translation, styling and OpenAI Realtime are not implemented and must fail clearly. Native upstream HTTP/WebSocket contracts are not impersonated by aliases.

Each provider owns normalization exactly once using its integrated implementation. Gateway does not transform canonical text, STT transcripts or n8n tool arguments. Upstream policy limitations must be documented rather than accepting unsupported preserve/reject/context hints as no-ops. Advanced normalization policies and streaming belong to later measured milestones.
