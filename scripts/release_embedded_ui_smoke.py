#!/usr/bin/env python3
"""Verify the release server binary serves the current built web UI."""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def expected_index_asset() -> str:
    index_path = ROOT / "client" / "dist" / "index.html"
    if not index_path.exists():
        raise FileNotFoundError("missing client/dist/index.html; run `cd client && npm run build` first")
    html = index_path.read_text(encoding="utf-8", errors="replace")
    match = re.search(r"assets/index-[A-Za-z0-9_-]+\.js", html)
    if not match:
        raise AssertionError("client/dist/index.html does not reference a hashed index JS asset")
    return match.group(0)


def wait_for_health(base_url: str, proc: subprocess.Popen[object]) -> None:
    for _ in range(90):
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with {proc.returncode}")
        try:
            if requests.get(f"{base_url}/health", timeout=2).status_code == 200:
                return
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise TimeoutError("server did not become healthy")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    index_asset = expected_index_asset()

    with tempfile.TemporaryDirectory(prefix="paracord-embedded-ui-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "embedded-ui-jwt-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "RUST_LOG": "warn",
            }
        )

        proc = subprocess.Popen(
            [str(server), "-c", str(data / "paracord.toml")],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            wait_for_health(base_url, proc)
            response = requests.get(f"{base_url}/", timeout=10)
            response.raise_for_status()
            html = response.text
            checks = {
                "root_mount": 'id="root"' in html,
                "current_index_asset": index_asset in html,
                "hashed_js_asset": "assets/" in html and ".js" in html,
                "no_inline_sw_cleanup": "serviceWorker.getRegistrations" not in html,
            }
            failed = [name for name, passed in checks.items() if not passed]
            if failed:
                raise AssertionError(f"embedded UI checks failed: {failed}; html prefix={html[:300]!r}")
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=10)

    print(
        "PASS: embedded release UI served current index asset "
        f"{index_asset} with id=\"root\" and no inline service-worker cleanup"
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18142)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
