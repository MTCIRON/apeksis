# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""F6 · Reproducible, offline ONNX export + int8 quantisation for the Turkish
punctuation model, and the source of the deployment ``manifest.json`` the
browser engine verifies before it will load anything.

Why a dedicated script (and not ``provision_models.py``): the audio models are
already in a runtime-consumable format, so they are only *downloaded and
digest-checked*. The punctuation asset ships as a PyTorch BERT; ONNX Runtime Web
cannot load that. This tool pulls the pinned source revision, freezes it to
ONNX, dynamically int8-quantises it, and publishes the two artifacts plus a
manifest carrying each file's SHA-256 and byte size.

The command is offline-repeatable: once the source is cached, reruns produce
byte-identical ONNX (ONNX opset + ONNX Runtime quantiser are deterministic for
this architecture) and refresh the manifest digests.

Privacy guarantee at runtime: the browser NEVER contacts Hugging Face. It only
reads the ``punctuation-tr`` directory this script writes, which the nginx proxy
serves from the same Voxi host. Nothing here is invoked by the gateway startup;
running it is a separate, operator-initiated provisioning step.

    uv --python .venv-export run python scripts/export_punctuation_onnx.py \
        --root models --verify-only          # audit the pinned source, no network

    uv --python .venv-export run python scripts/export_punctuation_onnx.py \
        --root models                        # pull, export fp32 + int8, write manifest
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

# Allow running from a source checkout without the package installed.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from voxi.providers.inventory import PUNCTUATION_SOURCE  # noqa: E402

# Files the browser engine requires to be present in the manifest for the asset
# to be considered complete. Matches transformersEngine.ts REQUIRED_FILES.
SERVED_FILES = ["config.json", "tokenizer.json", "onnx/model_quantized.onnx"]

# A handful of unpunctuated Turkish sentences used to compare FP32 vs int8 label
# agreement. These are quality probes only — they never substitute for the model.
QUALITY_PROBES = [
    "bugün hava çok güzel ama yarın yağmur yağacak",
    "toplantı saat kaçta başlıyor",
    "istanbul'a yarın gidiyorum sonra ankara'ya geçeceğim",
    "lütfen bunu tekrar eder misin",
    "proje tamamlandı ve teslim edildi",
]


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def blob_sha1_of(path: Path) -> str:
    """Git blob hash (sha1 of ``blob <size>\\0<content>``) to match the pin."""
    git = hashlib.sha1(b"blob " + str(path.stat().st_size).encode() + b"\0")
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            git.update(block)
    return git.hexdigest()


def match_digest(path: Path, expected: str) -> bool:
    """A 64-hex pin is matched on content SHA-256 (Git-LFS blobs); a 40-hex pin
    is matched on the git blob SHA-1 (plain tracked files)."""
    found = sha256_of(path) if len(expected) == 64 else blob_sha1_of(path)
    return found == expected


def pull_source(source_dir: Path, verify_only: bool) -> None:
    """Fetch (or audit) the pinned PyTorch source into ``source_dir``."""
    source_dir.mkdir(parents=True, exist_ok=True)
    repo, revision = PUNCTUATION_SOURCE["repo"], PUNCTUATION_SOURCE["revision"]
    if verify_only:
        for name, expected in PUNCTUATION_SOURCE["files"].items():
            local = source_dir / name
            if not local.exists():
                raise RuntimeError(f"punctuation source file missing: {local}")
            if not match_digest(local, expected):
                raise RuntimeError(f"punctuation source digest mismatch: {local}")
        return
    from huggingface_hub import snapshot_download  # export venv only

    snapshot_download(
        repo_id=repo,
        revision=revision,
        local_dir=str(source_dir),
        allow_patterns=[*PUNCTUATION_SOURCE["files"].keys()],
    )
    for name, expected in PUNCTUATION_SOURCE["files"].items():
        local = source_dir / name
        if not match_digest(local, expected):
            raise RuntimeError(f"punctuation source digest mismatch: {local}")


