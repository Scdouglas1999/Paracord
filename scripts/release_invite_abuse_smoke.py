#!/usr/bin/env python3
"""Release-binary invite abuse-control smoke test."""

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
        body={"email": email, "username": username, "password": "InviteAbuse123!"},
        expected=201,
    )


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-invite-abuse-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "invite-abuse-smoke-secret-0123456789abcdef",
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
            admin = register(base_url, "invite-admin@example.com", "inviteadmin")
            user_one = register(base_url, "invite-one@example.com", "inviteone")
            user_two = register(base_url, "invite-two@example.com", "invitetwo")
            admin_token = admin["token"]
            user_one_token = user_one["token"]
            user_two_token = user_two["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Invite Abuse Smoke", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                body={
                    "name": "invites",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
            )
            invalid_invite_bounds = [
                ({"max_uses": -1, "max_age": 3600}, "negative max_uses"),
                ({"max_uses": 101, "max_age": 3600}, "excessive max_uses"),
                ({"max_uses": 1, "max_age": -1}, "negative max_age"),
                ({"max_uses": 1, "max_age": 604801}, "excessive max_age"),
            ]
            for payload, label in invalid_invite_bounds:
                request_json(
                    "POST",
                    base_url,
                    f"/api/v1/channels/{channel['id']}/invites",
                    token=admin_token,
                    body=payload,
                    expected=400,
                )

            unlimited = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/invites",
                token=admin_token,
                body={"max_uses": 0, "max_age": 0},
                expected=201,
            )
            if unlimited["max_uses"] != 0 or unlimited["max_age"] != 0:
                raise AssertionError(
                    f"zero invite bounds should round-trip as unlimited/never: {unlimited}"
                )

            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/invites",
                token=admin_token,
                body={"max_uses": 1, "max_age": 3600},
                expected=201,
            )
            code = invite["code"]

            request_json("GET", base_url, f"/api/v1/invites/{code}", expected=200)
            accepted = request_json(
                "POST",
                base_url,
                f"/api/v1/invites/{code}",
                token=user_one_token,
                body={},
                expected=200,
            )
            if accepted["guild"]["id"] != guild_id:
                raise AssertionError(f"accepted invite returned wrong guild: {accepted}")

            request_json("GET", base_url, f"/api/v1/invites/{code}", expected=404)
            request_json(
                "POST",
                base_url,
                f"/api/v1/invites/{code}",
                token=user_two_token,
                body={},
                expected=404,
            )
            request_json("GET", base_url, "/api/v1/invites/not-a-real-code", expected=404)

            invites = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/invites",
                token=admin_token,
                expected=200,
            )
            if any(item.get("code") == code for item in invites):
                raise AssertionError(f"exhausted invite still listed: {invites}")

            print("PASS: invite bounds and max-use exhaustion controls are enforced")
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
    parser.add_argument("--port", type=int, default=18128)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
