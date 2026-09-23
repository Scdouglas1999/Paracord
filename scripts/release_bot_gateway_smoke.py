#!/usr/bin/env python3
"""Real bot/user gateway and interaction lifecycle on disposable SQLite or PostgreSQL."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
import uuid

import requests
import websocket

from release_gateway_resume_smoke import connect_gateway, stop_server
from release_product_smoke import release_server_path, wait_for_health


def receive_event(ws, event_type, *, forbidden=None):
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        frame = json.loads(ws.recv())
        if frame.get("t") == forbidden:
            raise AssertionError(f"forbidden gateway event: {forbidden}")
        if frame.get("t") == event_type:
            return frame
    raise AssertionError(f"missing gateway event: {event_type}")


def expect_auth_close(ws):
    ws.send(json.dumps({"op": 1, "d": None}))
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        opcode, frame = ws.recv_data(control_frame=True)
        if opcode == websocket.ABNF.OPCODE_CLOSE:
            assert int.from_bytes(frame[:2], "big") == 4004, frame
            return
        if opcode == websocket.ABNF.OPCODE_TEXT:
            assert json.loads(frame).get("op") != 11, "revoked credential received heartbeat ACK"
    raise AssertionError("revoked bot gateway remained open")


def run(args):
    server = (Path(args.server) if args.server else release_server_path()).resolve()
    admin = None
    database = None
    sockets = []
    with tempfile.TemporaryDirectory(prefix="paracord-bot-gateway-") as directory:
        data = Path(directory)
        engine = "postgres" if args.postgres else "sqlite"
        url = f"sqlite://{data / 'paracord.db'}?mode=rwc"
        if args.postgres:
            import psycopg2
            source = os.environ["PARACORD_TEST_POSTGRES_URL"]
            parts = urlsplit(source)
            database = "release_bot_" + uuid.uuid4().hex[:16]
            admin = psycopg2.connect(source)
            admin.autocommit = True
            with admin.cursor() as cursor:
                cursor.execute(f'CREATE DATABASE "{database}"')
            url = urlunsplit((parts.scheme, parts.netloc, "/" + database, parts.query, parts.fragment))
        env = {k: v for k, v in os.environ.items() if not k.startswith("PARACORD_")}
        env.update(PARACORD_BIND_ADDRESS=f"127.0.0.1:{args.port}", PARACORD_DATABASE_ENGINE=engine,
                   PARACORD_DATABASE_URL=url, PARACORD_JWT_SECRET="bot-gateway-fixture-only-0123456789abcdef",
                   PARACORD_TLS_ENABLED="false", PARACORD_SETUP_REQUIRE_CLAIM="false",
                   PARACORD_AUTH_REQUIRE_EMAIL="true", PARACORD_REGISTRATION_ENABLED="true", PARACORD_REGISTRATION_MODE="open",
                   PARACORD_STORAGE_PATH=str(data / "uploads"), PARACORD_MEDIA_STORAGE_PATH=str(data / "files"),
                   PARACORD_BACKUP_DIR=str(data / "backups"), PARACORD_VOICE_PORT=str(args.port + 1000),
                   PARACORD_LOG_ANSI="false")
        base = f"http://127.0.0.1:{args.port}"
        proc = None

        def call(method, path, token=None, body=None, expected=200, bot=False):
            headers = {"Authorization": ("Bot " if bot else "Bearer ") + token} if token else {}
            response = requests.request(method, base + path, headers=headers, json=body, timeout=15)
            assert response.status_code == expected, f"{method} {path.split('/interactions/')[0]}: {response.status_code} {response.text[:200]}"
            return response.json() if response.text else None

        def gateway(token):
            ws = connect_gateway(f"ws://127.0.0.1:{args.port}/gateway")
            sockets.append(ws)
            ws.send(json.dumps({"op": 2, "d": {"token": token}}))
            ready = receive_event(ws, "READY")
            return ws, ready

        try:
            proc = subprocess.Popen([str(server), "-c", str(data / "paracord.toml")], cwd=data, env=env,
                                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            wait_for_health(base, proc)
            owner = call("POST", "/api/v1/auth/register", body={"email":"botowner@example.test", "username":"botowner", "password":"BotGateway123!"}, expected=201)["token"]
            guild = call("POST", "/api/v1/guilds", owner, {"name":"Bot lifecycle"}, 201)["id"]
            other = call("POST", "/api/v1/guilds", owner, {"name":"Not installed"}, 201)["id"]
            channel = call("POST", f"/api/v1/guilds/{guild}/channels", owner, {"name":"bot-commands", "channel_type":0}, 201)["id"]
            app = call("POST", "/api/v1/bots/applications", owner, {"name":"LifecycleBot", "permissions":"68608"}, 201)
            aid, bid, token = app["id"], app["bot_user_id"], app["token"]
            grant = call("POST", "/api/v1/oauth2/authorize", owner, {"application_id":aid, "guild_id":guild, "permissions":"3072"})
            assert grant["permissions"] == "3072"
            bot_ws, ready = gateway("Bot " + token)
            assert ready["d"]["user"]["id"] == bid
            assert {g["id"] for g in ready["d"]["guilds"]} == {guild}, other
            human_ws, _ = gateway(owner)
            call("POST", f"/api/v1/guilds/{guild}/roles", token, {"name":"forbidden", "permissions":"8"}, 403, bot=True)
            command = call("POST", f"/api/v1/applications/{aid}/commands", owner, {"name":"lifecycle", "description":"Lifecycle test"}, 201)
            invoked = call("POST", "/api/v1/interactions", owner, {"type":2, "command_name":command["name"], "guild_id":guild, "channel_id":channel, "options":[]}, 201)
            assert "token" not in invoked
            interaction = receive_event(bot_ws, "INTERACTION_CREATE")["d"]
            assert interaction["id"] == invoked["id"]
            secret = interaction["token"]
            response = call("POST", f"/api/v1/interactions/{interaction['id']}/{secret}/callback", body={"type":4, "data":{"content":"Bot initial", "components":[{"type":1, "components":[{"type":2, "style":1, "label":"Continue", "custom_id":"continue"}]}]}})
            assert response["author_id"] == bid
            receive_event(human_ws, "MESSAGE_CREATE", forbidden="INTERACTION_CREATE")
            clicked = call("POST", "/api/v1/interactions", owner, {"type":3, "guild_id":guild, "channel_id":channel, "message_id":response["id"], "custom_id":"continue", "component_type":2}, 201)
            assert "token" not in clicked
            component = receive_event(bot_ws, "INTERACTION_CREATE")["d"]
            assert component["type"] == 3 and component["data"]["custom_id"] == "continue"
            call("POST", f"/api/v1/interactions/{component['id']}/{component['token']}/callback", body={"type":7, "data":{"content":"Button handled"}})
            followup = call("POST", f"/api/v1/interactions/{aid}/{secret}/followup", body={"content":"Bot followup"}, expected=201)
            assert followup["author_id"] == bid
            edited = call("PATCH", f"/api/v1/interactions/{aid}/{secret}/messages/@original", body={"content":"Bot edited"})
            assert edited["content"] == "Bot edited"
            history = call("GET", f"/api/v1/channels/{channel}/messages", owner)
            assert {m["content"] for m in history}.issuperset({"Bot edited", "Bot followup"})
            call("DELETE", f"/api/v1/interactions/{aid}/{secret}/messages/@original", expected=204)
            assert all(m["id"] != response["id"] for m in call("GET", f"/api/v1/channels/{channel}/messages", owner))
            rotated = call("POST", f"/api/v1/bots/applications/{aid}/token", owner)["token"]
            expect_auth_close(bot_ws)
            call("GET", "/api/v1/users/@me", token, expected=401, bot=True)
            bot_ws, ready = gateway(rotated)
            assert ready["d"]["user"]["id"] == bid
            call("DELETE", f"/api/v1/guilds/{guild}/bots/{aid}", owner, expected=204)
            call("POST", f"/api/v1/interactions/{aid}/{secret}/followup", body={"content":"after uninstall"}, expected=403)
            _, ready = gateway(rotated)
            assert not ready["d"]["guilds"], "uninstalled bot retained guild scope"
            call("DELETE", f"/api/v1/bots/applications/{aid}", owner, expected=204)
            expect_auth_close(bot_ws)
            print(f"PASS {engine}: real bot/user gateway; install-limited READY; role escalation denied; private interaction token delivery; slash callback, component update, followup, edit/delete persisted; token rotation and uninstall/application deletion enforced")
        finally:
            for ws in sockets:
                ws.close()
            if proc:
                stop_server(proc)
            if admin:
                with admin.cursor() as cursor:
                    cursor.execute(f'DROP DATABASE IF EXISTS "{database}" WITH (FORCE)')
                admin.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server")
    parser.add_argument("--port", type=int, default=18221)
    parser.add_argument("--postgres", action="store_true")
    run(parser.parse_args())
