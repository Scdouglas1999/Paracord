#!/usr/bin/env python3
"""Release-binary guild template safety smoke test."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
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
        body={"email": email, "username": username, "password": "Template123!"},
        expected=201,
    )


def seed_template(db_path: Path, template_id: int, creator_id: str, name: str, data: dict[str, Any] | str) -> None:
    raw = data if isinstance(data, str) else json.dumps(data, separators=(",", ":"))
    deadline = time.time() + 10
    while True:
        try:
            with sqlite3.connect(db_path, timeout=5) as conn:
                conn.execute(
                    """
                    INSERT INTO guild_templates
                        (id, name, description, creator_id, source_guild_id, template_data)
                    VALUES (?, ?, '', ?, NULL, ?)
                    """,
                    (template_id, name, int(creator_id), raw),
                )
                conn.commit()
                return
        except sqlite3.OperationalError:
            if time.time() >= deadline:
                raise
            time.sleep(0.2)


def guild_count(base_url: str, token: str) -> int:
    guilds = request_json("GET", base_url, "/api/v1/users/@me/guilds", token=token, expected=200)
    if not isinstance(guilds, list):
        raise AssertionError(f"guild list should be an array: {guilds}")
    return len(guilds)


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-template-safety-", ignore_cleanup_errors=True) as temp_dir:
        data_dir = Path(temp_dir)
        db_path = data_dir / "paracord.db"
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{db_path.as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "template-safety-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data_dir / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data_dir / "files"),
                "PARACORD_BACKUP_DIR": str(data_dir / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
            }
        )
        proc = subprocess.Popen(
            [str(server), "-c", str(data_dir / "paracord.toml")],
            cwd=str(ROOT),
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        try:
            wait_for_health(base_url, proc)
            user = register(base_url, "template-user@example.com", "templateuser")
            token = user["token"]
            user_id = user["user"]["id"]

            base_template = {
                "roles": [{"name": "Safe Role", "permissions": "0"}],
                "channels": [
                    {"name": "Safe Category", "type": 4, "position": 2},
                    {"name": "safe-channel", "type": 0, "position": 3, "parent_name": "Safe Category"},
                ],
            }
            malicious_templates: list[tuple[int, str, dict[str, Any] | str]] = [
                (910000000001, "Bad JSON", "{not valid json"),
                (
                    910000000002,
                    "Bad Role Name",
                    {**base_template, "roles": [{"name": "<script>alert(1)</script>", "permissions": "0"}]},
                ),
                (
                    910000000003,
                    "Bad Permissions",
                    {**base_template, "roles": [{"name": "Bad Perms", "permissions": "-1"}]},
                ),
                (
                    910000000004,
                    "Bad Channel Name",
                    {**base_template, "channels": [{"name": "javascript:alert(1)", "type": 0, "position": 2}]},
                ),
                (
                    910000000005,
                    "Bad Channel Type",
                    {**base_template, "channels": [{"name": "weird-channel", "type": 999, "position": 2}]},
                ),
            ]
            for template_id, name, template_data in malicious_templates:
                seed_template(db_path, template_id, user_id, name, template_data)

            before_count = guild_count(base_url, token)
            for template_id, _name, _template_data in malicious_templates:
                request_json(
                    "POST",
                    base_url,
                    f"/api/v1/templates/{template_id}/apply",
                    token=token,
                    body={"name": f"Rejected {template_id}"},
                    expected=400,
                )
                after_reject_count = guild_count(base_url, token)
                if after_reject_count != before_count:
                    raise AssertionError(
                        f"malicious template {template_id} created a partial guild: before={before_count} after={after_reject_count}"
                    )

            safe_template_id = 910000000100
            seed_template(db_path, safe_template_id, user_id, "Safe Template", base_template)
            created = request_json(
                "POST",
                base_url,
                f"/api/v1/templates/{safe_template_id}/apply",
                token=token,
                body={"name": "Applied Safe Template"},
                expected=201,
            )
            created_guild_id = created["id"]
            channels = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{created_guild_id}/channels",
                token=token,
                expected=200,
            )
            channel_names = {channel.get("name") for channel in channels}
            if "safe-channel" not in channel_names or "Safe Category" not in channel_names:
                raise AssertionError(f"safe template channels missing: {channels}")
            roles = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{created_guild_id}/roles",
                token=token,
                expected=200,
            )
            if not any(role.get("name") == "Safe Role" for role in roles):
                raise AssertionError(f"safe template role missing: {roles}")
            templates = request_json("GET", base_url, "/api/v1/templates", token=token, expected=200)
            safe = next(item for item in templates if item["id"] == str(safe_template_id))
            if safe["usage_count"] != 1:
                raise AssertionError(f"safe template usage count was not incremented: {safe}")

            print("PASS: guild template application rejects malicious stored data without partial guilds and applies safe data")
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
    parser.add_argument("--port", type=int, default=18136)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
