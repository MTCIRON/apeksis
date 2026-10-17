# OpenWebUI audio only

`audio.env.example` supplies actual audio-specific environment variables verified from [OpenWebUI v0.6.5 config.py](https://github.com/open-webui/open-webui/blob/v0.6.5/backend/open_webui/config.py). This is a source-shape reference, not a recommendation to deploy an old vulnerable release. Use a supported security-patched OpenWebUI and check its current audio settings.

Set both audio engines to `openai`, STT model `whisper-1`, TTS model `ema-lightning`, voice `ema-tr`, both base URLs ending `/v1`, and both audio API keys to your user-provisioned Voxi audio key. Do not change the chat/LLM provider or set a default paid cloud endpoint. For Antalia, explicitly enable its Voxi worker/registration first and set TTS model `antalia-mini`, voice `antalia-tr`.

Existing admin database settings can override environment variables. Apply settings through Admin Settings → Audio or deliberately set `ENABLE_PERSISTENT_CONFIG=False` if your operational policy uses env as authority; this disables persistent configuration globally, not just audio.

Docker peers need an explicitly shared network (`docker network connect voxi_speech <openwebui-container>`) and `http://gateway:8080/v1`. A host process can use `http://127.0.0.1:8080/v1`. Inside a container, localhost addresses that container. Host-gateway routing may not reach a localhost-only listener; do not widen public binding to solve this.

When OpenWebUI runs on a **different device** on the same LAN, the `gateway` service name and any `127.0.0.1`/`localhost` URL are unreachable — the other device cannot resolve them. The published gateway port defaults to a loopback-only binding, so a LAN address will also refuse it until you opt in: set `VOXI_BIND_IP` in Voxi's `.env` to this PC's LAN IP (never a public/WAN address), recreate the gateway, restrict the host (Windows) firewall inbound rule to your trusted subnet, and point OpenWebUI at `http://<that-LAN-ip>:8080/v1`. Workers stay unpublished; keep the bearer `VOXI_API_KEY` strong and do not add a router/WAN port forward.

Run Voxi SDK smoke first, then perform actual OpenWebUI file transcription and Turkish playback. Record supported client version, HTTP request parameters, observed transcript/audio, and local-only traffic evidence without storing private user text. Default MP3 is real FFmpeg encoding, not WAV renamed.

Unverified: OpenWebUI UI setup/runtime calls, browser decoding/autoplay, microphone capture, and model/voice discovery behavior. Voxi file APIs are not OpenAI Realtime. Voxi's own WebSocket transports (ADR 0005) are custom client protocols that OpenWebUI does not speak; integrating them means writing a custom client, and none has been exercised against this gateway. No admin credentials are supplied; configure OpenWebUI accounts/security independently.
