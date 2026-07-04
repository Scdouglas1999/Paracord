#!/usr/bin/env python3
"""Release-binary zero-config first-run smoke test.

Proves that a fresh `paracord-server` boots with NO hand-written config and NO
`livekit-server` binary on PATH, generates its config file, prints the friendly
first-run summary (share URL, "first account becomes owner/admin", native voice
status), and promotes only the FIRST registered account to admin/owner.

This guards the "native-default + one-click first run" product goals against
regressions. It is network-free and CI-safe: everything runs against a temp
SQLite database in a throwaway directory on loopback.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import requests

# Reuse the exact helpers the other release_*_smoke scripts use so this stays in
# lockstep with them (server path resolution, health polling, HTTP+assert).
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_product_smoke import (  # noqa: E402
    release_server_path,
    request_json,
    wait_for_health,
)


ROOT = Path(__file__).resolve().parents[1]

# paracord-core::USER_FLAG_ADMIN (1 << 0). The register response exposes the raw
# user `flags` bitfield; the admin bit is how the server marks the owner.
USER_FLAG_ADMIN = 1 << 0


def sanitized_path_without_livekit() -> str:
    """Return a PATH with every directory that contains a `livekit-server`
    binary removed, so the "no LiveKit binary on PATH" precondition holds
    deterministically regardless of what the host has installed."""
    exe = "livekit-server.exe" if os.name == "nt" else "livekit-server"
    kept: list[str] = []
    for entry in os.environ.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        candidate = Path(entry) / exe
        if candidate.exists():
            continue
        kept.append(entry)
    return os.pathsep.join(kept)


def wait_for_log_contains(log_path: Path, needle: str, *, timeout_seconds: float = 15.0) -> str:
    """Poll a growing log file until it contains `needle`, returning the text."""
    deadline = time.time() + timeout_seconds
    text = ""
    while time.time() < deadline:
        if log_path.exists():
            text = log_path.read_text(encoding="utf-8", errors="replace")
            if needle in text:
                return text
        time.sleep(0.25)
    raise AssertionError(
        f"timed out waiting for {needle!r} in startup log; last 2000 bytes:\n{text[-2000:]}"
    )


def assert_no_missing_livekit_complaint(log_text: str) -> None:
    """Fail if the server logged an error/warning about a missing LiveKit
    binary. Under the native-QUIC default the server must never touch LiveKit,
    so any "not found / not available" complaint is a regression."""
    offenders: list[str] = []
    for line in log_text.splitlines():
        low = line.lower()
        if "livekit" not in low:
            continue
        if "not found" in low or "not available" in low:
            offenders.append(line)
        elif "WARN" in line or "ERROR" in line:
            offenders.append(line)
    if offenders:
        joined = "\n".join(offenders)
        raise AssertionError(f"unexpected LiveKit-missing complaint(s) in startup log:\n{joined}")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    import tempfile

    with tempfile.TemporaryDirectory(prefix="paracord-zero-config-smoke-") as temp_dir:
        data = Path(temp_dir)
        # An empty config directory whose toml does NOT exist yet: the server
        # must generate it on first run.
        config_dir = data / "config"
        config_dir.mkdir()
        config_toml = config_dir / "paracord.toml"
        if config_toml.exists():
            raise AssertionError("config toml should not exist before first run")

        log_path = data / "server.log"
        base_url = f"http://127.0.0.1:{args.port}"

        child_path = sanitized_path_without_livekit()
        if shutil.which("livekit-server", path=child_path) is not None:
            raise AssertionError("failed to scrub livekit-server from child PATH")

        env = os.environ.copy()
        # Deliberately DO NOT set PARACORD_JWT_SECRET (proves the generated
        # config's random secret is used) or PARACORD_VOICE_NATIVE_MEDIA (proves
        # native voice is the default). Only CI-isolation knobs are set: temp
        # paths, loopback bind, and a relocated media UDP port so parallel runs
        # never collide on the default 8443.
        env.update(
            {
                "PATH": child_path,
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_VOICE_PORT": str(args.port + 1000),
                "RUST_LOG": "info",
            }
        )

        with log_path.open("w", encoding="utf-8") as log_file:
            proc = subprocess.Popen(
                [str(server), "-c", str(config_toml)],
                cwd=str(ROOT),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                # (d) the server answers a basic route once healthy.
                wait_for_health(base_url, proc)

                # (a) first run generated the config file on disk.
                if not config_toml.exists():
                    raise AssertionError(f"server did not generate config at {config_toml}")

                # (b) the friendly first-run summary is present. The banner is
                # printed during startup (before serve), so it is already in the
                # log by the time health is up; poll briefly for robustness.
                log_text = wait_for_log_contains(log_path, "Open / share:")
                required_snippets = [
                    "Open / share:",  # the one share URL to open/hand out
                    "http",  # ...and it is an actual URL
                    "FIRST account",  # first-run "Next steps" block
                    "owner/admin",  # first account becomes owner/admin
                    "Native QUIC",  # native voice status line
                ]
                for snippet in required_snippets:
                    if snippet not in log_text:
                        raise AssertionError(
                            f"startup summary missing {snippet!r}; last 2000 bytes:\n"
                            f"{log_text[-2000:]}"
                        )

                # (c) no error/warn about a missing LiveKit binary.
                assert_no_missing_livekit_complaint(log_text)

                # First account must be promoted to admin/owner; the second must
                # not. The register response exposes the raw `flags` bitfield.
                owner = request_json(
                    "POST",
                    base_url,
                    "/api/v1/auth/register",
                    body={
                        "email": "owner@example.com",
                        "username": "owneruser",
                        "password": "Ownerpass123!",
                    },
                    expected=201,
                    label="register first account",
                )
                owner_flags = owner.get("user", {}).get("flags")
                if not isinstance(owner_flags, int) or (owner_flags & USER_FLAG_ADMIN) == 0:
                    raise AssertionError(
                        f"first account not flagged admin/owner: flags={owner_flags!r}"
                    )
                owner_token = owner["token"]

                second = request_json(
                    "POST",
                    base_url,
                    "/api/v1/auth/register",
                    body={
                        "email": "second@example.com",
                        "username": "seconduser",
                        "password": "Secondpass123!",
                    },
                    expected=201,
                    label="register second account",
                )
                second_flags = second.get("user", {}).get("flags")
                if not isinstance(second_flags, int) or (second_flags & USER_FLAG_ADMIN) != 0:
                    raise AssertionError(
                        f"second account should not be admin: flags={second_flags!r}"
                    )
                second_token = second["token"]

                # Cross-check the flag against a genuinely admin-gated route the
                # other smokes use: owner can read admin stats, the second user
                # is forbidden.
                request_json(
                    "GET",
                    base_url,
                    "/api/v1/admin/stats",
                    token=owner_token,
                    expected=200,
                    label="owner reaches admin stats",
                )
                request_json(
                    "GET",
                    base_url,
                    "/api/v1/admin/stats",
                    token=second_token,
                    expected=403,
                    label="second user denied admin stats",
                )

                print(
                    "PASS: zero-config first run generated config, printed the friendly "
                    "summary (share URL + owner/admin + native voice), logged no LiveKit-"
                    "missing complaint, and promoted only the first account to owner/admin"
                )
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=10)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18140)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