def export_onnx(source_dir: Path, onnx_dir: Path) -> None:
    """Freeze the BERT to a unbatched, dynamic-axis ONNX graph (FP32)."""
    from optimum.exporters.onnx import main_export  # export venv only

    onnx_dir.mkdir(parents=True, exist_ok=True)
    if (onnx_dir / "model.onnx").exists():
        # Idempotent: reuse the frozen FP32 graph on re-runs (deterministic for
        # this architecture). Delete onnx/model.onnx to force a rebuild.
        return
    # main_export writes model.onnx + tokenizer/config alongside into `--task`
    # subfolders; we ask for the token-classification task and a fixed opset.
    main_export(
        model_name_or_path=str(source_dir),
        output=str(onnx_dir),
        task="token-classification",
        opset=17,
        no_dynamic_quant=True,
        fp16=False,
    )


def quantize_int8(onnx_dir: Path) -> Path:
    """Dynamic int8 quantisation of model.onnx -> model_quantized.onnx."""
    from optimum.onnxruntime import ORTQuantizer  # export venv only
    from optimum.onnxruntime.configuration import AutoQuantizationConfig  # noqa: E501

    model_path = onnx_dir / "model.onnx"
    if not model_path.exists():
        # optimum may nest under a task folder; locate the exported graph.
        candidates = sorted(onnx_dir.rglob("model.onnx"))
        if not candidates:
            raise RuntimeError("exported model.onnx not found under the output dir")
        model_path = candidates[0]
    qconfig = AutoQuantizationConfig.avx2(is_static=False, per_channel=True)
    quantizer = ORTQuantizer.from_pretrained(str(model_path.parent), file_name=model_path.name)
    quantizer.quantize(
        quantization_config=qconfig,
        save_dir=str(model_path.parent),
        file_suffix="quantized",
    )
    target = model_path.parent / "model_quantized.onnx"
    if not target.exists():
        # optimum derives the name from the source stem; locate whatever it wrote.
        produced = sorted(model_path.parent.glob("*quantized*.onnx"))
        if not produced:
            raise RuntimeError("int8 quantisation produced no ONNX file")
        produced[0].replace(target)
    return target


def measure_quality(source_dir: Path, onnx_dir: Path, quantized: Path) -> dict[str, object]:
    """Compare FP32 vs int8 predicted labels on the Turkish probes AND report a
    human-readable restored sentence per probe. Never assumes int8 == FP32."""
    import json as _json

    import numpy as np  # export venv only
    import onnxruntime as ort
    from transformers import AutoTokenizer

    tokenizer = AutoTokenizer.from_pretrained(str(source_dir))
    config = _json.loads((source_dir / "config.json").read_text())
    id2label = {int(k): v for k, v in config.get("id2label", {}).items()}
    mark = {"O": "", "PERIOD": ".", "COMMA": ",", "QUESTION": "?", "QUESTION_MARK": "?"}

    def label_ids(model_file: Path) -> list[list[int]]:
        session = ort.InferenceSession(str(model_file), providers=["CPUExecutionProvider"])
        result = []
        for sentence in QUALITY_PROBES:
            enc = tokenizer(sentence, return_offsets_mapping=True, return_tensors="pt")
            feed = {k: v.numpy() for k, v in enc.items() if k != "offset_mapping"}
            logits = session.run(None, feed)[0]
            result.append([int(i) for i in np.argmax(logits, axis=-1)[0]])
        return result

    def restore(sentence: str, ids_row: list[int]) -> str:
        enc = tokenizer(sentence, return_offsets_mapping=True)
        offs = enc["offset_mapping"]
        # Map each word-end character position to the mark the model predicted.
        inserts: dict[int, str] = {}
        for t, (start, end) in enumerate(offs):
            if end <= start:
                continue
            nxt = next(((s2, e2) for s2, e2 in offs[t + 1:] if e2 > s2), None)
            is_word_end = nxt is None or nxt[0] > end
            label = id2label.get(ids_row[t], "O") if t < len(ids_row) else "O"
            m = mark.get(label, "")
            if is_word_end and m:
                inserts[end] = m
        out: list[str] = []
        for idx, ch in enumerate(sentence):
            out.append(ch)
            if idx + 1 in inserts:
                out.append(inserts[idx + 1])
        return "".join(out).strip()

    fp32_rows = label_ids(onnx_dir / "model.onnx") if (onnx_dir / "model.onnx").exists() else []
    int8_rows = label_ids(quantized)
    total = sum(len(row) for row in int8_rows)
    agree = sum(
        1
        for i, row in enumerate(int8_rows)
        for j, val in enumerate(row)
        if not fp32_rows or (j < len(fp32_rows[i]) and fp32_rows[i][j] == val)
    )
    examples = []
    for i, sentence in enumerate(QUALITY_PROBES):
        examples.append({"input": sentence, "restored_int8": restore(sentence, int8_rows[i])})
    return {
        "probes": len(QUALITY_PROBES),
        "tokens_compared": total,
        "int8_matches_fp32": agree,
        "agreement_ratio": round(agree / total, 4) if total else None,
        "examples": examples,
    }


