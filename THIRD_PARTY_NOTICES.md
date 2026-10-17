# Third-party notices

This project wraps independently installed upstream packages; it does not relicense their code, model weights, tokenizers or dictionaries. Preserve this file, installed distributions' LICENSE/NOTICE files, model manifests/cards, and provisioned model LICENSE/NOTICE files when distributing containers or offline bundles. Package licenses remain in Python `site-packages/*.dist-info/` and in `webui/node_modules/*/LICENSE`; do not strip them. Exact dependency hashes: `uv.lock` and `webui/package-lock.json`. Exact model object hashes: `src/voxi/providers/inventory.py` and generated model manifests. This list is not a substitute for a release SBOM and full transitive/container license review.

This project's own code is **AGPL-3.0-or-later** (see [`LICENSE`](LICENSE)). It ships inside image
builds, so bundled font binaries are distributed rather than merely referenced — see the WebUI
section below.

## WebUI (npm) dependencies

The WebUI bundle is built from `webui/package-lock.json` (240 packages). A scan of that lockfile
found **no copyleft license**: MIT 169, Apache-2.0 27, MPL-2.0 13, BSD-3-Clause 12, OFL-1.1 9,
ISC 8, CC-BY-4.0 1, 0BSD 1. Two categories need attribution because their output is shipped:

| Package | License | Attribution / note |
|---|---|---|
| `@fontsource*` font binaries: Google Sans Flex, Inter, Literata, Montserrat, Schibsted Grotesk, Anton, Bangers, Bebas Neue, Poppins | **OFL-1.1** | Each font's own copyright holder and the full OFL text are bundled inside its `@fontsource/*` package (`LICENSE`). Retain those files when redistributing the built WebUI. The OFL permits bundling; **Reserved Font Names must not be used for modified versions** |
| `mediabunny` | **MPL-2.0** | File-level weak copyleft. Unmodified use is permitted; if you modify its files, publish those files' source. Its `LICENSE` stays in `node_modules` and in the lockfile record |

Development-only packages (`caniuse-lite` CC-BY-4.0, `lightningcss*` MPL-2.0) are **not** part of
the built WebUI output and impose no distribution obligation on the shipped bundle.

## Speech code and models

