#!/usr/bin/env python3
"""Release-binary scheduled events lifecycle smoke test.

Starts `target/release/paracord-server` with a temporary SQLite database and
validates scheduled-event permissions, validation, worker lifecycle, event
channel cleanup, recurrence creation, RSVP, iCal export, and deletion.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import tempfile
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def iso_after(seconds: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(seconds=seconds)).isoformat().replace(
        "+00:00", "Z"
    )


def assert_status(response: requests.Response, expected: int | tuple[int, ...], label: str) -> None:
    ok = response.status_code in expected if isinstance(expected, tuple) else response.status_code == expected
    if not ok:
        raise AssertionError(
            f"{label}: expected {expected}, got {response.status_code}: {response.text[:500]}"
        )


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


def wait_for_event(
    base_url: str,
    guild_id: str,
    event_id: str,
    token: str,
    *,
    status: int | None = None,
    channel_created: bool | None = None,
    reminder_sent: bool | None = None,
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
            label=f"poll event {event_id}",
        )
        if (
            (status is None or last_event.get("status") == status)
            and (
                channel_created is None
                or bool(last_event.get("event_channel_created")) == channel_created
            )
            and (
                reminder_sent is None
                or bool(last_event.get("reminder_sent_at")) == reminder_sent
            )
        ):
            return last_event
        time.sleep(1.0)
    raise AssertionError(f"timed out waiting for event {event_id}: {last_event}")


def wait_for_recurring_successor(
    base_url: str,
    guild_id: str,
    original_event_id: str,
    token: str,
    *,
    timeout_seconds: float = 45.0,
) -> Any:
    deadline = time.time() + timeout_seconds
    last_events: Any = None
    while time.time() < deadline:
        last_events = request_json(
            "GET",
            base_url,
            f"/api/v1/guilds/{guild_id}/events",
            token=token,
            label="poll recurring successor",
        )
        for event in last_events:
            if (
                event.get("id") != original_event_id
                and event.get("name") == "Lifecycle recurring event"
                and event.get("recurrence_rule") == "daily"
                and event.get("status") == 1
            ):
                return event
        time.sleep(1.0)
    raise AssertionError(f"timed out waiting for recurring successor: {last_events}")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(
        prefix="paracord-events-lifecycle-smoke-", ignore_cleanup_errors=True
    ) as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-events-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "false",
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

            admin = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "event-admin@example.com",
                    "username": "eventadmin",
                    "password": "Adminpass123!",
                },
                expected=201,
                label="register admin",
            )
            member = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "event-member@example.com",
                    "username": "eventmember",
                    "password": "Memberpass123!",
                },
                expected=201,
                label="register member",
            )
            admin_token = admin["token"]
            member_token = member["token"]

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=admin_token,
                body={"name": "Events Lifecycle Guild", "icon": None},
                expected=201,
                label="create guild",
            )
            guild_id = guild["id"]
            channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                body={
                    "name": "events-general",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
                label="create text channel",
            )
            channel_id = channel["id"]

            invite = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel_id}/invites",
                token=admin_token,
                body={"max_uses": 1, "max_age": 3600},
                expected=201,
                label="create invite",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/invites/{invite['code']}",
                token=member_token,
                body={},
                label="accept invite",
            )

            valid_start = iso_after(120)
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=member_token,
                body={
                    "name": "Member forbidden event",
                    "scheduled_start": valid_start,
                    "entity_type": 1,
                    "channel_id": channel_id,
                },
                expected=403,
                label="member cannot create event",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "<script>alert(1)</script>",
                    "scheduled_start": valid_start,
                    "entity_type": 1,
                    "channel_id": channel_id,
                },
                expected=400,
                label="reject unsafe event name",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Unsafe location event",
                    "scheduled_start": valid_start,
                    "entity_type": 1,
                    "channel_id": channel_id,
                    "location": "javascript:alert(1)",
                },
                expected=400,
                label="reject unsafe event location",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Bad recurrence event",
                    "scheduled_start": valid_start,
                    "entity_type": 1,
                    "channel_id": channel_id,
                    "recurrence_rule": "hourly",
                },
                expected=400,
                label="reject invalid recurrence",
            )
            request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Bad reminder event",
                    "scheduled_start": valid_start,
                    "entity_type": 1,
                    "channel_id": channel_id,
                    "reminder_minutes": 0,
                },
                expected=400,
                label="reject invalid reminder",
            )

            recurring = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Lifecycle recurring event",
                    "description": "Lifecycle event body",
                    "scheduled_start": iso_after(35),
                    "scheduled_end": iso_after(65),
                    "entity_type": 1,
                    "channel_id": channel_id,
                    "location": "Lifecycle venue",
                    "recurrence_rule": "daily",
                    "reminder_minutes": 1,
                },
                expected=201,
                label="create recurring event",
            )
            event_id = recurring["id"]

            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=member_token,
                body={"description": "member edit"},
                expected=403,
                label="member cannot update event",
            )
            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=admin_token,
                body={"description": "<iframe src=x></iframe>"},
                expected=400,
                label="reject unsafe update description",
            )
            request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=admin_token,
                body={"location": "onload=alert(1)"},
                expected=400,
                label="reject unsafe update location",
            )

            request_json(
                "PUT",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}/rsvp",
                token=member_token,
                expected=204,
                label="member RSVP",
            )
            rsvp_event = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}",
                token=member_token,
                label="get RSVP event",
            )
            if rsvp_event.get("user_count") != 1 or rsvp_event.get("user_rsvp") is not True:
                raise AssertionError(f"RSVP response mismatch: {rsvp_event}")

            ical = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{event_id}/ical",
                token=member_token,
                label="export event ical",
            )
            if "BEGIN:VEVENT" not in ical or "RRULE:FREQ=DAILY" not in ical:
                raise AssertionError(f"iCal missing recurring event content: {ical[:500]}")

            started = wait_for_event(
                base_url,
                guild_id,
                event_id,
                admin_token,
                status=2,
                channel_created=True,
                reminder_sent=True,
                timeout_seconds=75.0,
            )
            event_channel_id = started.get("event_channel_id")
            if not event_channel_id:
                raise AssertionError(f"event did not expose auto-created channel: {started}")

            ended = wait_for_event(
                base_url,
                guild_id,
                event_id,
                admin_token,
                status=3,
                timeout_seconds=75.0,
            )
            if ended.get("status") != 3:
                raise AssertionError(f"event did not complete: {ended}")

            channels = request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/channels",
                token=admin_token,
                label="list channels after event completion",
            )
            if any(item.get("id") == event_channel_id for item in channels):
                raise AssertionError(f"auto-created event channel was not deleted: {channels}")

            successor = wait_for_recurring_successor(
                base_url,
                guild_id,
                event_id,
                admin_token,
                timeout_seconds=45.0,
            )
            if successor.get("scheduled_start") <= recurring.get("scheduled_start"):
                raise AssertionError(f"recurring successor did not advance start time: {successor}")

            one_off = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild_id}/events",
                token=admin_token,
                body={
                    "name": "Lifecycle one-off event",
                    "scheduled_start": iso_after(3600),
                    "entity_type": 1,
                    "channel_id": channel_id,
                },
                expected=201,
                label="create one-off event",
            )
            canceled = request_json(
                "PATCH",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{one_off['id']}",
                token=admin_token,
                body={"status": 4},
                label="cancel one-off event",
            )
            if canceled.get("status") != 4:
                raise AssertionError(f"event cancellation mismatch: {canceled}")
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{one_off['id']}",
                token=member_token,
                expected=403,
                label="member cannot delete event",
            )
            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{one_off['id']}",
                token=admin_token,
                expected=204,
                label="delete one-off event",
            )
            request_json(
                "GET",
                base_url,
                f"/api/v1/guilds/{guild_id}/events/{one_off['id']}",
                token=admin_token,
                expected=404,
                label="deleted event is gone",
            )
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release paracord-server binary")
    parser.add_argument("--port", type=int, default=18137)
    args = parser.parse_args()
    run_smoke(args)
    print("PASS release scheduled events lifecycle smoke")


if __name__ == "__main__":
    main()
