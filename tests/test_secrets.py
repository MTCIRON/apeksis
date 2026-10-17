# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Mustafa Tayyar Çalışkan

"""Secret resolution and first-run bootstrap contracts.

These lock in the promises the self-bootstrapping install makes: an explicit
environment value always wins, generated material is written once and never
overwritten, secret values never reach a log, and ``REQUIRE_PROVIDED_CERTS=1``
stays fail-closed.
"""

import hashlib
import importlib.util
import json
import os
import shutil
from pathlib import Path

import pytest

from voxi.secrets import read_secret

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "bootstrap_secrets.py"
SECRET_ENVS = ("VOXI_WORKER_API_KEY", "VOXI_API_KEY", "VOXI_API_KEYS_JSON", "VOXI_WEBUI_KEY")
requires_openssl = pytest.mark.skipif(
    shutil.which("openssl") is None, reason="openssl is not installed on this host"
)


def _load_bootstrap():
    spec = importlib.util.spec_from_file_location("bootstrap_secrets", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture()
def boot(tmp_path, monkeypatch):
    for name in (*SECRET_ENVS, "REQUIRE_PROVIDED_CERTS", "VOXI_TLS_SAN", "VOXI_PROXY_BIND_IP"):
        monkeypatch.delenv(name, raising=False)
    module = _load_bootstrap()
    monkeypatch.setattr(module, "SECRETS_DIR", tmp_path / "secrets")
    monkeypatch.setattr(module, "CERT_DIR", tmp_path / "certs")
    return module


# --- read_secret: environment wins, then the file ----------------------------


def test_read_secret_prefers_environment(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path))
    (tmp_path / "worker.key").write_text("file-value")
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "env-value")
    assert read_secret("VOXI_WORKER_API_KEY", "worker.key") == "env-value"


def test_read_secret_falls_back_to_file(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path))
    monkeypatch.delenv("VOXI_WORKER_API_KEY", raising=False)
    (tmp_path / "worker.key").write_text("file-value\n")
    assert read_secret("VOXI_WORKER_API_KEY", "worker.key") == "file-value"


def test_read_secret_honours_file_override(tmp_path, monkeypatch):
    target = tmp_path / "custom.key"
    target.write_text("custom-value")
    monkeypatch.delenv("VOXI_WORKER_API_KEY", raising=False)
    monkeypatch.setenv("VOXI_WORKER_API_KEY_FILE", str(target))
    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path / "missing"))
    assert read_secret("VOXI_WORKER_API_KEY", "worker.key") == "custom-value"


def test_read_secret_missing_is_empty_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path))
    monkeypatch.delenv("VOXI_WORKER_API_KEY", raising=False)
    assert read_secret("VOXI_WORKER_API_KEY", "worker.key") == ""


# --- bootstrap: idempotent, precedence-preserving, quiet ---------------------


