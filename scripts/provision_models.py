# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Download only pinned data assets, verify their identities, then publish offline manifests."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

# Supports both installed images and running this script from the source checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from voxi.providers.inventory import MODELS  # noqa: E402


def identities(path: Path) -> tuple[str, str]:
    sha256 = hashlib.sha256()
    git = hashlib.sha1(b"blob " + str(path.stat().st_size).encode() + b"\0")
    with path.open("rb") as source:
        while block := source.read(1024 * 1024):
            sha256.update(block)
            git.update(block)
    return sha256.hexdigest(), git.hexdigest()


def verify(path: Path, expected: str) -> str:
    sha256, git = identities(path)
    if (sha256 if len(expected) == 64 else git) != expected:
        raise RuntimeError(f"Pinned asset digest mismatch: {path}")
    return sha256


def download(url: str, target: Path, expected: str) -> str:
    if target.exists():
        return verify(target, expected)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".partial")
    headers = {"User-Agent": "Voxi-model-provisioner/0.1"}
    # A gated Hugging Face repository needs a user access token. It is read from
    # the process environment at runtime only - never baked into an image,
    # never written to a file, never logged.
    token = os.environ.get("HF_TOKEN", "").strip()
    if token:
        headers["Authorization"] = f"Bearer {token}"
    try:
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=120) as source, temporary.open("wb") as output:
            while block := source.read(1024 * 1024):
                output.write(block)
        digest = verify(temporary, expected)
        temporary.replace(target)
        return digest
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"Hugging Face returned HTTP {exc.code} for {url}. "
            "HTTP 429/5xx usually means rate limiting or a transient outage: wait a few "
            "minutes and re-run the same provision service (files already downloaded are "
            "kept and re-verified, nothing starts over). HTTP 401/403 means the repository "
            "is gated: create a Hugging Face access token with read access to that repo "
            "and pass it as the HF_TOKEN environment variable. See docs/troubleshooting.md."
        ) from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(
            f"Cannot reach Hugging Face ({exc.reason}) for {url}. The first install needs "
            "internet access; later runs only verify the files already on the volume. "
            "Check DNS, a required corporate proxy, or re-run the provision service once "
            "the network is available. See docs/troubleshooting.md."
        ) from exc
    finally:
        temporary.unlink(missing_ok=True)


def provision(root: Path, model: str, verify_only: bool) -> None:
    spec = MODELS[model]
    directory = root / model
    repo, revision = spec["repo"], spec["revision"]
    snapshot = directory
    if model == "ema-lightning":
        # Official EMA constructor has no local path/revision option. Match HF's cache
        # layout without running downloaded code, using real files rather than symlinks.
        snapshot = (
            directory / "hub" / ("models--" + repo.replace("/", "--")) / "snapshots" / revision
        )
    entries = []
    for name, expected in spec["files"].items():
        local = snapshot / name
        digest = (
            verify(local, expected)
            if verify_only
            else download(
                f"https://huggingface.co/{repo}/resolve/{revision}/{name}", local, expected
            )
        )
        entries.append(
            {
                "name": name,
                "path": local.relative_to(directory).as_posix(),
                "sha256": digest,
                "upstream_object": expected,
                "bytes": local.stat().st_size,
            }
        )
    if model == "ema-lightning":
        ref = snapshot.parents[1] / "refs" / "main"
        if verify_only:
            if ref.read_text(encoding="utf-8").strip() != revision:
                raise RuntimeError("Offline EMA main ref mismatch")
        else:
            ref.parent.mkdir(parents=True, exist_ok=True)
            ref.write_text(revision, encoding="utf-8")
    manifest = {
        "schema_version": "1.0",
        "model": model,
        "repo": repo,
        "revision": revision,
        "license": spec["license"],
        "files": entries,
    }
    manifest_path = directory / "manifest.json"
    if verify_only:
        if json.loads(manifest_path.read_text(encoding="utf-8")) != manifest:
            raise RuntimeError(f"Manifest differs from pinned inventory: {model}")
    else:
        temporary = manifest_path.with_suffix(".partial")
        temporary.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, manifest_path)
    print(
        f"{model}: {revision}, {len(entries)} assets {'verified' if verify_only else 'provisioned'}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("models"))
    parser.add_argument(
        "--models", nargs="+", choices=tuple(MODELS), default=["ema-lightning", "whisper-small"]
    )
    parser.add_argument(
        "--verify-only",
        action="store_true",
        help="No network: verify immutable assets and manifests",
    )
    args = parser.parse_args()
    for model in dict.fromkeys(args.models):
        provision(args.root, model, args.verify_only)


if __name__ == "__main__":
    main()
