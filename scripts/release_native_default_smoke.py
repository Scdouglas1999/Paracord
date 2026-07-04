#!/usr/bin/env python3
"""Release-binary native-default voice smoke test.

Boots a zero-config `paracord-server` (no hand-written config, no LiveKit) and
proves that joining a voice channel returns a *native* QUIC media session:
`native_media: true`, real endpoint candidates, a media token, a cert hash, and
`livekit_available: false` — with no `livekit-server` string anywhere in the
payload. This guards the "native media is the default, one binary, no LiveKit"
product goal against regressions.

Network-free and CI-safe: temp SQLite database on loopback, media UDP port
relocated off the default 8443 so parallel runs never collide.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import requests

# Reuse the exact helpers the product smoke uses (server path, health poll,
# HTTP+assert) so this stays in lockstep with it.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from release_product_smoke import (  # noqa: E402
    release_server_path,
    request_json,
    wait_for_health,
)


ROOT = Path(__file__).resolve().parents[1]


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-native-default-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        # DO NOT set PARACORD_VOICE_NATIVE_MEDIA or any LiveKit config: native
        # QUIC must be the default with zero config. Only CI-isolation knobs are
        # set (temp paths, loopback bind, relocated media UDP port).
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_VOICE_PORT": str(args.port + 1000),
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

            owner = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "owner@example.com",
                    "username": "owneruser",
                    "password": "Ownerpass123!",
                },
                expected=201,
                label="register owner",
            )
            owner_token = owner["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=owner_token,
                body={"name": "Native Default Smoke Guild", "icon": None},
                expected=201,
                label="create guild",
            )
            guild_id = guild["id"]

            voice_channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=owner_token,
                body={
                    "name": "native-voice",
                    "channel_type": 2,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
                label="create voice channel",
            )
            voice_id = voice_channel["id"]

            # Capture the raw response so we can assert on the exact wire body,
            # not just the parsed dict.
            join_resp = requests.get(
                f"{base_url}/api/v1/voice/{voice_id}/join",
                headers={"Authorization": f"Bearer {owner_token}"},
                timeout=20,
            )
            if join_resp.status_code != 200:
                raise AssertionError(
                    f"voice join expected 200, got {join_resp.status_code}: {join_resp.text[:500]}"
                )
            raw_body = join_resp.text
            if "livekit-server" in raw_body:
                raise AssertionError(f"voice join body leaked 'livekit-server': {raw_body[:500]}")

            join = join_resp.json()

            if join.get("native_media") is not True:
                raise AssertionError(f"voice join did not return native_media=true: {join}")

            candidates = join.get("media_endpoint_candidates")
            if not isinstance(candidates, list) or not candidates:
                raise AssertionError(
                    f"voice join missing non-empty media_endpoint_candidates: {join}"
                )

            if not join.get("media_token"):
                raise AssertionError(f"voice join missing media_token: {join}")

            if not join.get("cert_hash"):
                raise AssertionError(f"voice join missing cert_hash: {join}")

            if join.get("livekit_available") is not False:
                raise AssertionError(
                    f"voice join must report livekit_available=false on a native-default server: {join}"
                )

            # Belt and suspenders: the serialized payload must not mention the
            # LiveKit binary either.
            if "livekit-server" in json.dumps(join):
                raise AssertionError(f"voice join payload leaked 'livekit-server': {join}")

            session_id = join.get("session_id")
            if session_id:
                # Best-effort teardown of the media session; ignore failures so a
                # flaky leave never fails the smoke's real assertions.
                requests.post(
                    f"{base_url}/api/v1/voice/{voice_id}/leave?session_id={session_id}",
                    headers={"Authorization": f"Bearer {owner_token}"},
                    timeout=20,
                )

            print(
                "PASS: zero-config voice join returned a native session "
                f"(native_media=true, {len(candidates)} endpoint candidate(s), media_token+"
                "cert_hash present, livekit_available=false, no 'livekit-server' in body)"
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
    parser.add_argument("--port", type=int, default=18142)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
