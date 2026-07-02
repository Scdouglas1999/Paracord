#!/usr/bin/env python3
"""Release-binary public discovery smoke test."""

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
        body={"email": email, "username": username, "password": "Discovery123!"},
        expected=201,
    )


def discovery_contains(base_url: str, guild_id: str, query: str = "") -> bool:
    payload = request_json("GET", base_url, f"/api/v1/discovery/guilds{query}", expected=200)
    guilds = payload.get("guilds", [])
    if not isinstance(guilds, list):
        raise AssertionError(f"discovery payload missing guild list: {payload}")
    return any(item.get("id") == guild_id for item in guilds)


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-discovery-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "discovery-smoke-secret-0123456789abcdef",
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
            admin = register(base_url, "discovery-admin@example.com", "discoveryadmin")
            user = register(base_url, "discovery-user@example.com", "discoveryuser")
            admin_token = admin["token"]
            user_token = user["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Discovery Smoke Guild", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            if guild.get("visibility") != "private":
                raise AssertionError(f"new guild should be private by default: {guild}")
            if discovery_contains(base_url, guild_id):
                raise AssertionError("private guild appeared in public discovery")

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}",
                token=user_token,
                body={"visibility": "public"},
                expected=403,
            )

            published = request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}",
                token=admin_token,
                body={
                    "description": "A release discovery smoke test guild",
                    "visibility": "public",
                    "discovery_tags": ["Release", "Open_Source", "release"],
                },
                expected=200,
            )
            if published.get("visibility") != "public":
                raise AssertionError(f"publish did not return public visibility: {published}")
            if published.get("discovery_tags") != ["release", "open_source"]:
                raise AssertionError(f"discovery tags were not normalized/deduped: {published}")

            if not discovery_contains(base_url, guild_id):
                raise AssertionError("published guild did not appear in public discovery")
            if not discovery_contains(base_url, guild_id, "?search=smoke"):
                raise AssertionError("published guild did not match discovery search")
            if not discovery_contains(base_url, guild_id, "?tag=open_source"):
                raise AssertionError("published guild did not match discovery tag")

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}",
                token=admin_token,
                body={"visibility": "private"},
                expected=200,
            )
            if discovery_contains(base_url, guild_id):
                raise AssertionError("private guild still appeared in public discovery after unpublish")

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}",
                token=admin_token,
                body={"visibility": "public", "discovery_tags": ["bad tag"]},
                expected=400,
            )

            print("PASS: public discovery is private-by-default, publishable, searchable, taggable, and removable")
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
    parser.add_argument("--port", type=int, default=18130)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
