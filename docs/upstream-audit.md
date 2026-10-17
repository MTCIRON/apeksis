# Speech upstream audit

Audit date: 2026-10-12. This records inspected package sources and model identities, not measured runtime quality or performance. Runtime/test results belong to the integration report. No copied code from Hitabet, the earlier application, EMA API forks, or AGPL reference applications.

## Exact package pins

| Component | Pin | Inspected primary source |
|---|---|---|
| EMA | `ema-lightning==1.1.2` | [PyPI JSON](https://pypi.org/pypi/ema-lightning/1.1.2/json), published wheel `ema_lightning/api.py`, `frontend.py`, `model.py`, `decoder.py` |
| EMA native normalizer | `normalizer-tr==0.7.0` | [PyPI](https://pypi.org/pypi/normalizer-tr/0.7.0/json), [official Rust/Python project](https://github.com/erdemtuna/normalizer-tr) |
| Optional Antalia | `antalia-mini==1.0.1` | [PyPI JSON](https://pypi.org/pypi/antalia-mini/1.0.1/json), published wheel `antalia_mini/api.py`, `weights.py`, `NOTICE` |
| PyTorch | `torch==2.7.0` | [PyPI JSON](https://pypi.org/pypi/torch/2.7.0/json) |
| Hub client | `huggingface-hub==0.30.2` | [PyPI JSON](https://pypi.org/pypi/huggingface-hub/0.30.2/json) |
| Antalia data/runtime | `cmudict==1.0.32`, `safetensors==0.5.3`, `soundfile==0.13.1` | [cmudict](https://pypi.org/pypi/cmudict/1.0.32/json), [safetensors](https://pypi.org/pypi/safetensors/0.5.3/json), [SoundFile](https://pypi.org/pypi/soundfile/0.13.1/json) |
| STT | `faster-whisper==1.2.1` | [PyPI JSON](https://pypi.org/pypi/faster-whisper/1.2.1/json), published wheel `faster_whisper/transcribe.py`, `vad.py` |
| STT runtime | `ctranslate2==4.6.0`, `av==16.0.1`, `onnxruntime==1.22.0`, `tokenizers==0.21.1` | [CT2](https://pypi.org/pypi/ctranslate2/4.6.0/json), [PyAV](https://pypi.org/pypi/av/16.0.1/json), [ORT](https://pypi.org/pypi/onnxruntime/1.22.0/json), [tokenizers](https://pypi.org/pypi/tokenizers/0.21.1/json) |

EMA wheel SHA-256: `821c737587d2db32f83a863abadd455610720d359872f6fb8b08ddd1c9b84840`.
Antalia wheel SHA-256: `0dd5cd76645f46443cccda2575ce5ba854c62e464702d436c06152852d975644`.
All resolved artifacts and transitive dependencies are pinned with hashes in `uv.lock`. PyAV 16.0.1 replaces 14.4.0 because the latter required an unavailable Windows source-build toolchain; parent verified 16.0.1 CPython 3.12 Windows/manylinux wheels. It satisfies Faster-Whisper's `av>=11` constraint.

Runtime smoke exposed CTranslate2 4.6.0's import-time dependency on `pkg_resources`, removed in newer setuptools. STT therefore pins `setuptools==80.3.1`, which supplies that required module. This is a compatibility dependency, not an exception suppression or fake fallback.

NVIDIA profile uses the official `torch==2.7.0+cu126` variant, matching `uv.lock`'s CUDA 12.6 and cuDNN 9.5.1.17 requirements. The [cu126 wheel metadata](https://download-r2.pytorch.org/whl/cu126/torch-2.7.0%2Bcu126-cp312-cp312-manylinux_2_28_x86_64.whl.metadata) was inspected and the complete constrained graph resolved with uv inside a Linux container. cu128 requires different NVIDIA versions and is not interchangeable with this lock. Actual GPU installation/inference is not claimed.

## Verified EMA contract

Official `EMA(device="auto")` accepts **no model-path or revision argument**. Its constructor resolves `config.json`, `ema.pt`, `decoder.pt` with `hf_hub_download` from `canberkkkkkk/ema-lightning`. Voxi provisions the exact HF cache snapshot and `refs/main`, verifies immutable file identities, sets `HF_HUB_CACHE` and `HF_HUB_OFFLINE=1` **before lazy import**, then calls the unmodified public constructor. Workers must remain isolated processes; do not initialize differently cached EMA models in one process.

`say(text, speed=1.0, seed=None, sample_rate=48000, path=None)` returns `Speech.audio` mono float32, `sample_rate`, `duration`, `seed`, and `words`. `stream(text, speed=1.0, seed=None, sample_rate=48000)` returns float32 chunk arrays. Official accepted rates are 8000/16000/24000/48000 and speed 0.25–4. Native stream closes cancel queued work at chunk boundaries; an active native kernel cannot be promised preemptible. Voxi consumes `stream()` only behind its own authenticated internal route and re-chunks the output to the negotiated wire size; upstream's native call signature and chunking are never republished as a public realtime endpoint, and no OpenAI Realtime shape is imitated.

`frontend.Frontend` creates/reuses `normalizer_tr.Normalizer` and calls `normalize(..., ambiguity_policy="fallback")`. It catches normalization failures and preserves original text, then filters against the model alphabet. Therefore:

- Owner is `ema_integrated`; canonical input is passed unchanged, once, to `say`/`stream`.
- Disabled/gateway normalization, preserve/reject policies, and context hints fail startup explicitly; pinned upstream cannot honor them.
- Normalization completion, issue list, and fallback-used status are **unknown**, not falsely reported successful. `X-Normalization-Complete: unknown` is intentional.
- When `Speech.words` is available, provider result records their joined spoken word text alongside canonical input. This is a rendering word sequence, not a financial/identity validation result or reconstructed original punctuation. No extra normalization call is made for diagnostics.
- EMA loaders use `torch.load(..., weights_only=True)`; no `trust_remote_code`.

Primary project: [official EMA](https://github.com/canberk7/ema-lightning), [API docs](https://github.com/canberk7/ema-lightning/blob/main/docs/api.md). Published wheel, rather than mutable `main`, was used for implementation.

## Verified Antalia contract

`Antalia(model=<local directory>, device="cpu", variant="fp32", warmup=False)` directly loads local `config.json`, `acoustic.safetensors`, `vocoder.safetensors`. Native loader verifies weight hashes against its config. Voxi additionally checks independent pinned inventory and manifest before import. `say`/`stream` accept `seed`, `speed`, `sample_rate`, plus upstream `steps`, `cfg`, `eq`; M1 does **not** expose latter settings. Native positive speed is honored within Voxi's documented 0.25–4 bound. Requested rates use upstream resampling; one physical synthetic male voice is exposed as `antalia-tr`.

Native `say` and `stream` call `model_text(raw input)`. `Antalia.normalize(text)` exists for inspection but calling it for diagnostics would run a second normalization pass, so Voxi does not call it. Owner/policy are `native`; no configurable ambiguity policy or context hints exists in inspected API. Unsupported policies fail startup. `spoken_text`, completion/issues/fallback status remain unknown because native `Speech` does not expose them. Canonical input is preserved, never replaced by an expansion.

The package serializes network inference under a lock. Generator cancellation is between yielded chunks, never a mid-kernel abort. Closing/cancelling drops late generation-tagged results. Optional worker is absent from default registry; Antalia remains experimental until real hardware and listening benchmarks pass. This is **Antalia-2 Mini**, not Antalia 1/OpenRAIL-M.

[Official model](https://huggingface.co/cloud0day3/antalia-mini), [pinned NOTICE](https://huggingface.co/cloud0day3/antalia-mini/blob/8a79528770af2ed5cb6d3b9ac1248d370429f272/NOTICE).

## Verified Faster-Whisper contract

`WhisperModel(<local directory>, device="cpu", compute_type="int8", cpu_threads=4, num_workers=1, local_files_only=True)` bypasses model download. **Local tokenizer.json is mandatory**: upstream otherwise calls `Tokenizer.from_pretrained`. Provisioning always includes it. Larger turbo model is opt-in; no silent replacement of CPU-small default.

Trusted FFmpeg decoder produces 16 kHz mono float32. Only exact public inputs `language`, `prompt`, `temperature` are forwarded as `language`, `initial_prompt`, scalar `temperature`; inference additionally sets `task="transcribe", vad_filter=True`. Supported languages come from actual engine. Transcripts and prompts are never TTS-normalized. VAD uses bundled `silero_vad_v6.onnx`, CPU ONNX Runtime, without runtime download. Startup consumes native transcription generator with VAD disabled (silence must reach encoder/decoder), then executes VAD warmup. Readiness becomes true only after both succeed.

[Official source](https://github.com/SYSTRAN/faster-whisper/tree/v1.2.1), [GPU prerequisites](https://github.com/SYSTRAN/faster-whisper#gpu). CT2 4.6 uses CUDA 12/cuDNN 9; CPU remains default. Target-driver/GPU compatibility and measured throughput require deployment validation.

## Immutable model inventory / offline provisioning

| Model | Official repository | Immutable revision |
|---|---|---|
| EMA | [canberkkkkkk/ema-lightning](https://huggingface.co/canberkkkkkk/ema-lightning) | `7a6ba1ad216bb2f1da9863f80ac8770a6a807632` |
| Antalia Mini | [cloud0day3/antalia-mini](https://huggingface.co/cloud0day3/antalia-mini) | `8a79528770af2ed5cb6d3b9ac1248d370429f272` |
| Whisper small | [Systran/faster-whisper-small](https://huggingface.co/Systran/faster-whisper-small) | `536b0662742c02347bc0e980a01041f333bce120` |
| Whisper turbo | [deepdml/faster-whisper-large-v3-turbo-ct2](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2) | `4df90f75321148c3a29a9e2351b7ddf8f5b115a8` |

`src/voxi/providers/inventory.py` pins every selected Git blob identity or LFS SHA-256 from the immutable Hub tree APIs. Provisioner validates **before publishing** assets, writes SHA-256/byte-count manifests, keeps model cards and available LICENSE/NOTICE files, and executes no repository Python code. No training checkpoint, model code, or mutable branch downloads.

```sh
python scripts/provision_models.py --root models --models ema-lightning whisper-small
# Optional models are explicit:
python scripts/provision_models.py --root models --models antalia-mini whisper-large-v3-turbo
# Before air-gapping, verify without network:
python scripts/provision_models.py --root models --models ema-lightning whisper-small --verify-only
```

Runtime requires absolute `EMA_MODEL_PATH`, `ANTALIA_MODEL_PATH`, `WHISPER_MODEL_PATH` when launching outside Compose defaults `/models/<model-id>`. STT selected ID is `WHISPER_MODEL_ID=whisper-small|whisper-large-v3-turbo`; `STT_COMPUTE_TYPE=int8` CPU / `float16` CUDA, `STT_DEVICE=cpu|cuda`, `WHISPER_CPU_THREADS=4`. The default STT worker is `whisper-small`; a second worker may serve `whisper-large-v3-turbo` under `--profile stt-turbo`, and the gateway reaches it only when `STT_TURBO_URL=http://stt-whisper-turbo:8084` is set (empty by default, mirroring `ANTALIA_URL`). TTS selection `VOXI_TTS_PROVIDER=ema-lightning|antalia-mini`, `TTS_DEVICE=cpu|cuda`. `VOXI_WORKER_API_KEY` must contain at least 32 characters. EMA normalizer env: `TTS_NORMALIZATION_ENABLED=true`, `TTS_NORMALIZATION_OWNER=ema_integrated`, `TTS_NORMALIZATION_AMBIGUITY_POLICY=fallback`. Antalia owner/policy both `native`. `TTS_NORMALIZATION_CONTEXT_HINTS` must be unset/empty.

Native workers bind loopback by default: `uvicorn voxi.workers.tts:app --host 127.0.0.1 --port 8081`; `uvicorn voxi.workers.stt:app --host 127.0.0.1 --port 8082`. Antalia uses the TTS entrypoint in a separate process on port 8083. Container entrypoints bind inside the private Compose network, with no worker host ports published. Model directories can be read-only. EMA writes its measured batch-size cache under writable `XDG_CACHE_HOME`, not model root.

Limits: `VOXI_MAX_UPLOAD_BYTES=26214400`, `VOXI_MAX_AUDIO_SECONDS=600`, `VOXI_INFERENCE_CONCURRENCY=1`, `VOXI_INFERENCE_TIMEOUT_SECONDS=120`. Admission rejects immediately when full; timeout/cancel drops results but retains the native-work slot until the thread finishes. Codec work runs under the same gate. FFmpeg decoding uses an auto-cleaned, size-bounded seekable temporary upload so recorded M4A with end-of-file metadata works. Allowed demuxers are WAV, MP3, MOV/M4A, FLAC and OGG; playlists are excluded. Protocols are limited to local `file` and output `pipe`; MOV external tracks and absolute aliases retain audited default `false`, never user-configurable. Output stops at the duration limit plus one sample; subprocess deadline is 60 seconds. Filenames/extensions are untrusted. [FFmpeg format options](https://ffmpeg.org/ffmpeg-formats.html#mov_002fmp4_002f3gp).

## Acceptance boundaries

Provider tests inject deterministic engines only inside tests; production never substitutes fake inference. Codec tests exercise actual FFmpeg and consumer WAV parsing for WAV/PCM/MP3, malformed bytes, duration/size, and unsafe playlist references. Provider tests cover cancellation, bounded duration, failed readiness and unsupported policy rejection. Native normalization/pronunciation is validated only by real-provider smoke and future listening/corpus evaluation, not mock echoes. Real Turkish listening, normalization audio-quality comparisons, throughput, CPU/GPU timing and cancellation under load remain deployment gates.

`/v1/speak` and native WebSocket compatibility are explicitly deferred: the fork's distinct request/stream contract has not been adopted or tested. The gateway publishes only its own verified internal HTTP contracts plus Voxi-defined WebSocket transports (ADR 0005), whose framing, VAD and cancellation semantics are proven by deterministic contract tests, not by upstream clients. No SIP, telephone or OpenAI Realtime claim; realtime cancellation means chunk-boundary and generation-aware playout only, never a preempted native kernel.
