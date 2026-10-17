# ADR 0001: Speech services independent of decisions
Status: Accepted

The public FastAPI gateway authenticates and routes file STT/TTS to isolated workers. Workers load one model per process. n8n alone owns prompts, LLM calls, tools, memory and business decisions. Gateway validates turn responses and enforces transfer policy; no autonomous LLM runtime is installed. File speech works without n8n, Redis, PostgreSQL or telephony.

The gateway's WebSocket transports (ADR 0005) only segment inbound audio with model-free energy VAD, transcribe it, deliver the transcript to n8n and play out the action n8n returned. They select no action, hold no prompt, memory or conversation policy beyond per-session cancellation generations, so this boundary is unchanged by streaming.