def build_manifest(output_dir: Path, repo: str, revision: str, license_: str) -> None:
    entries = []
    served = list(SERVED_FILES)
    if (output_dir / "onnx/model.onnx").exists():
        served.append("onnx/model.onnx")
    for name in served:
        path = output_dir / name
        if not path.exists():
            raise RuntimeError(f"expected served artifact missing: {path}")
        entries.append(
            {
                "name": name,
                "path": name,
                "sha256": sha256_of(path),
                "bytes": path.stat().st_size,
            }
        )
    manifest = {
        "schema_version": "1.0",
        "model": "punctuation-tr",
        "repo": repo,
        "revision": revision,
        "license": license_,
        "source": {"repo": repo, "revision": revision},
        "files": entries,
    }
    manifest_path = output_dir / "manifest.json"
    temporary = manifest_path.with_suffix(".partial")
    temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    os.replace(temporary, manifest_path)
    print(json.dumps({f["name"]: f["bytes"] for f in entries}, indent=2))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("models"))
    parser.add_argument("--verify-only", action="store_true",
                        help="No network/export: audit the pinned source digests")
    parser.add_argument("--skip-quality", action="store_true",
                        help="Do not run the FP32-vs-int8 probe comparison")
    args = parser.parse_args()

    source_dir = args.root / "punctuation-tr-src"
    output_dir = args.root / "punctuation-tr"
    onnx_dir = output_dir / "onnx"

    pull_source(source_dir, args.verify_only)
    if args.verify_only:
        print("punctuation-tr: pinned source verified against inventory")
        return

    export_onnx(source_dir, onnx_dir)
    quantized = quantize_int8(onnx_dir)
    # The tokenizer/config that main_export produced next to model.onnx must sit
    # at the served root (transformers.js resolves `<dir>/tokenizer.json`).
    for name in ("config.json", "tokenizer.json"):
        produced = next(onnx_dir.rglob(name), None)
        if produced is None:
            raise RuntimeError(f"export did not produce {name}")
        (output_dir / name).write_bytes(produced.read_bytes())

    quality: dict[str, object] = {}
    if not args.skip_quality:
        quality = measure_quality(source_dir, onnx_dir, quantized)
        (output_dir / "quality.json").write_text(json.dumps(quality, indent=2) + "\n",
                                                  encoding="utf-8")
        print("quality:", json.dumps(quality))

    build_manifest(output_dir, PUNCTUATION_SOURCE["repo"], PUNCTUATION_SOURCE["revision"],
                   PUNCTUATION_SOURCE["license"])
    print(f"punctuation-tr: exported + int8-quantised into {output_dir}")


if __name__ == "__main__":
    main()
