#!/usr/bin/env python3
"""Release-binary channel feature smoke test."""

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


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    expected: int | tuple[int, ...] = 200,
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
    ok = response.status_code in expected if isinstance(expected, tuple) else response.status_code == expected
    if not ok:
        raise AssertionError(
            f"{method} {path}: expected {expected}, got {response.status_code}: {response.text[:300]}"
        )
    return response.json() if response.text else None


def register(base_url: str, email: str, username: str) -> dict[str, Any]:
    return request_json(
        "POST",
        base_url,
        "/api/v1/auth/register",
        body={"email": email, "username": username, "password": "ChannelFeatures123!"},
        expected=201,
    )


def message_by_id(messages: list[dict[str, Any]], message_id: str) -> dict[str, Any] | None:
    for message in messages:
        if message.get("id") == message_id:
            return message
    return None


def wait_until_message_removed(base_url: str, channel_id: str, token: str, message_id: str) -> None:
    deadline = time.time() + 45
    while time.time() < deadline:
        messages = request_json(
            "GET",
            base_url,
            f"/api/v1/channels/{channel_id}/messages",
            token=token,
            expected=200,
        )
        if message_by_id(messages, message_id) is None:
            return
        time.sleep(1)
    raise AssertionError(f"message {message_id} was not removed by disappearing-message worker")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-channel-features-", ignore_cleanup_errors=True) as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "channel-feature-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
            }
        )
        proc = subprocess.Popen(
            [str(server), "-c", str(data / "paracord.toml")],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            wait_for_health(base_url, proc)
            admin = register(base_url, "channel-feature-admin@example.com", "featureadmin")
            member = register(base_url, "channel-feature-member@example.com", "featuremember")
            admin_token = admin["token"]
            member_token = member["token"]
            admin_id = admin["user"]["id"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Channel Features Smoke", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            channels = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                expected=200,
            )
            text_channel = next(item for item in channels if int(item.get("channel_type", 0)) == 0)
            channel_id = text_channel["id"]
            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/invites",
                token=admin_token,
                body={},
                expected=201,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/invites/{invite['code']}",
                token=member_token,
                body={},
                expected=200,
            )

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/channels/{channel_id}/features",
                token=member_token,
                body={"anonymous_posting_enabled": True},
                expected=403,
            )
            request_json(
                "PATCH",
                base_url,
                f"/api/v1/channels/{channel_id}/features",
                token=admin_token,
                body={"disappearing_seconds": -1},
                expected=400,
            )
            features = request_json(
                "PATCH",
                base_url,
                f"/api/v1/channels/{channel_id}/features",
                token=admin_token,
                body={
                    "anonymous_posting_enabled": True,
                    "disappearing_seconds": 1,
                    "adaptive_slowmode_enabled": True,
                    "adaptive_slowmode_window_seconds": 30,
                    "adaptive_slowmode_threshold": 1,
                    "adaptive_slowmode_step_seconds": 5,
                    "thread_rate_limit_per_user": 60,
                },
                expected=200,
            )
            if not features["anonymous_posting_enabled"] or features["disappearing_seconds"] != 1:
                raise AssertionError(f"feature settings did not persist: {features}")

            anonymous_message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/messages",
                token=admin_token,
                body={"content": "anonymous disappearing message"},
                expected=201,
            )
            message_id = anonymous_message["id"]
            if anonymous_message.get("expires_at") is None:
                raise AssertionError(f"anonymous message missing expires_at: {anonymous_message}")

            member_messages = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/messages",
                token=member_token,
                expected=200,
            )
            member_view = message_by_id(member_messages, message_id)
            if member_view is None:
                raise AssertionError(f"member could not see created message: {member_messages}")
            if member_view["author"]["id"] == admin_id:
                raise AssertionError(f"anonymous message exposed real author to member: {member_view}")
            if not (member_view.get("anonymous") or {}).get("is_anonymous"):
                raise AssertionError(f"anonymous metadata missing for member: {member_view}")
            if (member_view.get("anonymous") or {}).get("can_deanonymize"):
                raise AssertionError(f"member should not be able to deanonymize: {member_view}")
            request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/anonymous/deanonymize/{message_id}",
                token=member_token,
                expected=403,
            )

            admin_messages = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/messages",
                token=admin_token,
                expected=200,
            )
            admin_view = message_by_id(admin_messages, message_id)
            if admin_view is None or admin_view["author"]["id"] != admin_id:
                raise AssertionError(f"admin should see real anonymous author: {admin_messages}")
            if not (admin_view.get("anonymous") or {}).get("can_deanonymize"):
                raise AssertionError(f"admin should be marked able to deanonymize: {admin_view}")
            deanonymized = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/anonymous/deanonymize/{message_id}",
                token=admin_token,
                expected=200,
            )
            if deanonymized["user_id"] != admin_id:
                raise AssertionError(f"deanonymize returned wrong user: {deanonymized}")

            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/messages",
                token=member_token,
                body={"content": "first adaptive slowmode message"},
                expected=201,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/messages",
                token=member_token,
                body={"content": "second adaptive slowmode message"},
                expected=429,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/threads",
                token=member_token,
                body={"name": "first-thread"},
                expected=201,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/threads",
                token=member_token,
                body={"name": "second-thread"},
                expected=429,
            )

            wait_until_message_removed(base_url, channel_id, admin_token, message_id)

            print("PASS: anonymous posting, deanonymize permissions, disappearing cleanup, adaptive slowmode, and thread slowmode work")
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
    parser.add_argument("--port", type=int, default=18135)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
