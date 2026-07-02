#!/usr/bin/env python3
"""Release-binary product API smoke test.

Starts `target/release/paracord-server` with a temporary SQLite database and
validates core product flows through real HTTP requests.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import os
import struct
import subprocess
import sys
import tempfile
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]


def current_totp_code(secret_base32: str, *, for_time: int | None = None) -> str:
    """Generate a 6-digit TOTP code for the server-returned setup secret."""
    timestamp = int(time.time() if for_time is None else for_time)
    counter = timestamp // 30
    normalized = secret_base32.strip().replace(" ", "").upper()
    padding = "=" * ((8 - len(normalized) % 8) % 8)
    key = base64.b32decode(normalized + padding)
    digest = hmac.new(key, struct.pack(">Q", counter), hashlib.sha1).digest()
    offset = digest[-1] & 0x0F
    value = struct.unpack(">I", digest[offset : offset + 4])[0] & 0x7FFFFFFF
    return f"{value % 1_000_000:06d}"


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def assert_status(response: requests.Response, expected: int | tuple[int, ...], label: str) -> None:
    if isinstance(expected, tuple):
        ok = response.status_code in expected
    else:
        ok = response.status_code == expected
    if not ok:
        body = response.text[:500]
        raise AssertionError(f"{label}: expected {expected}, got {response.status_code}: {body}")


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


def request_attachment_upload(
    base_url: str,
    channel_id: str,
    token: str,
    *,
    filename: str,
    content: bytes,
    content_type: str,
) -> Any:
    response = requests.post(
        f"{base_url}/api/v1/channels/{channel_id}/attachments",
        headers={"Authorization": f"Bearer {token}"},
        files={"file": (filename, content, content_type)},
        timeout=20,
    )
    assert_status(response, 201, "upload attachment")
    return response.json()


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
    timeout_seconds: float = 20.0,
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


def wait_for_message_absent(
    base_url: str,
    channel_id: str,
    token: str,
    message_id: str,
    *,
    timeout_seconds: float = 45.0,
) -> None:
    deadline = time.time() + timeout_seconds
    last_messages: Any = None
    while time.time() < deadline:
        last_messages = request_json(
            "GET",
            base_url,
            f"/api/v1/channels/{channel_id}/messages",
            token=token,
            label=f"poll message deletion {message_id}",
        )
        if not any(message.get("id") == message_id for message in last_messages):
            return
        time.sleep(1.0)
    raise AssertionError(f"timed out waiting for message {message_id} deletion: {last_messages}")


def wait_for_event_status(
    base_url: str,
    guild_id: str,
    event_id: str,
    token: str,
    *,
    expected_status: int,
    require_reminder: bool,
    timeout_seconds: float = 45.0,
) -> Any:
    deadline = time.time() + timeout_seconds
    last_event: Any = None
    while time.time() < deadline:
        last_event = request_json(
            "GET",
            base_url,
            f"/api/v1/guilds/{guild_id}/events/{event_id}",
            token=token,
            label=f"poll event {event_id} status",
        )
        if last_event.get("status") == expected_status and (
            not require_reminder or last_event.get("reminder_sent_at")
        ):
            return last_event
        time.sleep(1.0)
    raise AssertionError(
        f"timed out waiting for event {event_id} status={expected_status}, reminder={require_reminder}: {last_event}"
    )


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-product-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-product-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_VOICE_NATIVE_MEDIA": "true",
                "PARACORD_VOICE_PORT": str(args.port + 1000),
            }
        )

        # Discard server logs. If stdout/stderr are piped but not drained, noisy
        # validation runs can block the child process on a full pipe.
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

            admin = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "admin@example.com",
                    "username": "adminuser",
                    "password": "Adminpass123!",
                },
                expected=201,
                label="register admin",
            )
            user = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "member@example.com",
                    "username": "memberuser",
                    "password": "Memberpass123!",
                },
                expected=201,
                label="register second user",
            )
            third_user = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "third@example.com",
                    "username": "thirduser",
                    "password": "Thirdpass123!",
                },
                expected=201,
                label="register third user",
            )
            admin_token = admin["token"]
            admin_refresh = admin["refresh_token"]
            user_token = user["token"]
            user_id = user["user"]["id"]
            third_user_token = third_user["token"]
            third_user_id = third_user["user"]["id"]

            request_json(
                "GET",
                base_url,
                "/api/v1/admin/stats",
                token=admin_token,
                label="admin stats admin",
            )
            admin_settings = request_json(
                "GET",
                base_url,
                "/api/v1/admin/settings",
                token=admin_token,
                label="admin settings admin",
            )
            if "registration_enabled" not in admin_settings or "server_name" not in admin_settings:
                raise AssertionError(f"admin settings missing expected keys: {admin_settings}")
            updated_admin_settings = request_json(
                "PATCH",
                base_url,
                "/api/v1/admin/settings",
                token=admin_token,
                body={
                    "server_name": "Release Smoke Server",
                    "server_description": "Release smoke admin settings",
                    "max_guilds_per_user": "25",
                    "federation_file_cache_enabled": "false",
                },
                label="update admin settings",
            )
            for key, value in {
                "server_name": "Release Smoke Server",
                "server_description": "Release smoke admin settings",
                "max_guilds_per_user": "25",
            }.items():
                if updated_admin_settings.get(key) != value:
                    raise AssertionError(f"admin setting {key} mismatch: {updated_admin_settings}")
            reloaded_admin_settings = request_json(
                "GET",
                base_url,
                "/api/v1/admin/settings",
                token=admin_token,
                label="reload admin settings",
            )
            if reloaded_admin_settings.get("federation_file_cache_enabled") != "false":
                raise AssertionError(f"admin config setting did not persist: {reloaded_admin_settings}")
            sessions_before_refresh = request_json(
                "GET",
                base_url,
                "/api/v1/auth/sessions",
                token=admin_token,
                label="list admin sessions before refresh",
            )
            if not sessions_before_refresh:
                raise AssertionError("admin session list was empty before refresh")

            old_admin_token = admin_token
            refreshed = request_json(
                "POST",
                base_url,
                "/api/v1/auth/refresh",
                body={"refresh_token": admin_refresh},
                label="refresh admin session",
            )
            admin_token = refreshed["token"]
            admin_refresh = refreshed["refresh_token"]
            request_json(
                "GET",
                base_url,
                "/api/v1/admin/stats",
                token=old_admin_token,
                expected=(401, 403),
                label="old admin access token rejected after refresh",
            )
            sessions_after_refresh = request_json(
                "GET",
                base_url,
                "/api/v1/auth/sessions",
                token=admin_token,
                label="list admin sessions after refresh",
            )
            if not sessions_after_refresh:
                raise AssertionError("admin session list was empty after refresh")

            login_session = request_json(
                "POST",
                base_url,
                "/api/v1/auth/login",
                body={"email": "admin@example.com", "password": "Adminpass123!"},
                label="login admin second session",
            )
            login_token = login_session["token"]
            login_refresh = login_session["refresh_token"]
            login_sessions = request_json(
                "GET",
                base_url,
                "/api/v1/auth/sessions",
                token=login_token,
                label="list login sessions",
            )
            if len(login_sessions) < 2:
                raise AssertionError(f"expected at least two sessions after login, got {login_sessions}")
            request_json(
                "POST",
                base_url,
                "/api/v1/auth/logout",
                token=login_token,
                expected=204,
                label="logout second admin session",
            )
            request_json(
                "GET",
                base_url,
                "/api/v1/admin/stats",
                token=login_token,
                expected=(401, 403),
                label="logged out access token rejected",
            )
            request_json(
                "POST",
                base_url,
                "/api/v1/auth/refresh",
                body={"refresh_token": login_refresh},
                expected=(401, 403),
                label="logged out refresh token rejected",
            )
            refreshed_again = request_json(
                "POST",
                base_url,
                "/api/v1/auth/refresh",
                body={"refresh_token": admin_refresh},
                label="refreshed admin session remains refreshable",
            )
            admin_token = refreshed_again["token"]
            admin_refresh = refreshed_again["refresh_token"]
            request_json(
                "GET",
                base_url,
                "/api/v1/admin/stats",
                token=user_token,
                expected=(401, 403),
                label="admin stats second user forbidden",
            )
            request_json(
                "GET",
                base_url,
                "/api/v1/admin/settings",
                token=user_token,
                expected=(401, 403),
                label="admin settings second user forbidden",
            )

            forgot_existing = request_json(
                "POST",
                base_url,
                "/api/v1/auth/forgot-password",
                body={"identifier": "member@example.com"},
                label="forgot password existing account",
            )
            forgot_missing = request_json(
                "POST",
                base_url,
                "/api/v1/auth/forgot-password",
                body={"identifier": "missing@example.com"},
                label="forgot password missing account",
            )
            if forgot_existing != forgot_missing:
                raise AssertionError(
                    f"forgot-password response differs for existing/missing users: {forgot_existing} vs {forgot_missing}"
                )
            request_json(
                "POST",
                base_url,
                "/api/v1/auth/reset-password",
                body={"token": "not-a-valid-reset-token", "new_password": "Resetpass123!"},
                expected=400,
                label="reject invalid password reset token",
            )

            mfa_status = request_json(
                "GET",
                base_url,
                "/api/v1/auth/mfa/status",
                token=third_user_token,
                label="mfa status before setup",
            )
            if mfa_status.get("mfa_enabled") is not False:
                raise AssertionError(f"unexpected initial MFA status: {mfa_status}")
            mfa_setup = request_json(
                "POST",
                base_url,
                "/api/v1/auth/mfa/setup",
                token=third_user_token,
                label="mfa setup",
            )
            if not mfa_setup.get("secret") or not mfa_setup.get("otpauth_url") or not mfa_setup.get("qr_code"):
                raise AssertionError(f"incomplete MFA setup response: {mfa_setup}")
            request_json(
                "POST",
                base_url,
                "/api/v1/auth/mfa/verify",
                token=third_user_token,
                body={"code": "000000"},
                expected=400,
                label="reject invalid mfa setup code",
            )
            mfa_code = current_totp_code(mfa_setup["secret"])
            mfa_enabled = request_json(
                "POST",
                base_url,
                "/api/v1/auth/mfa/verify",
                token=third_user_token,
                body={"code": mfa_code},
                label="verify mfa setup",
            )
            backup_codes = mfa_enabled.get("backup_codes") or []
            if mfa_enabled.get("mfa_enabled") is not True or len(backup_codes) != 10:
                raise AssertionError(f"unexpected MFA verify response: {mfa_enabled}")
            mfa_status_enabled = request_json(
                "GET",
                base_url,
                "/api/v1/auth/mfa/status",
                token=third_user_token,
                label="mfa status after setup",
            )
            if mfa_status_enabled.get("mfa_enabled") is not True or mfa_status_enabled.get("backup_codes_remaining") != 10:
                raise AssertionError(f"unexpected enabled MFA status: {mfa_status_enabled}")
            mfa_challenge = request_json(
                "POST",
                base_url,
                "/api/v1/auth/login",
                body={"email": "third@example.com", "password": "Thirdpass123!"},
                label="login requires mfa",
            )
            mfa_ticket = (mfa_challenge.get("user") or {}).get("mfa_ticket")
            if mfa_challenge.get("token") != "" or not (mfa_challenge.get("user") or {}).get("mfa_required") or not mfa_ticket:
                raise AssertionError(f"login did not require MFA as expected: {mfa_challenge}")
            mfa_login = request_json(
                "POST",
                base_url,
                "/api/v1/auth/mfa/login",
                body={"ticket": mfa_ticket, "code": current_totp_code(mfa_setup["secret"])},
                label="mfa login",
            )
            if not mfa_login.get("token") or not mfa_login.get("refresh_token"):
                raise AssertionError(f"MFA login did not issue tokens: {mfa_login}")
            third_user_token = mfa_login["token"]
            mfa_disabled = request_json(
                "POST",
                base_url,
                "/api/v1/auth/mfa/disable",
                token=third_user_token,
                body={"code": backup_codes[0]},
                label="disable mfa with backup code",
            )
            if mfa_disabled.get("mfa_enabled") is not False:
                raise AssertionError(f"MFA disable failed: {mfa_disabled}")

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Release Smoke Guild", "icon": None},
                expected=201,
                label="create guild",
            )
            guild_id = guild["id"]
            role = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/roles",
                token=admin_token,
                body={
                    "name": "Smoke Role",
                    "permissions": 0,
                    "color": 3447003,
                    "hoist": False,
                    "mentionable": True,
                },
                expected=201,
                label="create role",
            )
            request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/roles",
                token=admin_token,
                label="list roles",
            )

            channels = {}
            for name, channel_type in (
                ("text", 0),
                ("voice", 2),
                ("announcement", 5),
                ("forum", 7),
            ):
                channels[name] = request_json(
                    "POST",
                    base_url,
                    f"/api/v1/guilds/{guild_id}/channels",
                    token=admin_token,
                    body={
                        "name": f"release-{name}",
                        "channel_type": channel_type,
                        "parent_id": None,
                        "required_role_ids": None,
                    },
                    expected=201,
                    label=f"create {name} channel",
                )
            text_id = channels["text"]["id"]
            voice_id = channels["voice"]["id"]
            forum_id = channels["forum"]["id"]

            template = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/template",
                token=admin_token,
                expected=201,
                label="create guild template",
            )
            template_id = template["id"]
            template_channels = template.get("template_data", {}).get("channels") or []
            if not any(item.get("name") == "release-text" for item in template_channels):
                raise AssertionError(f"template missing source channels: {template}")
            templates = request_json(
                "GET",
                base_url,
                "/api/v1/templates",
                token=admin_token,
                label="list guild templates",
            )
            if not any(item.get("id") == template_id for item in templates):
                raise AssertionError(f"created template missing from list: {templates}")
            request_json(
                "POST",
                base_url,
                f"/api/v1/templates/{template_id}/apply",
                token=admin_token,
                body={"name": "<script>alert(1)</script>"},
                expected=400,
                label="reject unsafe template apply name",
            )
            applied_guild = request_json(
                "POST",
                base_url,
                f"/api/v1/templates/{template_id}/apply",
                token=admin_token,
                body={"name": "Release Smoke Applied Template"},
                expected=201,
                label="apply guild template",
            )
            applied_channels = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{applied_guild['id']}/channels",
                token=admin_token,
                label="list applied template channels",
            )
            if not any(item.get("name") == "release-text" for item in applied_channels):
                raise AssertionError(f"applied template missing release-text channel: {applied_channels}")
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/templates/{template_id}",
                token=admin_token,
                expected=204,
                label="delete guild template",
            )

            disappearing_channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                body={
                    "name": "release-disappearing",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
                label="create disappearing channel",
            )
            disappearing_features = request_json(
                "PATCH",
                base_url,
                f"/api/v1/channels/{disappearing_channel['id']}/features",
                token=admin_token,
                body={"disappearing_seconds": 1},
                label="enable disappearing messages",
            )
            if disappearing_features.get("disappearing_seconds") != 1:
                raise AssertionError(f"disappearing feature update mismatch: {disappearing_features}")
            disappearing_message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{disappearing_channel['id']}/messages",
                token=admin_token,
                body={"content": "release smoke disappearing"},
                expected=201,
                label="send disappearing message",
            )

            event_start = (datetime.now(timezone.utc) + timedelta(seconds=7)).isoformat().replace("+00:00", "Z")
            event_end = (datetime.now(timezone.utc) + timedelta(seconds=70)).isoformat().replace("+00:00", "Z")
            scheduled_event = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Release smoke event",
                    "description": "Release smoke event body",
                    "scheduled_start": event_start,
                    "scheduled_end": event_end,
                    "entity_type": 1,
                    "channel_id": text_id,
                    "location": "Release smoke venue",
                    "recurrence_rule": "weekly",
                    "reminder_minutes": 1,
                },
                expected=201,
                label="create scheduled event",
            )
            event_id = scheduled_event["id"]
            if scheduled_event.get("status") != 1 or scheduled_event.get("recurrence_rule") != "weekly":
                raise AssertionError(f"unexpected scheduled event response: {scheduled_event}")
            updated_event = request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=admin_token,
                body={"description": "Release smoke event edited"},
                label="update scheduled event",
            )
            if updated_event.get("description") != "Release smoke event edited":
                raise AssertionError(f"scheduled event update mismatch: {updated_event}")
            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}/rsvp",
                token=admin_token,
                expected=204,
                label="rsvp scheduled event",
            )
            rsvp_event = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=admin_token,
                label="get scheduled event with rsvp",
            )
            if rsvp_event.get("user_count") != 1 or rsvp_event.get("user_rsvp") is not True:
                raise AssertionError(f"scheduled event RSVP mismatch: {rsvp_event}")
            ical = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}/ical",
                token=admin_token,
                label="export scheduled event ical",
            )
            if "BEGIN:VEVENT" not in ical or "RRULE:FREQ=WEEKLY" not in ical:
                raise AssertionError(f"scheduled event iCal missing expected content: {ical[:500]}")
            worker_event = wait_for_event_status(
                base_url,
                guild_id,
                event_id,
                admin_token,
                expected_status=2,
                require_reminder=True,
                timeout_seconds=45.0,
            )
            if not worker_event.get("event_channel_created") or not worker_event.get("event_channel_id"):
                raise AssertionError(f"scheduled event worker did not create event channel: {worker_event}")
            wait_for_message_absent(
                base_url,
                disappearing_channel["id"],
                admin_token,
                disappearing_message["id"],
                timeout_seconds=45.0,
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}/rsvp",
                token=admin_token,
                expected=204,
                label="remove scheduled event rsvp",
            )

            scheduled_content = "release smoke scheduled delivery"
            scheduled_send_at = (datetime.now(timezone.utc) + timedelta(seconds=7)).isoformat().replace("+00:00", "Z")
            scheduled = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/scheduled-messages",
                token=admin_token,
                body={"content": scheduled_content, "send_at": scheduled_send_at},
                expected=201,
                label="create scheduled message",
            )
            if scheduled.get("status") != 0 or scheduled.get("content") != scheduled_content:
                raise AssertionError(f"unexpected scheduled message response: {scheduled}")
            scheduled_list = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{text_id}/scheduled-messages",
                token=admin_token,
                label="list scheduled messages",
            )
            if not any(item.get("id") == scheduled["id"] for item in scheduled_list):
                raise AssertionError(f"scheduled message missing from list: {scheduled_list}")
            delivered_scheduled = wait_for_message_content(
                base_url,
                text_id,
                admin_token,
                scheduled_content,
                timeout_seconds=20.0,
            )
            if delivered_scheduled.get("author", {}).get("id") != admin["user"]["id"]:
                raise AssertionError(f"scheduled message author mismatch: {delivered_scheduled}")

            voice_join = request_json(
                "GET",
                base_url,
                f"/api/v1/voice/{voice_id}/join",
                token=admin_token,
                label="join native voice",
            )
            if voice_join.get("native_media") is not True:
                raise AssertionError(f"native voice join did not return native_media=true: {voice_join}")
            for key in ("media_endpoint", "media_token", "room_name", "session_id"):
                if not voice_join.get(key):
                    raise AssertionError(f"native voice join missing {key}: {voice_join}")
            stream_quality = "720p30"
            stream = request_json(
                "POST",
                base_url,
                f"/api/v1/voice/{voice_id}/stream",
                token=admin_token,
                body={
                    "title": "Release smoke stream",
                    "quality_preset": stream_quality,
                },
                label="start native stream",
            )
            if stream.get("native_media") is not True:
                raise AssertionError(f"native stream did not return native_media=true: {stream}")
            if stream.get("quality_preset") != stream_quality:
                raise AssertionError(f"native stream quality mismatch: {stream}")
            request_json(
                "POST",
                base_url,
                f"/api/v1/voice/{voice_id}/stream/stop",
                token=admin_token,
                expected=204,
                label="stop native stream",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/voice/{voice_id}/leave?session_id={voice_join['session_id']}",
                token=admin_token,
                expected=204,
                label="leave native voice",
            )

            request_json(
                "PUT",
                base_url,
                f"/api/v1/channels/{text_id}/overwrites/{role['id']}",
                token=admin_token,
                body={"target_type": 0, "allow_perms": 0, "deny_perms": 0},
                expected=(200, 204),
                label="upsert channel overwrite",
            )
            overwrites = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{text_id}/overwrites",
                token=admin_token,
                label="list channel overwrites",
            )
            if not any(overwrite.get("target_id") == role["id"] for overwrite in overwrites):
                raise AssertionError("created channel overwrite missing from list response")

            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/invites",
                token=admin_token,
                body={"max_uses": 3, "max_age": 3600},
                expected=201,
                label="create invite",
            )
            code = invite["code"]
            request_json("GET", base_url, f"/api/v1/invites/{code}", label="preview invite")
            accepted = request_json(
                "POST",
                base_url,
                f"/api/v1/invites/{code}",
                token=user_token,
                body={},
                label="accept invite",
            )
            if accepted["guild"]["id"] != guild_id:
                raise AssertionError("accepted invite returned the wrong guild")

            members = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/members",
                token=admin_token,
                label="list members",
            )
            if not any(
                str(member.get("user", {}).get("id") or member.get("user_id")) == str(user_id)
                for member in members
            ):
                raise AssertionError(f"second user missing from members payload: {members}")

            bot_app = request_json(
                "POST",
                base_url,
                "/api/v1/bots/applications",
                token=admin_token,
                body={
                    "name": "ReleaseSmokeBot",
                    "description": "Release smoke bot application",
                    "permissions": "3072",
                },
                expected=201,
                label="create bot application",
            )
            bot_app_id = bot_app["id"]
            bot_user_id = bot_app["bot_user_id"]
            if not bot_app.get("token") or not bot_user_id:
                raise AssertionError(f"bot application missing token or bot user: {bot_app}")
            oauth = request_json(
                "POST",
                base_url,
                "/api/v1/oauth2/authorize",
                token=admin_token,
                body={"application_id": bot_app_id, "guild_id": guild_id},
                label="authorize bot into guild",
            )
            if oauth.get("authorized") is not True or oauth.get("application_id") != bot_app_id:
                raise AssertionError(f"bot OAuth response mismatch: {oauth}")
            guild_bots = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/bots",
                token=admin_token,
                label="list guild bots after install",
            )
            if not any((item.get("application") or {}).get("id") == bot_app_id for item in guild_bots):
                raise AssertionError(f"installed bot missing from guild bot list: {guild_bots}")
            global_command = request_json(
                "POST",
                base_url,
                f"/api/v1/applications/{bot_app_id}/commands",
                token=admin_token,
                body={"name": "releaseglobal", "description": "Release smoke global command"},
                expected=201,
                label="create bot global command",
            )
            guild_command = request_json(
                "POST",
                base_url,
                f"/api/v1/applications/{bot_app_id}/guilds/{guild_id}/commands",
                token=admin_token,
                body={"name": "releaseguild", "description": "Release smoke guild command"},
                expected=201,
                label="create bot guild command",
            )
            available_commands = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/commands",
                token=admin_token,
                label="list guild available commands",
            )
            available_names = {item.get("name") for item in available_commands}
            if not {"releaseglobal", "releaseguild"}.issubset(available_names):
                raise AssertionError(f"bot commands missing from guild discovery: {available_commands}")
            interaction = request_json(
                "POST",
                base_url,
                "/api/v1/interactions",
                token=admin_token,
                body={
                    "command_name": global_command["name"],
                    "guild_id": guild_id,
                    "channel_id": text_id,
                    "type": 2,
                    "options": [],
                },
                expected=201,
                label="invoke bot slash command",
            )
            interaction_token = interaction["token"]
            if interaction.get("application_id") != bot_app_id or interaction.get("data", {}).get("id") != global_command["id"]:
                raise AssertionError(f"slash interaction mismatch: {interaction}")
            bot_response = request_json(
                "POST",
                base_url,
                f"/api/v1/interactions/{interaction['id']}/{interaction_token}/callback",
                body={
                    "type": 4,
                    "data": {
                        "content": "release smoke bot response",
                        "components": [
                            {
                                "type": 1,
                                "components": [
                                    {
                                        "type": 2,
                                        "label": "Release button",
                                        "custom_id": "release_button",
                                        "style": 1,
                                    }
                                ],
                            }
                        ],
                    },
                },
                label="bot interaction callback",
            )
            if bot_response.get("author_id") != bot_user_id or bot_response.get("message_type") != 20:
                raise AssertionError(f"bot callback response mismatch: {bot_response}")
            component_interaction = request_json(
                "POST",
                base_url,
                "/api/v1/interactions",
                token=admin_token,
                body={
                    "type": 3,
                    "guild_id": guild_id,
                    "channel_id": text_id,
                    "message_id": bot_response["id"],
                    "custom_id": "release_button",
                    "component_type": 2,
                },
                expected=201,
                label="invoke bot component interaction",
            )
            if component_interaction.get("application_id") != bot_app_id or component_interaction.get("type") != 3:
                raise AssertionError(f"component interaction mismatch: {component_interaction}")
            followup = request_json(
                "POST",
                base_url,
                f"/api/v1/interactions/{bot_app_id}/{interaction_token}/followup",
                body={"content": "release smoke bot followup"},
                expected=201,
                label="create bot interaction followup",
            )
            if followup.get("author_id") != bot_user_id or followup.get("content") != "release smoke bot followup":
                raise AssertionError(f"bot followup mismatch: {followup}")
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/bots/{bot_app_id}",
                token=admin_token,
                expected=204,
                label="remove bot from guild",
            )
            guild_bots_after_remove = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/bots",
                token=admin_token,
                label="list guild bots after removal",
            )
            if any((item.get("application") or {}).get("id") == bot_app_id for item in guild_bots_after_remove):
                raise AssertionError(f"removed bot still present in guild bot list: {guild_bots_after_remove}")

            message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/messages",
                token=admin_token,
                body={"content": "release smoke unique search needle"},
                expected=201,
                label="send message",
            )
            message_id = message["id"]
            reply = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/messages",
                token=user_token,
                body={
                    "content": "release smoke reply",
                    "referenced_message_id": message_id,
                },
                expected=201,
                label="send reply",
            )
            if reply.get("reference_id") != message_id:
                raise AssertionError(f"reply reference mismatch: {reply}")
            edited = request_json(
                "PATCH",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{message_id}",
                token=admin_token,
                body={"content": "release smoke edited search needle"},
                label="edit message",
            )
            if edited["content"] != "release smoke edited search needle":
                raise AssertionError("edited message content mismatch")

            image_bytes = (
                b"\x89PNG\r\n\x1a\n"
                b"\x00\x00\x00\rIHDR"
                b"\x00\x00\x00\x01\x00\x00\x00\x01"
                b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89"
                b"\x00\x00\x00\x0bIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfeA\xe2!\xbc"
                b"\x00\x00\x00\x00IEND\xaeB`\x82"
            )
            attachment = request_attachment_upload(
                base_url,
                text_id,
                admin_token,
                filename="release-smoke.png",
                content=image_bytes,
                content_type="image/png",
            )
            attachment_message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/messages",
                token=admin_token,
                body={
                    "content": "release smoke image attachment",
                    "attachment_ids": [attachment["id"]],
                },
                expected=201,
                label="send message with attachment",
            )
            message_attachments = attachment_message.get("attachments") or []
            if not any(item.get("id") == attachment["id"] for item in message_attachments):
                raise AssertionError(f"attachment missing from message response: {attachment_message}")
            download = requests.get(
                f"{base_url}/api/v1/attachments/{attachment['id']}",
                headers={"Authorization": f"Bearer {user_token}"},
                timeout=20,
            )
            assert_status(download, 200, "download attachment")
            if download.content != image_bytes:
                raise AssertionError("downloaded attachment bytes did not match upload")
            if "image/png" not in download.headers.get("content-type", ""):
                raise AssertionError(f"unexpected attachment content type: {download.headers}")

            request_json(
                "PUT",
                base_url,
                f"/api/v1/channels/{text_id}/pins/{message_id}",
                token=admin_token,
                expected=(200, 204),
                label="pin message",
            )
            pins = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{text_id}/pins",
                token=admin_token,
                label="list pins",
            )
            if not any(pin.get("id") == message_id for pin in pins):
                raise AssertionError("pinned message missing from pins response")

            emoji = urllib.parse.quote("ok")
            request_json(
                "PUT",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{message_id}/reactions/{emoji}/@me",
                token=user_token,
                expected=(200, 204),
                label="add reaction",
            )
            query = urllib.parse.quote("edited search")
            search = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{text_id}/messages/search?q={query}",
                token=user_token,
                label="search messages",
            )
            if not any(result.get("id") == message_id for result in search):
                raise AssertionError("search result missing edited message")
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{message_id}/reactions/{emoji}/@me",
                token=user_token,
                expected=(200, 204),
                label="remove reaction",
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{text_id}/pins/{message_id}",
                token=admin_token,
                expected=(200, 204),
                label="unpin message",
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{message_id}",
                token=admin_token,
                expected=204,
                label="delete message",
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{reply['id']}",
                token=user_token,
                expected=204,
                label="delete reply",
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/channels/{text_id}/messages/{attachment_message['id']}",
                token=admin_token,
                expected=204,
                label="delete attachment message",
            )

            thread = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{text_id}/threads",
                token=admin_token,
                body={"name": "release-thread", "auto_archive_duration": 1440},
                expected=201,
                label="create thread",
            )
            threads = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{text_id}/threads",
                token=admin_token,
                label="list threads",
            )
            if not any(item.get("id") == thread["id"] for item in threads):
                raise AssertionError("created thread missing from list response")
            forum_post = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{forum_id}/forum/posts",
                token=admin_token,
                body={"name": "Release smoke forum post", "content": "forum body"},
                expected=201,
                label="create forum post",
            )
            if "id" not in forum_post:
                raise AssertionError(f"forum post id missing: {forum_post}")

            webhook = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/webhooks",
                token=admin_token,
                body={"name": "Release Smoke Webhook", "channel_id": text_id},
                expected=201,
                label="create webhook",
            )
            webhook_id = webhook["id"]
            webhook_token = webhook["token"]
            webhook_message = request_json(
                "POST",
                base_url,
                f"/api/v1/webhooks/{webhook_id}/{webhook_token}",
                body={"content": "release smoke webhook"},
                expected=201,
                label="execute webhook",
            )
            webhook_message_id = webhook_message["id"]
            edited_webhook = request_json(
                "PATCH",
                base_url,
                f"/api/v1/webhooks/{webhook_id}/{webhook_token}/messages/{webhook_message_id}",
                body={"content": "release smoke webhook edited"},
                label="edit webhook message",
            )
            if edited_webhook["content"] != "release smoke webhook edited":
                raise AssertionError(f"webhook edit mismatch: {edited_webhook}")

            github_secret = "release-github-secret"
            request_json(
                "PATCH",
                base_url,
                f"/api/v1/webhooks/{webhook_id}",
                token=admin_token,
                body={"github_secret": github_secret},
                label="set github webhook secret",
            )
            github_payload = {
                "ref": "refs/heads/main",
                "pusher": {"name": "release-smoke"},
                "repository": {"full_name": "example/paracord"},
                "commits": [
                    {
                        "id": "0123456789abcdef",
                        "message": "release smoke",
                        "url": "https://example.invalid/commit/0123456",
                    }
                ],
                "sender": {"login": "release-smoke"},
            }
            github_body = json.dumps(github_payload, separators=(",", ":")).encode("utf-8")
            invalid = requests.post(
                f"{base_url}/api/v1/webhooks/{webhook_id}/{webhook_token}",
                headers={
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "push",
                    "X-Hub-Signature-256": "sha256=bad",
                },
                data=github_body,
                timeout=20,
            )
            assert_status(invalid, 401, "reject invalid GitHub webhook signature")
            digest = hmac.new(github_secret.encode("utf-8"), github_body, hashlib.sha256).hexdigest()
            valid = requests.post(
                f"{base_url}/api/v1/webhooks/{webhook_id}/{webhook_token}",
                headers={
                    "Content-Type": "application/json",
                    "X-GitHub-Event": "push",
                    "X-Hub-Signature-256": f"sha256={digest}",
                },
                data=github_body,
                timeout=20,
            )
            assert_status(valid, 201, "accept valid GitHub webhook signature")
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/webhooks/{webhook_id}/{webhook_token}/messages/{webhook_message_id}",
                expected=(200, 204),
                label="delete webhook message",
            )

            dm = request_json(
                "POST",
                base_url,
                "/api/v1/users/@me/dms",
                token=admin_token,
                body={"recipient_id": user_id},
                expected=(200, 201),
                label="create dm",
            )
            if "id" not in dm:
                raise AssertionError(f"DM id missing: {dm}")
            request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{dm['id']}/messages",
                token=admin_token,
                body={"content": "plaintext dm should be rejected"},
                expected=400,
                label="reject plaintext dm",
            )
            dm_e2ee = {
                "version": 2,
                "nonce": "AAAAAAAAAAAAAAAA",
                "ciphertext": "ZW5jcnlwdGVkLWRtLXBheWxvYWQ=",
                "header": json.dumps({"type": "signal-v2", "session": "release-smoke"}),
            }
            encrypted_dm = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{dm['id']}/messages",
                token=admin_token,
                body={"content": "", "e2ee": dm_e2ee},
                expected=201,
                label="send encrypted dm",
            )
            if encrypted_dm.get("content") not in (None, ""):
                raise AssertionError(f"encrypted DM leaked content: {encrypted_dm}")
            encrypted_payload = encrypted_dm.get("e2ee") or {}
            for key in ("version", "nonce", "ciphertext", "header"):
                if encrypted_payload.get(key) != dm_e2ee[key]:
                    raise AssertionError(f"encrypted DM {key} mismatch: {encrypted_dm}")
            dm_messages = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{dm['id']}/messages",
                token=user_token,
                label="recipient lists encrypted dm",
            )
            if not any(message.get("id") == encrypted_dm["id"] for message in dm_messages):
                raise AssertionError(f"encrypted DM missing from recipient message list: {dm_messages}")
            group_dm = request_json(
                "POST",
                base_url,
                "/api/v1/users/@me/channels",
                token=admin_token,
                body={"recipient_ids": [user_id, third_user_id], "name": "Release Smoke Group"},
                expected=201,
                label="create group dm",
            )
            group_recipients = request_json(
                "GET",
                base_url,
                f"/api/v1/channels/{group_dm['id']}/recipients",
                token=admin_token,
                label="list group dm recipients",
            )
            recipient_ids = {recipient["id"] for recipient in group_recipients}
            if not {str(user_id), str(third_user_id)}.issubset(recipient_ids):
                raise AssertionError(f"group DM recipients missing: {group_recipients}")

            print("PASS: release server product API smoke passed")
            print(
                " ".join(
                    [
                        f"guild={guild_id}",
                        f"text={text_id}",
                        f"voice={channels['voice']['id']}",
                        f"announcement={channels['announcement']['id']}",
                        f"forum={channels['forum']['id']}",
                        f"role={role['id']}",
                    ]
                )
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
    parser.add_argument("--port", type=int, default=18096)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
