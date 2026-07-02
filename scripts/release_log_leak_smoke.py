#!/usr/bin/env python3
"""Release-binary log leak smoke test."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    expected: int = 200,
) -> Any:
    headers = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    response = requests.request(
        method,
        f"{base_url}{path}",
        headers=headers,
        json=body,
        timeout=20,
    )
    if response.status_code != expected:
        raise AssertionError(
            f"{method} {path}: expected {expected}, got {response.status_code}: {response.text[:300]}"
        )
    return response.json() if response.text else None


def wait_for_health(base_url: str, proc: subprocess.Popen[object]) -> float:
    start = time.time()
    for _ in range(90):
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with {proc.returncode}")
        try:
            if requests.get(f"{base_url}/health", timeout=2).status_code == 200:
                return time.time() - start
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise TimeoutError("server did not become healthy")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-log-leak-") as temp_dir:
        data = Path(temp_dir)
        log_path = data / "server.log"
        base_url = f"http://127.0.0.1:{args.port}"
        jwt_secret = "log-leak-jwt-secret-0123456789abcdef"
        password = "LogLeakPass123!"
        webhook_secret = "log-leak-webhook-secret"
        tenor_api_key = "log-leak-tenor-key-should-not-appear"

        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": jwt_secret,
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_TENOR_API_KEY": tenor_api_key,
                "HTTPS_PROXY": "http://127.0.0.1:9",
                "NO_PROXY": "127.0.0.1,localhost",
                "RUST_LOG": "info",
            }
        )

        with log_path.open("w", encoding="utf-8") as log_file:
            proc = subprocess.Popen(
                [str(server), "-c", str(data / "paracord.toml")],
                cwd=str(ROOT),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                startup_seconds = wait_for_health(base_url, proc)
                admin = request_json(
                    "POST",
                    base_url,
                    "/api/v1/auth/register",
                    body={
                        "email": "log@example.com",
                        "username": "loguser",
                        "password": password,
                    },
                    expected=201,
                )
                token = admin["token"]
                guild = request_json(
                    "POST",
                    base_url,
                    "/api/v1/guilds",
                    token=token,
                    body={"name": "Log Leak Guild", "icon": None},
                    expected=201,
                )
                channel = request_json(
                    "POST",
                    base_url,
                    f"/api/v1/guilds/{guild['id']}/channels",
                    token=token,
                    body={
                        "name": "log-chat",
                        "channel_type": 0,
                        "parent_id": None,
                        "required_role_ids": None,
                    },
                    expected=201,
                )
                webhook = request_json(
                    "POST",
                    base_url,
                    f"/api/v1/guilds/{guild['id']}/webhooks",
                    token=token,
                    body={"name": "Log Leak Webhook", "channel_id": channel["id"]},
                    expected=201,
                )
                request_json(
                    "PATCH",
                    base_url,
                    f"/api/v1/webhooks/{webhook['id']}",
                    token=token,
                    body={"github_secret": webhook_secret},
                )
                requests.post(
                    f"{base_url}/api/v1/webhooks/{webhook['id']}/{webhook['token']}",
                    json={"content": "log leak webhook content"},
                    timeout=20,
                )
                requests.get(
                    f"{base_url}/api/v1/tenor/search",
                    params={"q": "paracord-log-leak", "limit": 1},
                    timeout=20,
                )
            finally:
                if proc.poll() is None:
                    proc.terminate()
                    try:
                        proc.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        proc.kill()
                        proc.wait(timeout=10)

        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        forbidden_values = [
            jwt_secret,
            password,
            webhook_secret,
            tenor_api_key,
            token,
            webhook.get("token", ""),
        ]
        leaked = [value for value in forbidden_values if value and value in log_text]
        if leaked:
            for value in leaked:
                print(f"LEAKED: {value[:12]}...")
            raise SystemExit(1)
        print(
            f"PASS: release server log leak smoke passed; "
            f"startup_health_seconds={startup_seconds:.2f}; log_bytes={len(log_text)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18100)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
