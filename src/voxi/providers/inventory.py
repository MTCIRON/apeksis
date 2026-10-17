# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Official Hugging Face immutable revisions and Git/LFS object identities."""

from typing import TypedDict


class ModelSpec(TypedDict):
    repo: str
    revision: str
    license: str
    files: dict[str, str]


MODELS: dict[str, ModelSpec] = {
    "ema-lightning": {
        "repo": "canberkkkkkk/ema-lightning",
        "revision": "7a6ba1ad216bb2f1da9863f80ac8770a6a807632",
        "license": "Apache-2.0",
        "files": {
            "README.md": "e91af0deab8a8f8b2c97bd44210d9497c016c684",
            "config.json": "a4f3b575eff6aa203c2142c6d3facaed48a82935",
            "decoder.pt": "9595819b173f411340f63d11332695121a97f8bf1f6d8b6fef0b21cf99c7ad67",
            "ema.pt": "95aec03dafbe0e1d69bca774ab597c779464729a14bc99bfcb52480090c7dfe6",
        },
    },
    "antalia-mini": {
        "repo": "cloud0day3/antalia-mini",
        "revision": "8a79528770af2ed5cb6d3b9ac1248d370429f272",
        "license": "Apache-2.0",
        "files": {
            "README.md": "0ec1a0497bee105061507935c78d788afa59f347",
            "LICENSE": "d645695673349e3947e8e5ae42332d0ac3164cd7",
            "NOTICE": "8a2d98e48516e19862dec1e7d434849b6a005bfd",
            "config.json": "1a8701824476cc9c60062361c22e083f6de4aa2d",
            "acoustic.safetensors": (
                "72c36a6855ce95dc1d35960a7b61515136813313406e5b9ae1c2ebe6cd2ad428"
            ),
            "vocoder.safetensors": (
                "89ca374cc55864b38a36f9ea87c41e1b17376e5d6d68e3a0458332861509bbf6"
            ),
        },
    },
    "whisper-small": {
        "repo": "Systran/faster-whisper-small",
        "revision": "536b0662742c02347bc0e980a01041f333bce120",
        "license": "MIT",
        "files": {
            "README.md": "16511f6106ead2fbc3a1480957a217c2661a5a98",
            "config.json": "e5047537059bd8f182d9ca64c470201585015187",
            "model.bin": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
            "tokenizer.json": "7818adb6de9fa3064d3ff81226fdd675be1f6344",
            "vocabulary.txt": "c9074644d9d1205686f16d411564729461324b75",
        },
    },
    "whisper-large-v3-turbo": {
        "repo": "deepdml/faster-whisper-large-v3-turbo-ct2",
        "revision": "4df90f75321148c3a29a9e2351b7ddf8f5b115a8",
        "license": "MIT",
        "files": {
            "README.md": "fb53844bcca20e84e58c86859351b0af33771b87",
            "config.json": "0351d1d6870005e865747b781b5d7c23ea0459cd",
            "model.bin": "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
            "preprocessor_config.json": "931c77a740890c46365c7ae0c9d350ba3cca908f",
            "tokenizer.json": "17456db595adc78a973f97d69d8cb50bc87c0b1c",
            "vocabulary.json": "0adcd01e7c237205d593b707e66dd5d7bc785d2d",
        },
    },
}

# F6 · Turkish punctuation source model. This asset is NOT a downloadable
# runtime artifact like the audio models: it is a PyTorch BERT that must be
# exported to ONNX + int8-quantised before the browser can load it, so it is
# consumed by `scripts/export_punctuation_onnx.py` rather than
# `provision_models.py`. The entry exists so the exact upstream revision and
# every source file identity are pinned and auditable; the exported ONNX
# artifacts get their own SHA-256 digests written into the deployment manifest
# at export time. Base model: dbmdz/bert-base-turkish-cased (also MIT).
PUNCTUATION_SOURCE: ModelSpec = {
    "repo": "uygarkurt/bert-restore-punctuation-turkish",
    "revision": "dd8b9481ed3b3c05110d7e041ecbeb6a1c23b8b0",
    "license": "MIT",
    "files": {
        "README.md": "22d62e89eff9f0b6aa12a9e06e346c32cb3ad8c9",
        "config.json": "0e6cf529c10e5f57fc2b4d3966e44422d5e61d3c",
        "pytorch_model.bin": (
            # Git-LFS file: pinned by content SHA-256, not the LFS-pointer git oid.
            "c44184c34c50a01bd8546c232bcb33152b378a4c0d8355d13ae8a66f53aa0c70"
        ),
        "special_tokens_map.json": "a8b3208c2884c4efb86e49300fdd3dc877220cdf",
        "tokenizer.json": "8422a99519bb9ddb34314a51b7361c12cd4362c0",
        "tokenizer_config.json": "b3db5a18e7a3a9c1b5e5a2c7afb7bb01b4917daf",
        "vocab.txt": "6779f120fb06b92396fddda4cffc63a3d01493e8",
    },
}
