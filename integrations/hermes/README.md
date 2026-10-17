# Hermes local file audio

This is **file transcription and file TTS guidance**, not Hermes realtime protocol support and not permission to move Voxi's phone-agent decisions out of n8n. Hermes remains an external speech client.

Merge `config.yaml.example` into `~/.hermes/config.yaml`; set `VOXI_API_KEY=<your-audio-key>` in `~/.hermes/.env`. [Hermes configuration](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/) resolves `${VAR}` values from that secret file. Both providers must explicitly be `openai`, with local `/v1` base URLs and a real Voxi key. Do not select Edge/cloud/default autodetection and assume local-only speech.

Configuration researched at upstream commit **`3f2abce7f468cf194bb7f9ff9c6a033b075d834c`**:

- [File STT source](https://github.com/NousResearch/hermes-agent/blob/3f2abce7f468cf194bb7f9ff9c6a033b075d834c/tools/transcription_cloud.py): `stt.openai.base_url`, `api_key`, `model=whisper-1`, `language=tr`; uses `/audio/transcriptions`, normally `response_format=text` for Whisper.
- [File TTS source](https://github.com/NousResearch/hermes-agent/blob/3f2abce7f468cf194bb7f9ff9c6a033b075d834c/tools/tts_tool_openai.py): `tts.openai.base_url`, `api_key`, `model=ema-lightning`, `voice=ema-tr`; SDK file speech request. Newer config supersedes older guidance mentioning `STT_OPENAI_BASE_URL`; the inspected resolver does not read that environment variable, so do not rely on it. Check the actual version installed.

From Docker, `127.0.0.1` is the Hermes container, not Voxi. Prefer explicitly shared `voxi_speech` network and change both URLs to `http://gateway:8080/v1`. Keep gateway loopback publishing and internal workers private. Host/router egress deny verifies local-only behavior; explicit URL configuration alone is not traffic evidence.

After real Voxi readiness and [SDK smoke](../../docs/deployment.md#real-openai-sdk-smoke), invoke installed Hermes file transcription on `smoke-output/response.wav` and file TTS on short Turkish text saving `.mp3` or `.wav`; inspect output through FFmpeg/listening and capture redacted request logs. Hermes installation/tool invocation varies by release; use its installed tool documentation rather than invent a CLI signature.

Voxi supports WAV/PCM/MP3, not Opus, expressive instructions, cloning, or alternate physical voices. Hermes voice-bubble targets can request Opus: those modes are not claimed compatible. Do not supply optional TTS `instructions`, `language`/`consent_attestation` extras or request a voice-design model; strict gateway validation rejects unsupported fields. Use default speed 1.0 unless the selected backend advertises another supported value.

**Unverified:** actual Hermes installation, tool discovery, file request execution, chat-platform voice bubbles, realtime/microphone streaming. Tested source shapes are research, not client acceptance evidence.