| Project / selected asset | Attribution | License / source |
|---|---|---|
| EMA Lightning 1.1.2 and selected model revision | Canberk Aslan | Apache-2.0; [official repository](https://github.com/canberk7/ema-lightning), [model](https://huggingface.co/canberkkkkkk/ema-lightning/tree/7a6ba1ad216bb2f1da9863f80ac8770a6a807632) |
| normalizer-tr 0.7.0 | Erdem Tuna | Apache-2.0; [official repository](https://github.com/erdemtuna/normalizer-tr) |
| Antalia-2 Mini 1.0.1, native text normalizer, selected weights | Copyright 2026 PatientDesk AI | Apache-2.0; [PyPI](https://pypi.org/project/antalia-mini/1.0.1/), [pinned LICENSE](https://huggingface.co/cloud0day3/antalia-mini/blob/8a79528770af2ed5cb6d3b9ac1248d370429f272/LICENSE) |
| Faster-Whisper 1.2.1 | Copyright (c) 2023 SYSTRAN | MIT; [official repository](https://github.com/SYSTRAN/faster-whisper/tree/v1.2.1) |
| Whisper small CTranslate2 weights | OpenAI Whisper, SYSTRAN conversion | MIT model card; [pinned model](https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120) |
| Optional Whisper large-v3-turbo CTranslate2 weights | OpenAI Whisper, deepdml conversion | MIT model card; [pinned model](https://huggingface.co/deepdml/faster-whisper-large-v3-turbo-ct2/tree/4df90f75321148c3a29a9e2351b7ddf8f5b115a8) |
| Silero VAD v6 bundled with Faster-Whisper | Silero Team | MIT; [upstream](https://github.com/snakers4/silero-vad); retain bundled package license |
| CMU Pronouncing Dictionary (cmudict 1.0.32, `prosegrinder/python-cmudict`) | Carnegie Mellon University (data); the python-cmudict authors (wrapper) | **Two licenses, both retained in the wheel:** the bundled *data* (`cmudict/data/LICENSE`) is BSD-2-Clause, while the *wrapper code* metadata declares **GPL-3.0-or-later**. Either way this is compatible with the project's AGPL-3.0-or-later (AGPL §13 / GPLv3 §13 expressly permit combining GPLv3 code with an AGPLv3 work). Used by the Antalia normalizer as an installed dependency, not copied into Voxi source |
| Turkish punctuation BERT (`uygarkurt/bert-restore-punctuation-turkish`, revision `dd8b9481…`), exported to ONNX + int8 by `scripts/export_punctuation_onnx.py` | Uygar Kurt; base `dbmdz/bert-base-turkish-cased` (DBMDZ) | MIT; [model card](https://huggingface.co/uygarkurt/bert-restore-punctuation-turkish), [base model](https://huggingface.co/dbmdz/bert-base-turkish-cased). Served read-only from the Voxi host under `/models/punctuation-tr/`; no runtime Hugging Face request |
| Transformers.js 3.8.1 + ONNX Runtime Web (WebGPU/WASM) | Hugging Face / Microsoft ONNX Runtime | Apache-2.0; [transformers.js](https://github.com/huggingface/transformers.js), [onnxruntime-web](https://github.com/microsoft/onnxruntime). Bundled into the WebUI; browser inference only |

Antalia **1** / OpenRAIL-M weights are not selected, provisioned or installed. No Hitabet source, AGPL receptionist project source, or EMA API fork source was copied.

**Correction (2026-10-17).** An earlier version of this file stated that no third-party application code was copied. **That was wrong.** A line-level comparison of `webui/src` against the reference application found 68 of 126 source files byte-identical and a further 25 substantially overlapping - the WebUI is a genuine derived work. It is **not** listed here as a third party: it is the project copyright holder's **own earlier application**, published under MIT, and the derivative is licensed `AGPL-3.0-or-later` as a whole (see [WebUI provenance](#webui-provenance)).

## WebUI provenance

The Apeksis WebUI (`webui/src`) derives from the **project copyright holder's own earlier
application**, which was published under the MIT license. Because the same person holds the
copyright of both, the derivative is licensed `AGPL-3.0-or-later` as a whole and **no separate MIT
notice is required here**. **Ownership reconfirmation (2026-10-17):** the project's owner and
developer is Mustafa Tayyar Çalışkan, and the author name recorded in the earlier application's
MIT `LICENSE` is erroneous per the owner's statement — it identifies no third party and is not
used as an attribution target anywhere in this repository. The measurement below is kept as an
honest record of the derivation, not as an attribution obligation (comments stripped, whitespace
normalised, lines compared as a set):

| Measure | Result |
|---|---|
| Files compared (`webui/src` vs the earlier application's `src`) | 126 |
| **Byte-identical line sequence** | **68** (`captions/renderer.ts`, `captions/style.ts`, `components/Select.tsx`, `components/Timeline.tsx`, `components/Viewer.tsx`, `engine/*.ts`, `duyu/*.ts`, …) |
| ≥ 75 % overlap | 18 (`studio/App.tsx` 0.824, `worker/asr.worker.ts` 0.979, `shell/icons.tsx` 0.862, …) |
| 40–75 % overlap | 7 (`lib/useTranscriber.ts` 0.707, `components/DubPanel.tsx` 0.637, …) |
| `styles.css` | rule sequence identical after comment stripping (Jaccard 1.000) |
| `index.css` | Jaccard 0.956 |

The earlier application is **not committed** (it was a local reference only), so it does not travel with this distribution. Apeksis-specific work — the server provider seam, `api/client.ts`, `shell/app-shell.tsx`, `SessionBar.tsx`, `serverLive.ts`, `serverTts.ts`, `importVoxiProjects.ts`, the provider settings — has no counterpart in it.

**License effect:** every file in `webui/src` carries the single identifier `AGPL-3.0-or-later`; no dual MIT identifier is used. The MIT grant on the earlier application itself is unaffected — third parties keep whatever rights were granted to them for that project.

Decision record (including the earlier "third-party" reading and its withdrawal once ownership was confirmed): `docs/plan-3-server-first.md` §8.5.5.

## Antalia package NOTICE (verbatim)

```text
Antalia-2 Mini
Copyright 2026 PatientDesk AI

The code, the text normaliser and the model weights are licensed under the Apache License,
Version 2.0 (see LICENSE).

This package includes PatientDesk AI's Turkish text normaliser (antalia_mini/text/normalize.py,
antalia_mini/text/foreign.py, antalia_mini/text/data/lexicon.json, antalia_mini/text/data/tr_vocab.json),
released under the same licence. Vendored verbatim from turkish-tts commit 3ed2e60 (2026-10-07).

At run time the normaliser uses the CMU Pronouncing Dictionary through the `cmudict` package
(Copyright Carnegie Mellon University, BSD 2-Clause licence); it is a dependency, not included here.

The model weights were trained on synthetic speech generated with VoxCPM2 (OpenBMB, Apache-2.0).

The model reimplements published methods: monotonic alignment search (Glow-TTS, Kim et al. 2020;
Matcha-TTS, Mehta et al. 2024), flow matching (Lipman et al. 2023), shortcut models (Frans et al. 2024),
adaLN-single (PixArt-alpha, Chen et al. 2023), ConvNeXt (Liu et al. 2022), Vocos (Siuzdak 2023),
HiFi-GAN's multi-period discriminator (Kong et al. 2020), UnivNet's multi-resolution discriminator
(Jang et al. 2021), RoPE (Su et al. 2021), SwiGLU (Shazeer 2020). No code from those projects is included.
```

Source: `antalia_mini-1.0.1.dist-info/licenses/NOTICE` from the official wheel with SHA-256 `0dd5cd76645f46443cccda2575ce5ba854c62e464702d436c06152852d975644`. The selected model repository NOTICE is separately retained by provisioning.

## Faster-Whisper MIT license (verbatim)

```text
MIT License

Copyright (c) 2023 SYSTRAN

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Apache-2.0 license access

Full Apache License Version 2.0 is retained in installed EMA/normalizer/Antalia distributions and in the provisioned Antalia model LICENSE. Canonical text: <https://www.apache.org/licenses/LICENSE-2.0>. Keep those full license texts with any redistribution; attributions alone are not sufficient.

## Runtime and container dependencies

PyTorch 2.7.0 (BSD-style), CTranslate2 4.6.0 (MIT), Hugging Face Hub 0.30.2 (Apache-2.0), safetensors 0.5.3 (Apache-2.0), tokenizers 0.21.1 (Apache-2.0), ONNX Runtime 1.22.0 (MIT), NumPy 2.2.5 (BSD-3-Clause), SoundFile 0.13.1 (BSD-style) / libsndfile (LGPL), and PyAV 16.0.1 (BSD-style) / bundled FFmpeg libraries retain their own notices and terms. The HTTP/ASGI serving stack (FastAPI, Uvicorn, Pydantic, httpx, python-multipart, prometheus-client) and **websockets 15.0.1** (Copyright (c) Aymeric Augustin and contributors, BSD-3-Clause) are pinned runtime dependencies; websockets is required because Uvicorn has no built-in WebSocket protocol, so without it every streaming route is refused even though in-process `TestClient` tests still pass. Each retains the `LICENSE` in its own `.dist-info`; inspect those exact files rather than this summary. System FFmpeg licensing depends on its enabled codecs and distribution build (LGPL/GPL components); Docker installs Debian's package and retains Debian `/usr/share/doc` notices. MP3 uses the actual `libmp3lame` encoder, not renamed WAV data. CUDA/cuDNN and NVIDIA libraries have separate proprietary distribution terms and are optional rather than CPU requirements. Before external distribution, generate SBOM and inspect exact selected wheels/container packages, including n8n and every transitive dependency; no blanket permissive-license claim is made.
