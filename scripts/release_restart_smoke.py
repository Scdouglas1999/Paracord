#!/usr/bin/env python3
"""Release-binary restart persistence smoke test.

Starts `target/release/paracord-server`, creates durable app state, stops the
server, restarts against the same temp SQLite database, and verifies auth plus
message state still works through real HTTP requests.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def assert_status(response: requests.Response, expected: int | tuple[int, ...], label: str) -> None:
    if isinstance(expected, tuple):
        ok = response.status_code in expected
    else:
        ok = response.status_code == expected
    if not ok:
        raise AssertionError(
            f"{label}: expected {expected}, got {response.status_code}: {response.text[:500]}"
        )


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    expected: int | tuple[int, ...] = 200,
    label: str,
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
    assert_status(response, expected, label)
    if not response.text:
        return None
    try:
        return response.json()
    except ValueError:
        return response.text


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


def wait_for_message_content(
    base_url: str,
    channel_id: str,
    token: str,
    content: str,
    *,
    timeout_seconds: float = 25.0,
) -> Any:
    deadline = time.time() + timeout_seconds
    last_messages: Any = None
    while time.time() < deadline:
        last_messages = request_json(
            "GET",
            base_url,
            f"/api/v1/channels/{channel_id}/messages",
            token=token,
            label=f"poll messages for {content!r}",
        )
        for message in last_messages:
            if message.get("content") == content:
                return message
        time.sleep(0.75)
    raise AssertionError(f"timed out waiting for message content {content!r}: {last_messages}")


def stop_server(proc: subprocess.Popen[object]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def start_server(server: Path, config_path: Path, env: dict[str, str], base_url: str) -> subprocess.Popen[object]:
    proc = subprocess.Popen(
        [str(server), "-c", str(config_path)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    wait_for_health(base_url, proc)
    return proc


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-restart-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        config_path = data / "paracord.toml"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-restart-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
            }
        )

        proc: subprocess.Popen[object] | None = None
        try:
            proc = start_server(server, config_path, env, base_url)
            admin = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "restart-admin@example.com",
                    "username": "restartadmin",
                    "password": "RestartAdmin123!",
                },
                expected=201,
                label="register admin before restart",
            )
            admin_token = admin["token"]
            admin_refresh = admin["refresh_token"]
            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Restart Smoke Guild", "icon": None},
                expected=201,
                label="create guild before restart",
            )
            channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild['id']}/channels",
                token=admin_token,
                body={
                    "name": "restart-smoke-text",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
                label="create channel before restart",
            )
            message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/messages",
                token=admin_token,
                body={"content": "message before restart"},
                expected=201,
                label="send message before restart",
            )
            scheduled_content = "scheduled message after restart"
            scheduled_send_at = (datetime.now(timezone.utc) + timedelta(seconds=8)).isoformat().replace("+00:00", "Z")
            scheduled = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/scheduled-messages",
                token=admin_token,
                body={"content": scheduled_content, "send_at": scheduled_send_at},
                expected=201,
                label="schedule message before restart",
            )
            if scheduled.get("status") != 0 or scheduled.get("content") != scheduled_content:
                raise AssertionError(f"unexpected scheduled message before restart: {scheduled}")
            stop_server(proc)
            proc = None

            proc = start_server(server, config_path, env, base_url)
            messages = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel['id']}/messages",
                token=admin_token,
                label="list messages after restart with existing access token",
            )
            if not any(item.get("id") == message["id"] for item in messages):
                raise AssertionError(f"pre-restart message missing after restart: {messages}")

            refreshed = request_json(
                "POST",
                base_url,
                "/api/v1/auth/refresh",
                body={"refresh_token": admin_refresh},
                label="refresh session after restart",
            )
            admin_token = refreshed["token"]
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/messages",
                token=admin_token,
                body={"content": "message after restart"},
                expected=201,
                label="send message after restart",
            )
            delivered_scheduled = wait_for_message_content(
                base_url,
                channel["id"],
                admin_token,
                scheduled_content,
                timeout_seconds=30.0,
            )
            if delivered_scheduled.get("author", {}).get("id") != admin["user"]["id"]:
                raise AssertionError(f"scheduled message author mismatch after restart: {delivered_scheduled}")

            print("PASS: release server restart persistence smoke passed")
            print(
                " ".join(
                    [
                        f"guild={guild['id']}",
                        f"channel={channel['id']}",
                        f"message={message['id']}",
                        f"scheduled={scheduled['id']}",
                    ]
                )
            )
        finally:
            if proc is not None:
                stop_server(proc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18116)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
