#!/usr/bin/env python3
"""Release-binary poll and custom emoji smoke test."""

from __future__ import annotations

import argparse
import base64
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+q5sAAAAASUVORK5CYII="
)
TINY_GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==")


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
    if isinstance(expected, tuple):
        ok = response.status_code in expected
    else:
        ok = response.status_code == expected
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
        body={"email": email, "username": username, "password": "PollEmoji123!"},
        expected=201,
    )


def request_multipart(
    base_url: str,
    path: str,
    *,
    token: str,
    data: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
    expected: int,
) -> Any:
    response = requests.post(
        f"{base_url}{path}",
        headers={"Authorization": f"Bearer {token}"},
        data=data,
        files=files,
        timeout=20,
    )
    if response.status_code != expected:
        raise AssertionError(
            f"POST {path}: expected {expected}, got {response.status_code}: {response.text[:300]}"
        )
    return response.json() if response.text else None


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-poll-emoji-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "poll-emoji-smoke-secret-0123456789abcdef",
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
            admin = register(base_url, "poll-emoji-admin@example.com", "pollemojiadmin")
            voter = register(base_url, "poll-emoji-voter@example.com", "pollemotivoter")
            admin_token = admin["token"]
            voter_token = voter["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Poll Emoji Smoke", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                body={
                    "name": "polls",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
            )
            channel_id = channel["id"]

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
                token=voter_token,
                body={},
                expected=200,
            )

            poll_message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/polls",
                token=admin_token,
                body={
                    "question": "Best protocol?",
                    "options": [{"text": "Matrix"}, {"text": "Paracord"}],
                    "allow_multiselect": False,
                    "expires_in_minutes": 60,
                },
                expected=201,
            )
            poll_id = poll_message["poll"]["id"]
            poll = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/polls/{poll_id}",
                token=admin_token,
                expected=200,
            )
            options = poll.get("options", [])
            if len(options) != 2 or options[0].get("voted") is not False:
                raise AssertionError(f"unexpected initial poll options: {poll}")
            option_id = options[0]["id"]

            voted = request_json(
                "PUT",
                base_url,
                f"/api/v1/channels/{channel_id}/polls/{poll_id}/votes/{option_id}",
                token=voter_token,
                expected=200,
            )
            if voted["options"][0].get("voted") is not True:
                raise AssertionError(f"poll vote did not mark option as voted: {voted}")

            unvoted = request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{channel_id}/polls/{poll_id}/votes/{option_id}",
                token=voter_token,
                expected=200,
            )
            if unvoted["options"][0].get("voted") is not False:
                raise AssertionError(f"poll vote removal did not clear voted flag: {unvoted}")

            emoji = request_multipart(
                base_url,
                f"/api/v1/guilds/{guild_id}/emojis",
                token=admin_token,
                data={"name": "shipit"},
                files={"image": ("shipit.png", TINY_PNG, "image/png")},
                expected=201,
            )
            emoji_id = emoji["id"]
            if emoji.get("animated") is not False:
                raise AssertionError(f"static PNG emoji returned animated=true: {emoji}")
            listed = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/emojis",
                token=admin_token,
                expected=200,
            )
            if not any(item.get("id") == emoji_id for item in listed):
                raise AssertionError(f"created emoji missing from list: {listed}")
            image = requests.get(
                f"{base_url}/api/v1/guilds/{guild_id}/emojis/{emoji_id}/image",
                timeout=20,
            )
            if image.status_code != 200 or image.content != TINY_PNG:
                raise AssertionError(
                    f"emoji image mismatch: status={image.status_code}, bytes={len(image.content)}"
                )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
                token=admin_token,
                expected=204,
            )

            animated = request_multipart(
                base_url,
                f"/api/v1/guilds/{guild_id}/emojis",
                token=admin_token,
                data={"name": "dance"},
                files={"image": ("dance.gif", TINY_GIF, "image/gif")},
                expected=201,
            )
            animated_id = animated["id"]
            if animated.get("animated") is not True:
                raise AssertionError(f"GIF emoji returned animated=false: {animated}")
            animated_image = requests.get(
                f"{base_url}/api/v1/guilds/{guild_id}/emojis/{animated_id}/image",
                timeout=20,
            )
            if animated_image.status_code != 200 or animated_image.content != TINY_GIF:
                raise AssertionError(
                    "animated emoji image mismatch: "
                    f"status={animated_image.status_code}, bytes={len(animated_image.content)}"
                )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/emojis/{animated_id}",
                token=admin_token,
                expected=204,
            )

            print(
                "PASS: release poll voted flags and static/animated custom emoji upload/list/image/delete work"
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
    parser.add_argument("--port", type=int, default=18129)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