def test_generates_once_and_second_run_changes_nothing(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    assert boot.main() == 0
    first = {path.name: path.read_text() for path in boot.SECRETS_DIR.iterdir()}
    assert set(first) == {"worker.key", "app.key", "webui.key", "api-keys.json"}
    assert boot.main() == 0
    second = {path.name: path.read_text() for path in boot.SECRETS_DIR.iterdir()}
    assert first == second, "a re-run must not rotate any secret"


def test_environment_value_prevents_generation(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "w" * 40)
    boot.main()
    assert not (boot.SECRETS_DIR / "worker.key").exists()
    assert (boot.SECRETS_DIR / "app.key").exists()


def test_placeholder_environment_value_is_treated_as_absent(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    monkeypatch.setenv("VOXI_WORKER_API_KEY", "change-me")
    boot.main()
    assert (boot.SECRETS_DIR / "worker.key").exists()


def test_existing_file_is_never_overwritten(boot):
    boot.ensure_dir(boot.SECRETS_DIR)
    keep = "keep-me-please-keep-me-please-keep-me"
    (boot.SECRETS_DIR / "worker.key").write_text(keep)
    assert boot.reconcile_secret("worker.key", "VOXI_WORKER_API_KEY", group_readable=True) == keep
    assert (boot.SECRETS_DIR / "worker.key").read_text() == keep


def test_environment_wins_over_a_stale_file_without_rewriting_it(boot, monkeypatch):
    boot.ensure_dir(boot.SECRETS_DIR)
    (boot.SECRETS_DIR / "webui.key").write_text("stale-file-value")
    monkeypatch.setenv("VOXI_WEBUI_KEY", "w" * 40)
    value = boot.reconcile_secret("webui.key", "VOXI_WEBUI_KEY", group_readable=False)
    assert value == "w" * 40, "the returned value must be what the reader will use"
    assert (boot.SECRETS_DIR / "webui.key").read_text() == "stale-file-value"


def test_keyring_hashes_the_key_the_proxy_will_actually_inject(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.ensure_dir(boot.SECRETS_DIR)
    (boot.SECRETS_DIR / "webui.key").write_text("stale-file-value")
    monkeypatch.setenv("VOXI_WEBUI_KEY", "w" * 40)
    boot.main()
    rows = json.loads((boot.SECRETS_DIR / "api-keys.json").read_text())
    assert rows[0]["sha256"] == hashlib.sha256(("w" * 40).encode()).hexdigest()


def test_keyring_record_matches_the_local_webui_key(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.main()
    rows = json.loads((boot.SECRETS_DIR / "api-keys.json").read_text())
    webui = (boot.SECRETS_DIR / "webui.key").read_text().strip()
    assert rows == [
        {
            "id": "webui-local",
            "sha256": hashlib.sha256(webui.encode()).hexdigest(),
            "scopes": ["audio:read", "audio:write", "realtime:connect"],
        }
    ]


def test_matching_keyring_is_left_byte_identical(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.main()
    path = boot.SECRETS_DIR / "api-keys.json"
    before = path.read_bytes()
    boot.main()
    assert path.read_bytes() == before, "a matching keyring must not be rewritten"


def test_refreshing_the_keyring_keeps_other_records(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.ensure_dir(boot.SECRETS_DIR)
    (boot.SECRETS_DIR / "api-keys.json").write_text(
        json.dumps(
            [
                {"id": "operator", "sha256": "a" * 64, "scopes": ["audio:read"]},
                {"id": "webui-local", "sha256": "b" * 64, "scopes": ["audio:read"]},
            ]
        )
    )
    monkeypatch.setenv("VOXI_WEBUI_KEY", "w" * 40)
    boot.main()
    rows = json.loads((boot.SECRETS_DIR / "api-keys.json").read_text())
    by_id = {row["id"]: row["sha256"] for row in rows}
    assert by_id["operator"] == "a" * 64, "an operator record must survive the refresh"
    assert by_id["webui-local"] == hashlib.sha256(("w" * 40).encode()).hexdigest()


def test_secret_values_never_reach_the_log(boot, monkeypatch, capsys):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.main()
    captured = capsys.readouterr()
    for path in boot.SECRETS_DIR.iterdir():
        value = path.read_text().strip()
        if value and not value.startswith("["):
            assert value not in captured.out
            assert value not in captured.err


@pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")
def test_generated_files_are_not_world_readable(boot, monkeypatch):
    monkeypatch.setattr(boot, "ensure_cert", lambda: None)
    boot.main()
    for name in ("worker.key", "app.key", "webui.key"):
        assert (boot.SECRETS_DIR / name).stat().st_mode & 0o007 == 0


# --- TLS material ------------------------------------------------------------


def test_sans_default_to_loopback_only(boot):
    assert boot.san_list() == ["DNS:localhost", "IP:127.0.0.1", "IP:::1"]


def test_sans_add_the_lan_bind_and_configured_names(boot, monkeypatch):
    monkeypatch.setenv("VOXI_PROXY_BIND_IP", "192.168.1.50")
    monkeypatch.setenv("VOXI_TLS_SAN", "voxi.lan, IP:10.0.0.7")
    assert boot.san_list() == [
        "DNS:localhost",
        "IP:127.0.0.1",
        "IP:::1",
        "IP:192.168.1.50",
        "DNS:voxi.lan",
        "IP:10.0.0.7",
    ]


def test_sans_treat_a_bare_ipv4_entry_as_an_ip(boot, monkeypatch):
    monkeypatch.setenv("VOXI_TLS_SAN", "192.168.1.60")
    assert boot.san_list() == ["DNS:localhost", "IP:127.0.0.1", "IP:::1", "IP:192.168.1.60"]


@requires_openssl
def test_generates_certificate_and_marks_it(boot):
    boot.ensure_cert()
    assert (boot.CERT_DIR / "voxi.crt").is_file()
    assert (boot.CERT_DIR / "voxi.key").is_file()
    assert (boot.CERT_DIR / boot.GENERATED_MARKER).is_file()


@requires_openssl
def test_second_run_keeps_the_same_certificate(boot):
    boot.ensure_cert()
    before = (boot.CERT_DIR / "voxi.crt").read_bytes()
    boot.ensure_cert()
    assert (boot.CERT_DIR / "voxi.crt").read_bytes() == before


def test_strict_mode_refuses_when_no_certificate_exists(boot, monkeypatch):
    monkeypatch.setenv("REQUIRE_PROVIDED_CERTS", "1")
    with pytest.raises(SystemExit) as excinfo:
        boot.ensure_cert()
    assert excinfo.value.code == 1
    assert not (boot.CERT_DIR / "voxi.crt").exists()


@requires_openssl
def test_strict_mode_refuses_a_generated_certificate(boot, monkeypatch):
    boot.ensure_cert()
    monkeypatch.setenv("REQUIRE_PROVIDED_CERTS", "1")
    with pytest.raises(SystemExit) as excinfo:
        boot.ensure_cert()
    assert excinfo.value.code == 1


def test_strict_mode_accepts_a_provided_certificate(boot, monkeypatch):
    boot.ensure_dir(boot.CERT_DIR)
    (boot.CERT_DIR / "voxi.crt").write_text("provided")
    (boot.CERT_DIR / "voxi.key").write_text("provided")
    monkeypatch.setenv("REQUIRE_PROVIDED_CERTS", "1")
    boot.ensure_cert()
    assert (boot.CERT_DIR / "voxi.crt").read_text() == "provided"


def test_partial_tls_material_refuses_instead_of_overwriting(boot):
    boot.ensure_dir(boot.CERT_DIR)
    (boot.CERT_DIR / "voxi.crt").write_text("half a pair")
    with pytest.raises(SystemExit) as excinfo:
        boot.ensure_cert()
    assert excinfo.value.code == 1
    assert (boot.CERT_DIR / "voxi.crt").read_text() == "half a pair"


# --- the readers really use the file ----------------------------------------


def test_gateway_settings_read_the_worker_key_file(tmp_path, monkeypatch):
    from voxi.gateway import Settings

    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path))
    monkeypatch.delenv("VOXI_WORKER_API_KEY", raising=False)
    (tmp_path / "worker.key").write_text("k" * 40)
    assert Settings.from_env().worker_key == "k" * 40


def test_worker_startup_guard_reads_the_worker_key_file(tmp_path, monkeypatch):
    from voxi.workers.common import require_worker_key

    monkeypatch.setenv("VOXI_SECRETS_DIR", str(tmp_path))
    monkeypatch.delenv("VOXI_WORKER_API_KEY", raising=False)
    with pytest.raises(RuntimeError):
        require_worker_key()
    (tmp_path / "worker.key").write_text("k" * 40)
    require_worker_key()
