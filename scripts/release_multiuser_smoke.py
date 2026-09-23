#!/usr/bin/env python3
"""Simultaneous real HTTP/gateway users against a disposable server.

SQLite is the default. --postgres uses PARACORD_TEST_POSTGRES_URL only to
create/drop a uniquely named fixture database. No application responses are
mocked. This checks API/gateway behavior, not browser rendering or media frames.
"""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
import uuid

import websocket

from release_gateway_resume_smoke import connect_gateway, identify, stop_server
from release_product_smoke import release_server_path, request_json, wait_for_health


def collect_messages(ws: websocket.WebSocket, ids: set[str], *, timeout: float = 10,
                     forbidden: set[str] | None = None) -> None:
    seen: list[str] = []
    deadline = time.monotonic() + timeout
    while set(seen) != ids and time.monotonic() < deadline:
        event = json.loads(ws.recv())
        if event.get("t") == "MESSAGE_CREATE" and event["d"].get("id") in (forbidden or set()):
            raise AssertionError("gateway delivered a forbidden message before the delivery barrier")
        if event.get("t") == "MESSAGE_CREATE" and event["d"].get("id") in ids:
            seen.append(event["d"]["id"])
    if set(seen) != ids or len(seen) != len(ids):
        raise AssertionError(f"gateway delivery mismatch: expected {len(ids)}, got {len(seen)}")


def assert_no_message(ws: websocket.WebSocket, message_id: str) -> None:
    deadline = time.monotonic() + 0.5
    ws.settimeout(0.5)
    try:
        while time.monotonic() < deadline:
            try:
                event = json.loads(ws.recv())
            except websocket.WebSocketTimeoutException:
                break
            if event.get("t") == "MESSAGE_CREATE" and event["d"].get("id") == message_id:
                raise AssertionError("gateway delivered a message after permission revocation")
    finally:
        ws.settimeout(5)


