# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Shared model inventory and offline manifest verification."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from typing import Any

from voxi.providers.inventory import MODELS

EMA_REVISION = "7a6ba1ad216bb2f1da9863f80ac8770a6a807632"


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def verify_manifest(path: Path, model_id: str, revision: str) -> dict[str, Any]:
    root = path.resolve()
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("model") != model_id or manifest.get("revision") != revision:
        raise RuntimeError(f"Wrong pinned model manifest at {root}")
    expected_files = MODELS[model_id]["files"]
    entries = manifest.get("files", [])
    if {entry.get("name") for entry in entries} != set(expected_files) or len(entries) != len(
        expected_files
    ):
        raise RuntimeError("Model manifest must contain exactly the pinned inventory")
    for entry in manifest["files"]:
        local = root / entry["path"]
        # Hugging Face snapshots use symlinks to blobs, both inside model root.
        if not local.resolve().is_relative_to(root) or sha256_file(local) != entry["sha256"]:
            raise RuntimeError(f"Missing, outside-root or corrupt model asset: {entry['path']}")
        expected = expected_files[entry["name"]]
        if len(expected) == 64:
            actual = entry["sha256"]
        else:
            data = local.read_bytes()
            actual = hashlib.sha1(b"blob " + str(len(data)).encode() + b"\0" + data).hexdigest()
        if actual != expected or entry.get("upstream_object") != expected:
            raise RuntimeError(f"Model asset is not the pinned upstream object: {entry['name']}")
    return manifest


def configure_offline_hub(path: Path, repo_id: str, model_id: str, revision: str) -> None:
    verify_manifest(path, model_id, revision)
    cache = path.resolve() / "hub"
    ref = cache / ("models--" + repo_id.replace("/", "--")) / "refs" / "main"
    if ref.read_text(encoding="utf-8").strip() != revision:
        raise RuntimeError("Offline upstream main ref is not the provisioned immutable revision")
    # Workers are isolated processes. Set before importing Hugging Face/upstream engines.
    os.environ["HF_HUB_CACHE"] = str(cache)
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
