#!/usr/bin/env python3
"""Release-binary economy/progression smoke test."""

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
        body={"email": email, "username": username, "password": "Economy123!"},
        expected=201,
    )


def join_guild(base_url: str, token: str, code: str) -> None:
    request_json("POST", base_url, f"/api/v1/invites/{code}", token=token, body={}, expected=200)


def get_text_channel_id(base_url: str, token: str, guild_id: str) -> str:
    channels = request_json(
        "GET",
        base_url,
        f"/api/v1/guilds/{guild_id}/channels",
        token=token,
        expected=200,
    )
    channel = next(item for item in channels if int(item.get("channel_type", 0)) == 0)
    return channel["id"]


def assert_achievement(payload: dict[str, Any], key: str) -> None:
    achievements = payload.get("achievements", [])
    if not any(item.get("key") == key for item in achievements):
        raise AssertionError(f"expected achievement {key}: {payload}")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-economy-", ignore_cleanup_errors=True) as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "economy-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_XP_COOLDOWN_SECONDS": "60",
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
            admin = register(base_url, "economy-admin@example.com", "economyadmin")
            member = register(base_url, "economy-member@example.com", "economymember")
            admin_token = admin["token"]
            member_token = member["token"]
            admin_id = admin["user"]["id"]
            member_id = member["user"]["id"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Economy Smoke Guild", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            text_channel_id = get_text_channel_id(base_url, admin_token, guild_id)
            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_channel_id}/invites",
                token=admin_token,
                body={},
                expected=201,
            )
            join_guild(base_url, member_token, invite["code"])

            role = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/roles",
                token=admin_token,
                body={"name": "Level Starter", "permissions": 0},
                expected=201,
            )
            role_id = role["id"]
            other_guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Economy Other Guild", "icon": None},
                expected=201,
            )
            other_role = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{other_guild['id']}/roles",
                token=admin_token,
                body={"name": "Wrong Guild Role", "permissions": 0},
                expected=201,
            )

            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/level-roles",
                token=member_token,
                body={"mappings": [{"level": 0, "role_id": role_id}]},
                expected=403,
            )
            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/level-roles",
                token=admin_token,
                body={"mappings": [{"level": -1, "role_id": role_id}]},
                expected=400,
            )
            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/level-roles",
                token=admin_token,
                body={"mappings": [{"level": 0, "role_id": other_role["id"]}]},
                expected=400,
            )

            level_roles = request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/level-roles",
                token=admin_token,
                body={"mappings": [{"level": 0, "role_id": role_id}]},
                expected=200,
            )
            if not any(item.get("level") == 0 and item.get("role_id") == role_id for item in level_roles["mappings"]):
                raise AssertionError(f"level role mapping missing: {level_roles}")

            before = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/me",
                token=admin_token,
                expected=200,
            )
            if before["xp"] != 0 or before["rank"] is not None:
                raise AssertionError(f"new user economy state should be empty: {before}")

            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_channel_id}/messages",
                token=admin_token,
                body={"content": "This message should award release-smoke XP."},
                expected=201,
            )
            progress = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/me",
                token=admin_token,
                expected=200,
            )
            if progress["xp"] < 15 or progress["level"] != 0 or progress["rank"] != 1:
                raise AssertionError(f"unexpected XP after first message: {progress}")
            if progress["streak"]["days"] != 1 or progress["streak"]["longest_days"] != 1:
                raise AssertionError(f"unexpected streak after first message: {progress}")
            assert_achievement(progress, "first-message")

            first_xp = progress["xp"]
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_channel_id}/messages",
                token=admin_token,
                body={"content": "This quick second message should hit the XP cooldown."},
                expected=201,
            )
            cooled_down = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/me",
                token=admin_token,
                expected=200,
            )
            if cooled_down["xp"] != first_xp:
                raise AssertionError(f"XP cooldown did not prevent rapid farming: {cooled_down}")

            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_channel_id}/messages",
                token=member_token,
                body={"content": "A second user should also appear in the leaderboard."},
                expected=201,
            )
            leaderboard = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/economy/leaderboard?limit=10",
                token=admin_token,
                expected=200,
            )
            entries = leaderboard.get("entries", [])
            ids = {entry["user"]["id"] for entry in entries}
            if not {admin_id, member_id}.issubset(ids):
                raise AssertionError(f"leaderboard missing expected users: {leaderboard}")
            if any(entry["rank"] < 1 for entry in entries):
                raise AssertionError(f"leaderboard rank should be one-based: {leaderboard}")

            members = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/members",
                token=admin_token,
                expected=200,
            )
            admin_member = next(item for item in members if item["user"]["id"] == admin_id)
            member_member = next(item for item in members if item["user"]["id"] == member_id)
            if role_id not in admin_member.get("roles", []):
                raise AssertionError(f"admin was not assigned level role: {admin_member}")
            if role_id not in member_member.get("roles", []):
                raise AssertionError(f"member was not assigned level role: {member_member}")

            print("PASS: economy XP, cooldown anti-spam, achievements, leaderboard, and level roles work")
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
    parser.add_argument("--port", type=int, default=18134)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
