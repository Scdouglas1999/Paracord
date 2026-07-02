#!/usr/bin/env python3
"""Release-binary moderation-template audit smoke test."""

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
ACTION_MEMBER_UPDATE = 20


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
        body={"email": email, "username": username, "password": "Moderation123!"},
        expected=201,
    )


def join_guild(base_url: str, token: str, code: str) -> None:
    request_json("POST", base_url, f"/api/v1/invites/{code}", token=token, body={}, expected=200)


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-modtmpl-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "moderation-template-smoke-secret-0123456789abcdef",
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
            admin = register(base_url, "mod-template-admin@example.com", "modtemplateadmin")
            target = register(base_url, "mod-template-target@example.com", "modtemplatetarget")
            member = register(base_url, "mod-template-member@example.com", "modtemplatemember")
            admin_token = admin["token"]
            target_token = target["token"]
            member_token = member["token"]
            target_id = target["user"]["id"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Moderation Template Smoke", "icon": None},
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
            join_guild(base_url, target_token, invite["code"])
            join_guild(base_url, member_token, invite["code"])

            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates",
                token=member_token,
                body={"name": "Member Denied", "action_type": 1},
                expected=403,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates",
                token=admin_token,
                body={"name": "Bad Action", "action_type": 99},
                expected=400,
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates",
                token=admin_token,
                body={"name": "Bad Duration", "action_type": 2, "duration_minutes": 0},
                expected=400,
            )

            template = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates",
                token=admin_token,
                body={
                    "name": "Short Timeout",
                    "action_type": 2,
                    "duration_minutes": 5,
                    "reason_template": "Template timeout for {target} by {moderator}",
                    "dm_template": "You were timed out: {reason}",
                },
                expected=201,
            )
            template_id = template["id"]

            applied = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply",
                token=admin_token,
                body={"target_user_id": target_id},
                expected=200,
            )
            expected_reason = "Template timeout for modtemplatetarget by modtemplateadmin"
            if applied.get("status") != "muted" or applied.get("reason") != expected_reason:
                raise AssertionError(f"template apply response mismatch: {applied}")
            if applied.get("target_user_id") != target_id or not applied.get("until"):
                raise AssertionError(f"template apply missing target or timeout: {applied}")

            members = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/members",
                token=admin_token,
                expected=200,
            )
            muted = next(item for item in members if item["user"]["id"] == target_id)
            if not muted.get("communication_disabled_until"):
                raise AssertionError(f"target member was not timed out: {muted}")

            logs = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/audit-logs?action_type={ACTION_MEMBER_UPDATE}&limit=10",
                token=admin_token,
                expected=200,
            )
            entries = logs.get("audit_log_entries", [])
            matching = [
                entry
                for entry in entries
                if entry.get("target_id") == target_id
                and entry.get("user_id") == admin["user"]["id"]
                and entry.get("reason") == expected_reason
            ]
            if not matching:
                raise AssertionError(f"template apply audit entry missing: {logs}")
            changes = matching[0].get("changes") or {}
            if changes.get("template_id") != template_id:
                raise AssertionError(f"audit changes missing template id: {matching[0]}")
            if changes.get("template_name") != "Short Timeout" or changes.get("action_type") != 2:
                raise AssertionError(f"audit changes missing template metadata: {matching[0]}")

            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates/{template_id}",
                token=admin_token,
                expected=204,
            )
            templates = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/moderation/templates",
                token=admin_token,
                expected=200,
            )
            if any(item.get("id") == template_id for item in templates):
                raise AssertionError(f"deleted moderation template still listed: {templates}")

            print("PASS: moderation templates validate inputs, enforce permissions, time out members, and write audit logs")
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
    parser.add_argument("--port", type=int, default=18132)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
