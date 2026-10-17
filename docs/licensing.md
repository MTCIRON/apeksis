# Licensing and release gates

This repository uses independent API adapters, not vendored upstream application source. See [upstream audit](upstream-audit.md) and [third-party notices](../THIRD_PARTY_NOTICES.md) for pinned package/model provenance and cited licenses.

EMA Lightning and normalizer-tr: Apache-2.0; Faster-Whisper: MIT; selected Antalia-2 Mini code/weights: Apache-2.0, with its own transitive notices including cmudict. Antalia 1 weights deliberately excluded. Neither third-party application code nor AGPL receptionist repositories are copied. No Hitabet source is incorporated.

Model provisioning must save immutable revisions and SHA256 artifact manifest plus upstream license/notice assets. Shipping model assets or images requires retaining these and auditing every transitive dependency, tokenizer, VAD asset, dataset/training notice and OS package. Package license claims do not establish permission for unrelated application code. **This repository's own code license was selected by its owner on 2026-10-17: `AGPL-3.0-or-later`** — see the section below and [`LICENSE`](../LICENSE).

Release gates: full image/model SBOM, pinned image digests, vulnerability scan, counsel/engineering license review and distribution notices. Development version pins and source metadata are not a completed release certification. FFmpeg distribution obligations depend on actual package build configuration; audit installed image package before redistribution.

## Code license (R3, 2026-10-17)

**Decision (copyright holder, 2026-10-17): the code in this repository is `AGPL-3.0-or-later`.**
Full text: [`LICENSE`](../LICENSE) — the canonical AGPL-3.0 text fetched from gnu.org (661 lines,
34 523 bytes, SHA-256 `0D96A4FF…`), not retyped. Contributions are accepted under the DCO
([`CONTRIBUTING.md`](../CONTRIBUTING.md)); source files carry an SPDX header.

### Dependency scan (evidence)

The scan read the **installed distributions' real metadata**, not `pyproject.toml` declarations.
Python was scanned *inside the built images*; the WebUI via `webui/package-lock.json`:

| Environment | Distributions | Copyleft found | Verdict |
|---|---|---|---|
| `voxi-gateway` | 22 | `certifi` MPL-2.0 | ✅ MPL-2.0 §3.3 secondary license → compatible |
| `voxi-tts` | 40 | `certifi` MPL-2.0, `tqdm` MPL-2.0 AND MIT | ✅ |
| `voxi-stt` | 43 | `certifi`, `tqdm` | ✅ |
| `voxi-antalia` | 47 | `certifi`, `tqdm`, **`cmudict` GPL-3.0-or-later** | ✅ **AGPL §13 + GPLv3 §13**: GPLv3 code may be combined with an AGPLv3 work; the combined work stays AGPL |
| WebUI (npm) | 240 packages | **none** — MIT 169, Apache-2.0 27, MPL-2.0 13, BSD-3 12, OFL-1.1 9, ISC 8, CC-BY-4.0 1, 0BSD 1 | ✅ |

**Key detail:** the `cmudict` PyPI package (prosegrinder/python-cmudict) *code* is
GPL-3.0-or-later, while the CMU *data* it bundles is BSD-2-Clause (`cmudict/data/LICENSE`).
`THIRD_PARTY_NOTICES.md` recorded only BSD-2-Clause; corrected.

**Why this choice is self-consistent:** dependencies like `cmudict` (GPLv3+) and `libsndfile`
(LGPL) would have forced the *whole project* to GPL had the code been MIT or Apache-2.0. Under
AGPL-3.0 the combination is expressly permitted and the combined work remains AGPL. There is no
AGPL-incompatible dependency; only copyleft dependencies that are AGPL-compatible.

**Honest limits:** (1) the scan reads *package metadata*, which can disagree with the real license
(cmudict is a live example of exactly that). (2) OS packages in the Docker base images (Debian),
FFmpeg's build configuration, and the `nginx`/`python` base images are outside this scan — a
`dpkg -l`-based SBOM is still required before redistribution. (3) `gitleaks`/`trivy` are not
installed; this is a dependency-license check, not an SBOM.

### AGPL §13 obligation (source over the network)

AGPL §13: anyone who **modifies** the software and offers it to users over a network must offer
those users the Corresponding Source. Consequences that matter here:

- An operator running this repository **unmodified** incurs no extra obligation beyond the
  distribution terms.
- Forks that modify it are expected to expose a source link in the UI. Adding a "Source code"
  entry to the WebUI is therefore part of R3, but its target URL only exists after publication
  (R7) — it is deliberately deferred rather than pointed at a placeholder.
- When a container image is distributed, the image tag should reference the source commit; the
  README states this.

## STT model audit (Plan 3 F0, 2026-10-16)

Audited before wiring either model into a server worker, so no redistribution decision rests on a
model-card summary alone. Evidence: the Hub API metadata plus the fetched `LICENSE`/`README` text at the
pinned revision.

| Model | Revision | Code and weights | Non-obvious terms | Verdict |
|---|---|---|---|---|
| `atasoglu/seda-v0.1` | `5cbbda1b34bde5e3004e79b137dc3871587ea282` | Zipformer2 transducer (66.1M), int8 ONNX; **Apache-2.0** | **`lm/` is CC BY-SA 4.0** (trained on Turkish Wikipedia) — ShareAlike; training data Common Voice (CC0) + ISSAI Turkish Speech Corpus (MIT on Hugging Face / CC BY 4.0 from ISSAI), attribution required | Acoustic model OK; **LM is a gate** |
| `KaanAydinli/Duyu-small` | `a9aa79751ea6e99c1e035fcb056318d5c1b67f13` | Conformer/CTC, tr+en, ONNX (fp32/int8/q4); **Apache-2.0**, with a full `LICENSE` file and an upstream `duyu_small/` Python runtime | none found in the card; training-data notices not stated upstream | OK, notices required |

**Seda language model:** `lm/rnnlm.int8.onnx` and `lm/2gram.fst` are CC BY-SA 4.0. Shipping them inside a
model image would pull ShareAlike into that artifact, so the plan is to **ship Seda without the LM**
(greedy or beam-4 decoding) and treat the LM as a separate, clearly labelled optional artifact with its
own notice. The measured cost is disclosed, not hidden: FLEURS-TR WER 14.24 (beam 4) to 11.52 (beam 4 +
LM), about 2.7 points, per the model card.

Neither model is shipped yet; F2/F3 stay gated on this record. When they land, `inventory.py` must pin
the revision and every file identity, and `THIRD_PARTY_NOTICES.md` must gain the entries plus the
dataset/attribution notices above. The WER figures on the cards are marked `verified: false` and are the
authors' own — claims, not our measurements.
