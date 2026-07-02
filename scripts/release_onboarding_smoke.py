#!/usr/bin/env python3
"""Release-binary onboarding edge-case smoke test."""

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
        body={"email": email, "username": username, "password": "Onboarding123!"},
        expected=201,
    )


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-onboarding-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "onboarding-smoke-secret-0123456789abcdef",
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
            admin = register(base_url, "onboarding-admin@example.com", "onboardadmin")
            member = register(base_url, "onboarding-member@example.com", "onboardmember")
            admin_token = admin["token"]
            member_token = member["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Onboarding Smoke", "icon": None},
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
            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_channel['id']}/invites",
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

            role = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/roles",
                token=admin_token,
                body={"name": "Introduced", "permissions": 0},
                expected=201,
            )
            role_id = role["id"]
            other_guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Other Onboarding Smoke", "icon": None},
                expected=201,
            )
            other_role = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{other_guild['id']}/roles",
                token=admin_token,
                body={"name": "Wrong Guild", "permissions": 0},
                expected=201,
            )

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding",
                token=admin_token,
                body={"progressive_channel_min_messages": -1},
                expected=400,
            )
            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding",
                token=admin_token,
                body={
                    "role_options": [
                        {
                            "role_id": other_role["id"],
                            "label": "Wrong",
                            "description": "Wrong guild role",
                        }
                    ]
                },
                expected=400,
            )

            settings = request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding",
                token=admin_token,
                body={
                    "welcome_title": "Welcome",
                    "rules_text": "Be excellent to each other.",
                    "role_prompt": "Pick a role",
                    "progressive_channel_min_messages": 2,
                    "role_options": [
                        {
                            "role_id": role_id,
                            "label": "Introduced",
                            "description": "Finished onboarding",
                        }
                    ],
                },
                expected=200,
            )
            if settings["role_options"][0]["role_id"] != role_id:
                raise AssertionError(f"onboarding role option mismatch: {settings}")

            initial = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding/me",
                token=member_token,
                expected=200,
            )
            if initial["member_state"]["accepted_rules"] is not False:
                raise AssertionError(f"new member unexpectedly accepted rules: {initial}")

            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding/me",
                token=member_token,
                body={"accepted_rules": False, "selected_role_ids": [role_id], "completed": True},
                expected=400,
            )
            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding/me",
                token=member_token,
                body={
                    "accepted_rules": True,
                    "selected_role_ids": [other_role["id"]],
                    "completed": True,
                },
                expected=400,
            )

            completed = request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding/me",
                token=member_token,
                body={"accepted_rules": True, "selected_role_ids": [role_id], "completed": True},
                expected=200,
            )
            if completed["accepted_rules"] is not True or completed["selected_role_ids"] != [role_id]:
                raise AssertionError(f"onboarding completion mismatch: {completed}")
            if not completed.get("completed_at"):
                raise AssertionError(f"onboarding completion missing completed_at: {completed}")

            reentry = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/onboarding/me",
                token=member_token,
                expected=200,
            )
            if reentry["member_state"]["selected_role_ids"] != [role_id]:
                raise AssertionError(f"onboarding re-entry lost selected role: {reentry}")
            members = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/members",
                token=admin_token,
                expected=200,
            )
            member_id = member["user"]["id"]
            onboarded = next(item for item in members if item["user"]["id"] == member_id)
            if role_id not in onboarded.get("roles", []):
                raise AssertionError(f"selected onboarding role was not assigned: {onboarded}")

            print("PASS: onboarding malformed payloads, rule gate, role assignment, and re-entry work")
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
    parser.add_argument("--port", type=int, default=18131)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