def run_smoke(args: argparse.Namespace) -> None:
    server = (Path(args.server) if args.server else release_server_path()).resolve()
    if not server.is_file():
        raise FileNotFoundError(server)
    admin = None
    database_name = None
    with tempfile.TemporaryDirectory(prefix="paracord-multiuser-") as directory:
        data = Path(directory)
        engine = "postgres" if args.postgres else "sqlite"
        database_url = f"sqlite://{data / 'paracord.db'}?mode=rwc"
        if args.postgres:
            import psycopg2

            base = os.environ.get("PARACORD_TEST_POSTGRES_URL", "")
            if not base:
                raise RuntimeError("--postgres requires PARACORD_TEST_POSTGRES_URL")
            database_name = "release_multiuser_" + uuid.uuid4().hex[:16]
            parts = urlsplit(base)
            database_url = urlunsplit((parts.scheme, parts.netloc, "/" + database_name, parts.query, parts.fragment))
            admin = psycopg2.connect(base)
            admin.autocommit = True
            with admin.cursor() as cursor:
                cursor.execute(f'CREATE DATABASE "{database_name}"')

        proc = None
        clients: list[websocket.WebSocket] = []
        env = {key: value for key, value in os.environ.items() if not key.startswith("PARACORD_")}
        env.update(
            PARACORD_BIND_ADDRESS=f"127.0.0.1:{args.port}",
            PARACORD_DATABASE_ENGINE=engine,
            PARACORD_DATABASE_URL=database_url,
            PARACORD_JWT_SECRET="multiuser-release-fixture-only-0123456789abcdef",
            PARACORD_TLS_ENABLED="false",
            PARACORD_STORAGE_PATH=str(data / "uploads"),
            PARACORD_MEDIA_STORAGE_PATH=str(data / "files"),
            PARACORD_BACKUP_DIR=str(data / "backups"),
            PARACORD_SETUP_REQUIRE_CLAIM="false",
            PARACORD_AUTH_REQUIRE_EMAIL="true",
            PARACORD_REGISTRATION_ENABLED="true", PARACORD_REGISTRATION_MODE="open",
            PARACORD_VOICE_PORT=str(args.port + 1000),
            PARACORD_LOG_ANSI="false",
        )
        base_url = f"http://127.0.0.1:{args.port}"

        def call(method: str, path: str, user=None, body=None, expected=200):
            return request_json(method, base_url, path, token=user["token"] if user else None,
                                body=body, expected=expected, label=f"{method} {path}")

        try:
            proc = subprocess.Popen([str(server), "-c", str(data / "paracord.toml")], cwd=data,
                                    env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_for_health(base_url, proc)
            users = [call("POST", "/api/v1/auth/register", body={
                "email": f"multi{i}@example.test", "username": f"multiuser{i}", "password": "Multiuser123!",
            }, expected=201) for i in range(7)]
            owner, members, outsider = users[0], users[:6], users[6]
            guild = call("POST", "/api/v1/guilds", owner, {"name": "Concurrent sessions"}, 201)
            gid = guild["id"]
            channel = call("POST", f"/api/v1/guilds/{gid}/channels", owner,
                           {"name": "concurrent-chat", "channel_type": 0}, 201)
            cid = channel["id"]
            invite = call("POST", f"/api/v1/channels/{cid}/invites", owner,
                          {"max_uses": 8, "max_age": 3600}, 201)
            with ThreadPoolExecutor(max_workers=6) as pool:
                list(pool.map(lambda _: call("POST", f"/api/v1/invites/{invite['code']}", members[1], {}), range(6)))
                list(pool.map(lambda user: call("POST", f"/api/v1/invites/{invite['code']}", user, {}), members[2:]))
            listed_invite = next(item for item in call("GET", f"/api/v1/guilds/{gid}/invites", owner)
                                 if item["code"] == invite["code"])
            assert listed_invite["uses"] == 5, listed_invite
            call("GET", f"/api/v1/channels/{cid}/messages", outsider, expected=(403, 404))
            for user in users:
                ws = connect_gateway(f"ws://127.0.0.1:{args.port}/gateway")
                clients.append(ws)
                identify(ws, user["token"])

            with ThreadPoolExecutor(max_workers=6) as pool:
                def send(index):
                    return call("POST", f"/api/v1/channels/{cid}/messages", members[index % 6],
                                {"content": f"simultaneous message {index}"}, 201)
                sent = list(pool.map(send, range(18)))
                ids = {message["id"] for message in sent}
                assert len(ids) == 18
                list(pool.map(lambda ws: collect_messages(ws, ids), clients[:6]))
            assert_no_message(clients[6], sent[-1]["id"])
            for member in members:
                history = call("GET", f"/api/v1/channels/{cid}/messages", member)
                assert {message["id"] for message in history}.issuperset(ids)

            poll = call("POST", f"/api/v1/channels/{cid}/polls", owner, {
                "question": "Concurrent votes?", "options": [{"text": "Yes"}, {"text": "No"}],
                "allow_multiselect": False, "expires_in_minutes": 60,
            }, 201)["poll"]
            poll_path = f"/api/v1/channels/{cid}/polls/{poll['id']}"
            option = call("GET", poll_path, owner)["options"][0]["id"]
            with ThreadPoolExecutor(max_workers=6) as pool:
                list(pool.map(lambda user: call("PUT", f"{poll_path}/votes/{option}", user), members))
                list(pool.map(lambda user: call("PUT", f"/api/v1/channels/{cid}/messages/{sent[0]['id']}/reactions/%F0%9F%91%8D/@me", user, expected=204), members))
            counted = call("GET", poll_path, owner)
            assert counted["total_votes"] == 6, counted
            history = call("GET", f"/api/v1/channels/{cid}/messages", owner)
            reacted = next(message for message in history if message["id"] == sent[0]["id"])
            reaction = next(item for item in reacted["reactions"] if item["emoji"] == "👍")
            assert reaction["count"] == 6 and reaction["me"] is True, reaction

            private = call("POST", f"/api/v1/guilds/{gid}/channels", owner,
                           {"name": "revocation-check", "channel_type": 0}, 201)
            private_id = private["id"]
            call("PUT", f"/api/v1/channels/{private_id}/overwrites/{gid}", owner,
                 {"target_type": 0, "allow_perms": 0, "deny_perms": 1024}, 204)
            uid = members[1]["user"]["id"]
            call("PUT", f"/api/v1/channels/{private_id}/overwrites/{uid}", owner,
                 {"target_type": 1, "allow_perms": 68608, "deny_perms": 0}, 204)
            call("GET", f"/api/v1/channels/{private_id}/messages", members[1])
            before = call("POST", f"/api/v1/channels/{private_id}/messages", owner, {"content": "visible before revocation"}, 201)
            collect_messages(clients[1], {before["id"]})
            call("PUT", f"/api/v1/channels/{private_id}/overwrites/{uid}", owner,
                 {"target_type": 1, "allow_perms": 0, "deny_perms": 1024}, 204)
            call("GET", f"/api/v1/channels/{private_id}/messages", members[1], expected=(403, 404))
            after = call("POST", f"/api/v1/channels/{private_id}/messages", owner, {"content": "hidden after revocation"}, 201)
            barrier = call("POST", f"/api/v1/channels/{cid}/messages", owner, {"content": "delivery barrier"}, 201)
            collect_messages(clients[1], {barrier["id"]}, forbidden={after["id"]})
            assert_no_message(clients[1], after["id"])
            assert_no_message(clients[6], after["id"])
            print(f"PASS {engine}: 7 authenticated gateway clients; 6 members send 18 simultaneous messages with 108 verified deliveries; outsider denied; duplicate invite accepts consume once; 6 simultaneous votes/reactions; private channel revoke blocks REST and live delivery", flush=True)
        finally:
            for client in clients:
                client.close()
            if proc is not None:
                stop_server(proc)
            if admin is not None:
                with admin.cursor() as cursor:
                    cursor.execute(f'DROP DATABASE IF EXISTS "{database_name}" WITH (FORCE)')
                admin.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server")
    parser.add_argument("--port", type=int, default=18220)
    parser.add_argument("--postgres", action="store_true")
    run_smoke(parser.parse_args())


if __name__ == "__main__":
    main()
