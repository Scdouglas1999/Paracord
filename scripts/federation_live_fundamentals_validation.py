#!/usr/bin/env python3
"""Live 3-node decentralized fundamentals validation.

This script boots three local Paracord nodes in a federated topology and runs
live end-to-end checks for:
  - federation relay and cross-node propagation (A -> B -> C, no direct A -> C)
  - realtime gateway events for core features
  - messages, DMs, threads, member list join/leave updates, emojis, polls,
    relationships/friends, user settings, and voice join/leave
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

import requests
import websocket


ROOT = Path(__file__).resolve().parents[1]
RUN_ID = f"fed-live-{int(time.time())}-{os.getpid()}"
BASE_DIR = ROOT / "data" / RUN_ID
KEYS_DIR = BASE_DIR / "keys"
LOGS_DIR = BASE_DIR / "logs"
BINARY = ROOT / "target" / "debug" / "paracord-server.exe"
PASSWORD = "Paracord!Federation!123"
LIVEKIT_PORT = 27880
LIVEKIT_KEY = "fed-livekit-shared-key"
LIVEKIT_SECRET = "fed-livekit-shared-secret-0123456789abcdef"
LIVEKIT_BINARY_NAME = "livekit-server.exe"
LIVEKIT_BINARY_TARGET = ROOT / LIVEKIT_BINARY_NAME

# 1x1 transparent PNG
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+q5sAAAAASUVORK5CYII="
)


@dataclass(frozen=True)
class Node:
    key: str
    port: int
    server_name: str

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    @property
    def fed_endpoint(self) -> str:
        return f"{self.url}/_paracord/federation/v1"

    @property
    def gateway_url(self) -> str:
        return f"ws://127.0.0.1:{self.port}/gateway"


NODES = {
    "a": Node("a", 19081, "node-a.test"),
    "b": Node("b", 19082, "node-b.test"),
    "c": Node("c", 19083, "node-c.test"),
}


def log(msg: str) -> None:
    print(msg, flush=True)


def run(cmd: list[str], cwd: Path | None = None) -> None:
    proc = subprocess.run(cmd, cwd=cwd, check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            f"Command failed ({proc.returncode}): {' '.join(cmd)}\n"
            f"stdout:\n{proc.stdout}\n"
            f"stderr:\n{proc.stderr}"
        )


def locate_livekit_binary() -> Path:
    candidates = [
        ROOT / LIVEKIT_BINARY_NAME,
        ROOT / "dist" / "paracord-server" / LIVEKIT_BINARY_NAME,
        ROOT / "dist" / "paracord-server-win-0.2.2" / LIVEKIT_BINARY_NAME,
        ROOT / "dist" / "verify-win" / LIVEKIT_BINARY_NAME,
        ROOT / "livekit-extracted" / LIVEKIT_BINARY_NAME,
        ROOT / "livekit-extracted-win" / LIVEKIT_BINARY_NAME,
        ROOT / "target" / "release" / LIVEKIT_BINARY_NAME,
        ROOT / "target-rebuild" / "release" / LIVEKIT_BINARY_NAME,
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise RuntimeError(
        "LiveKit binary not found; voice join/leave live validation requires livekit-server.exe"
    )


def ensure_livekit_binary() -> Path:
    """Ensure the LiveKit binary is discoverable by `which` for child servers."""
    src = locate_livekit_binary().resolve()
    parent = str(src.parent)
    path_entries = os.environ.get("PATH", "").split(os.pathsep)
    if parent not in path_entries:
        os.environ["PATH"] = parent + os.pathsep + os.environ.get("PATH", "")
    return src


def write_config(node: Node) -> Path:
    node_dir = BASE_DIR / node.key
    for path in (node_dir / "uploads", node_dir / "files", node_dir / "backups"):
        path.mkdir(parents=True, exist_ok=True)

    base_rel = BASE_DIR.relative_to(ROOT).as_posix()
    key_file = KEYS_DIR / f"{node.key}.hex"
    cfg = f"""
[server]
bind_address = "127.0.0.1:{node.port}"
server_name = "{node.server_name}"

[tls]
enabled = false
port = {node.port + 1000}

[database]
url = "sqlite://./{base_rel}/{node.key}/paracord.db?mode=rwc"
max_connections = 5

[auth]
jwt_secret = "fed-live-jwt-secret-{node.key}-0123456789abcdef"
jwt_expiry_seconds = 3600
registration_enabled = true

[storage]
storage_type = "local"
path = "./{base_rel}/{node.key}/uploads"
max_upload_size = 52428800

[media]
storage_path = "./{base_rel}/{node.key}/files"
max_file_size = 10485760
p2p_threshold = 10485760

[livekit]
api_key = "{LIVEKIT_KEY}"
api_secret = "{LIVEKIT_SECRET}"
url = "ws://127.0.0.1:{LIVEKIT_PORT}"
http_url = "http://127.0.0.1:{LIVEKIT_PORT}"

[federation]
enabled = true
domain = "{node.server_name}"
signing_key_path = "{key_file.as_posix()}"
allow_discovery = true

[network]
windows_firewall_auto_allow = false

[retention]
enabled = false
interval_seconds = 3600
batch_size = 256

[backup]
backup_dir = "./{base_rel}/{node.key}/backups"
auto_backup_enabled = false
auto_backup_interval_seconds = 86400
include_media = false
max_backups = 3
""".strip() + "\n"
    cfg_path = BASE_DIR / f"{node.key}.toml"
    cfg_path.write_text(cfg, encoding="utf-8")
    return cfg_path


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    token: str | None = None,
    expected: tuple[int, ...] = (200, 201, 202, 204),
) -> tuple[int, dict[str, Any]]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    resp = requests.request(method, url, json=payload, headers=headers, timeout=15)
    if resp.status_code not in expected:
        raise RuntimeError(
            f"{method} {url} unexpected status {resp.status_code}: {resp.text.strip()}"
        )
    body = resp.text.strip()
    if not body:
        return resp.status_code, {}
    return resp.status_code, resp.json()


def request_multipart(
    url: str,
    token: str,
    data: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
    expected: tuple[int, ...] = (200, 201),
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    resp = requests.post(url, data=data, files=files, headers=headers, timeout=20)
    if resp.status_code not in expected:
        raise RuntimeError(f"POST {url} unexpected status {resp.status_code}: {resp.text.strip()}")
    if not resp.text.strip():
        return {}
    return resp.json()


def wait_until(desc: str, fn: Callable[[], bool], timeout_s: float = 30.0) -> None:
    deadline = time.time() + timeout_s
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            if fn():
                return
        except Exception as exc:
            last_error = exc
        time.sleep(0.4)
    if last_error:
        raise TimeoutError(f"Timed out waiting for: {desc} (last error: {last_error})")
    raise TimeoutError(f"Timed out waiting for: {desc}")


def db_connect(node_key: str) -> sqlite3.Connection:
    db_path = BASE_DIR / node_key / "paracord.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def insert_row(conn: sqlite3.Connection, table: str, row: dict[str, Any]) -> None:
    cols = list(row.keys())
    placeholders = ", ".join(["?"] * len(cols))
    sql = f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({placeholders})"
    conn.execute(sql, [row[c] for c in cols])


def clone_shared_guild_and_channels(
    guild_id: int,
    channel_ids: list[int],
    source_owner_user_id: int,
    target_owner_user_id: int,
    target_node_key: str,
) -> None:
    with db_connect("a") as src, db_connect(target_node_key) as dst:
        space = src.execute("SELECT * FROM spaces WHERE id = ?", (guild_id,)).fetchone()
        if not space:
            raise RuntimeError("Failed to locate source guild in node A database")
        space_data = dict(space)
        space_data["owner_id"] = target_owner_user_id
        insert_row(dst, "spaces", space_data)

        for channel_id in channel_ids:
            channel = src.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
            if not channel:
                raise RuntimeError(f"Missing source channel {channel_id}")
            insert_row(dst, "channels", dict(channel))

        roles = src.execute("SELECT * FROM roles WHERE space_id = ?", (guild_id,)).fetchall()
        for role in roles:
            insert_row(dst, "roles", dict(role))

        owner_member = src.execute(
            "SELECT * FROM members WHERE guild_id = ? AND user_id = ?",
            (guild_id, source_owner_user_id),
        ).fetchone()
        if owner_member:
            owner_member_data = dict(owner_member)
            owner_member_data["user_id"] = target_owner_user_id
            insert_row(dst, "members", owner_member_data)

        owner_member_roles = src.execute(
            """
            SELECT mr.user_id, mr.role_id
            FROM member_roles mr
            JOIN roles r ON r.id = mr.role_id
            WHERE mr.user_id = ? AND r.space_id = ?
            """,
            (source_owner_user_id, guild_id),
        ).fetchall()
        for role_row in owner_member_roles:
            role_data = dict(role_row)
            role_data["user_id"] = target_owner_user_id
            insert_row(dst, "member_roles", role_data)

        dst.commit()


def add_trusted_peer(admin_token: str, source: Node, peer: Node) -> None:
    payload = {
        "server_name": peer.server_name,
        "domain": peer.server_name,
        "federation_endpoint": peer.fed_endpoint,
        "trusted": True,
        "discover": True,
    }
    request_json(
        "POST",
        f"{source.url}/_paracord/federation/v1/servers",
        payload=payload,
        token=admin_token,
        expected=(201,),
    )


def parse_int_id(raw: Any, field: str) -> int:
    try:
        return int(str(raw))
    except Exception as exc:
        raise RuntimeError(f"Invalid {field}: {raw!r}") from exc


def mapped_message_content(node_key: str, origin_server: str, remote_message_id: int) -> str | None:
    with db_connect(node_key) as conn:
        row = conn.execute(
            """
            SELECT m.content
            FROM federation_message_map fm
            JOIN messages m ON m.id = fm.local_message_id
            WHERE fm.origin_server = ? AND fm.remote_message_id = ?
            LIMIT 1
            """,
            (origin_server, str(remote_message_id)),
        ).fetchone()
        return None if row is None else str(row["content"])


def mapped_message_absent(node_key: str, origin_server: str, remote_message_id: int) -> bool:
    return mapped_message_content(node_key, origin_server, remote_message_id) is None


def reaction_count(node_key: str, origin_server: str, remote_message_id: int, emoji: str) -> int:
    with db_connect(node_key) as conn:
        row = conn.execute(
            """
            SELECT COUNT(*)
            FROM reactions r
            JOIN federation_message_map fm ON fm.local_message_id = r.message_id
            WHERE fm.origin_server = ? AND fm.remote_message_id = ? AND r.emoji_name = ?
            """,
            (origin_server, str(remote_message_id), emoji),
        ).fetchone()
        return int(row[0])


def remote_member_present(node_key: str, remote_user_id: str, guild_id: int) -> bool:
    with db_connect(node_key) as conn:
        mapping = conn.execute(
            "SELECT local_user_id FROM federation_remote_users WHERE remote_user_id = ?",
            (remote_user_id,),
        ).fetchone()
        if mapping is None:
            return False
        row = conn.execute(
            "SELECT COUNT(*) FROM members WHERE user_id = ? AND guild_id = ?",
            (int(mapping["local_user_id"]), guild_id),
        ).fetchone()
        return int(row[0]) > 0


def remote_member_absent(node_key: str, remote_user_id: str, guild_id: int) -> bool:
    with db_connect(node_key) as conn:
        mapping = conn.execute(
            "SELECT local_user_id FROM federation_remote_users WHERE remote_user_id = ?",
            (remote_user_id,),
        ).fetchone()
        if mapping is None:
            return False
        row = conn.execute(
            "SELECT COUNT(*) FROM members WHERE user_id = ? AND guild_id = ?",
            (int(mapping["local_user_id"]), guild_id),
        ).fetchone()
        return int(row[0]) == 0


def latest_poll_id(channel_id: int) -> int:
    with db_connect("a") as conn:
        row = conn.execute(
            "SELECT id FROM polls WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1",
            (channel_id,),
        ).fetchone()
        if row is None:
            raise RuntimeError("No poll found after create_poll")
        return int(row["id"])


class GatewayClient:
    def __init__(self, name: str, url: str, token: str):
        self.name = name
        self.url = url
        self.token = token
        self.ws: websocket.WebSocket | None = None
        self.heartbeat_interval_s = 41.25
        self.last_heartbeat_at = 0.0
        self.backlog: list[dict[str, Any]] = []

    def connect(self) -> None:
        websocket.enableTrace(False)
        self.ws = websocket.create_connection(
            self.url,
            timeout=12,
            origin="http://localhost:1420",
        )
        hello = self._recv_json_blocking(12.0)
        if hello.get("op") != 10:
            raise RuntimeError(f"{self.name}: expected HELLO, got: {hello}")
        interval_ms = (
            hello.get("d", {}).get("heartbeat_interval", 41250)
            if isinstance(hello.get("d"), dict)
            else 41250
        )
        self.heartbeat_interval_s = max(1.0, float(interval_ms) / 1000.0)
        self.last_heartbeat_at = time.monotonic()

        self.send({"op": 2, "d": {"token": self.token}})
        self.wait_dispatch("READY", timeout_s=25.0)

    def close(self) -> None:
        if self.ws is not None:
            try:
                self.ws.close()
            except Exception:
                pass
            self.ws = None

    def send(self, payload: dict[str, Any]) -> None:
        if self.ws is None:
            raise RuntimeError(f"{self.name}: websocket not connected")
        self.ws.send(json.dumps(payload))

    def _recv_json_blocking(self, timeout_s: float) -> dict[str, Any]:
        if self.ws is None:
            raise RuntimeError(f"{self.name}: websocket not connected")
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            self._maybe_heartbeat()
            remaining = max(0.1, deadline - time.monotonic())
            self.ws.settimeout(min(0.7, remaining))
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                continue
            except websocket.WebSocketConnectionClosedException as exc:
                raise RuntimeError(f"{self.name}: websocket closed while waiting for event") from exc
            if raw is None:
                continue
            if isinstance(raw, bytes):
                raw = raw.decode("utf-8", errors="replace")
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if isinstance(msg, dict):
                return msg
        raise TimeoutError(f"{self.name}: timed out waiting for websocket payload")

    def _poll_once(self, timeout_s: float = 0.5) -> dict[str, Any] | None:
        if self.ws is None:
            raise RuntimeError(f"{self.name}: websocket not connected")
        self._maybe_heartbeat()
        self.ws.settimeout(timeout_s)
        try:
            raw = self.ws.recv()
        except websocket.WebSocketTimeoutException:
            return None
        except websocket.WebSocketConnectionClosedException as exc:
            raise RuntimeError(f"{self.name}: websocket closed unexpectedly") from exc
        if raw is None:
            return None
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        try:
            payload = json.loads(raw)
        except Exception:
            return None
        if isinstance(payload, dict):
            return payload
        return None

    def _maybe_heartbeat(self) -> None:
        if self.ws is None:
            return
        now = time.monotonic()
        if now - self.last_heartbeat_at >= self.heartbeat_interval_s * 0.9:
            try:
                self.send({"op": 1, "d": None})
            except Exception:
                return
            self.last_heartbeat_at = now

    def _find_in_backlog(
        self,
        event_type: str,
        predicate: Callable[[dict[str, Any]], bool] | None,
    ) -> dict[str, Any] | None:
        for idx, item in enumerate(self.backlog):
            if item.get("op") != 0 or item.get("t") != event_type:
                continue
            data = item.get("d")
            if isinstance(data, dict) and (predicate is None or predicate(data)):
                return self.backlog.pop(idx)
        return None

    def wait_dispatch(
        self,
        event_type: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
        timeout_s: float = 20.0,
    ) -> dict[str, Any]:
        cached = self._find_in_backlog(event_type, predicate)
        if cached is not None:
            return cached

        deadline = time.monotonic() + timeout_s
        seen: list[str] = []
        while time.monotonic() < deadline:
            msg = self._poll_once(0.5)
            if msg is None:
                continue
            if msg.get("op") == 0 and isinstance(msg.get("t"), str):
                t = str(msg.get("t"))
                seen.append(t)
                if len(seen) > 15:
                    seen = seen[-15:]
                data = msg.get("d")
                if t == event_type and isinstance(data, dict):
                    if predicate is None or predicate(data):
                        return msg
                self.backlog.append(msg)

        raise TimeoutError(
            f"{self.name}: timed out waiting for {event_type}; recently seen: {seen}"
        )


def assert_member_list_contains(
    members_json: list[dict[str, Any]], expected_user_id: int, should_exist: bool
) -> None:
    found = any(str(m.get("user_id")) == str(expected_user_id) for m in members_json)
    if found != should_exist:
        raise AssertionError(
            f"Member list assertion failed for user={expected_user_id} should_exist={should_exist}"
        )


def main() -> int:
    procs: list[subprocess.Popen[str]] = []
    log_files: list[Any] = []
    gateway_clients: list[GatewayClient] = []
    try:
        log("[1/14] Preparing clean live federation workspace")
        if BASE_DIR.exists():
            shutil.rmtree(BASE_DIR)
        KEYS_DIR.mkdir(parents=True, exist_ok=True)
        LOGS_DIR.mkdir(parents=True, exist_ok=True)

        for node in NODES.values():
            key_hex = os.urandom(32).hex()
            (KEYS_DIR / f"{node.key}.hex").write_text(key_hex, encoding="utf-8")

        livekit_binary = ensure_livekit_binary()
        log(f"Using LiveKit binary: {livekit_binary}")
        child_env = os.environ.copy()
        # This script intentionally validates loopback-only local federation.
        # Production deployments should leave this unset so SSRF protections
        # continue blocking private/internal federation endpoints by default.
        child_env["PARACORD_ALLOW_PRIVATE_FEDERATION_URLS"] = "true"
        child_env["PARACORD_FEDERATION_ALLOWED_GUILD_IDS"] = "*"

        log("[2/14] Building paracord-server binary")
        run(["cargo", "build", "-p", "paracord-server"], cwd=ROOT)
        if not BINARY.exists():
            raise RuntimeError(f"Missing expected server binary: {BINARY}")

        cfg_paths = {k: write_config(v) for k, v in NODES.items()}

        log("[3/14] Starting three federation-enabled nodes (A, B, C)")
        for key, node in NODES.items():
            log_path = LOGS_DIR / f"{key}.log"
            fh = open(log_path, "w", encoding="utf-8")
            log_files.append(fh)
            proc = subprocess.Popen(
                [str(BINARY), "--config", str(cfg_paths[key])],
                cwd=ROOT,
                stdout=fh,
                stderr=subprocess.STDOUT,
                text=True,
                env=child_env,
            )
            procs.append(proc)

        for node in NODES.values():
            wait_until(
                f"{node.server_name} health",
                lambda n=node: request_json("GET", f"{n.url}/health")[0] == 200,
                timeout_s=120.0,
            )

        log("[4/14] Registering users")
        admin_tokens: dict[str, str] = {}
        admin_ids: dict[str, int] = {}
        for key, node in NODES.items():
            _, body = request_json(
                "POST",
                f"{node.url}/api/v1/auth/register",
                payload={
                    "email": f"admin-{key}@example.test",
                    "username": f"admin_{key}",
                    "password": PASSWORD,
                },
                expected=(201,),
            )
            admin_tokens[key] = str(body["token"])
            admin_ids[key] = parse_int_id(body["user"]["id"], f"admin {key} user id")

        # Register non-admin users on A before guild creation to avoid
        # auto-join side-effects for public spaces at registration time.
        _, guest1 = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/auth/register",
            payload={
                "email": "guest1@example.test",
                "username": "guest_one",
                "password": PASSWORD,
            },
            expected=(201,),
        )
        guest1_token = str(guest1["token"])
        guest1_id = parse_int_id(guest1["user"]["id"], "guest1 user id")

        _, guest2 = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/auth/register",
            payload={
                "email": "guest2@example.test",
                "username": "guest_two",
                "password": PASSWORD,
            },
            expected=(201,),
        )
        guest2_token = str(guest2["token"])
        guest2_id = parse_int_id(guest2["user"]["id"], "guest2 user id")

        log("[5/14] Opening gateway sessions for realtime assertions")
        guest2_ws = GatewayClient("guest2", NODES["a"].gateway_url, guest2_token)
        guest2_ws.connect()
        gateway_clients.append(guest2_ws)

        log("[6/14] Linking federation trust topology")
        add_trusted_peer(admin_tokens["a"], NODES["a"], NODES["b"])
        add_trusted_peer(admin_tokens["b"], NODES["b"], NODES["a"])
        add_trusted_peer(admin_tokens["b"], NODES["b"], NODES["c"])
        add_trusted_peer(admin_tokens["c"], NODES["c"], NODES["b"])
        add_trusted_peer(admin_tokens["c"], NODES["c"], NODES["a"])

        log("[7/14] Creating guild/channels and mirroring IDs to B/C")
        _, guild = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/guilds",
            payload={"name": "Federation Live Fundamentals Guild"},
            token=admin_tokens["a"],
            expected=(201,),
        )
        guild_id = parse_int_id(guild["id"], "guild id")

        _, channels = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/channels",
            token=admin_tokens["a"],
            expected=(200,),
        )
        text_channels = [c for c in channels if int(c.get("channel_type", 0)) == 0]
        if text_channels:
            text_channel_id = parse_int_id(text_channels[0]["id"], "text channel id")
        else:
            _, created_text = request_json(
                "POST",
                f"{NODES['a'].url}/api/v1/guilds/{guild_id}/channels",
                payload={"name": "general", "channel_type": 0},
                token=admin_tokens["a"],
                expected=(201,),
            )
            text_channel_id = parse_int_id(created_text["id"], "text channel id")

        _, created_voice = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/channels",
            payload={"name": "voice-room", "channel_type": 2},
            token=admin_tokens["a"],
            expected=(201,),
        )
        voice_channel_id = parse_int_id(created_voice["id"], "voice channel id")

        clone_shared_guild_and_channels(
            guild_id,
            [text_channel_id],
            source_owner_user_id=admin_ids["a"],
            target_owner_user_id=admin_ids["b"],
            target_node_key="b",
        )
        clone_shared_guild_and_channels(
            guild_id,
            [text_channel_id],
            source_owner_user_id=admin_ids["a"],
            target_owner_user_id=admin_ids["c"],
            target_node_key="c",
        )

        # Reconnect after guild creation so this session is subscribed to the
        # new guild and receives member/channel/message realtime events.
        admin_a_ws = GatewayClient("admin-a", NODES["a"].gateway_url, admin_tokens["a"])
        admin_a_ws.connect()
        gateway_clients.append(admin_a_ws)

        log("[8/14] Member join + realtime member list update + federation propagation")
        _, members_before = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/members",
            token=admin_tokens["a"],
            expected=(200,),
        )
        baseline_member_count = len(members_before)

        _, invite = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/invites",
            payload={},
            token=admin_tokens["a"],
            expected=(201,),
        )
        invite_code = str(invite["code"])

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/invites/{invite_code}",
            payload={},
            token=guest1_token,
            expected=(200,),
        )
        admin_a_ws.wait_dispatch(
            "GUILD_MEMBER_ADD",
            predicate=lambda d: d.get("guild_id") == str(guild_id)
            and d.get("user_id") == str(guest1_id),
            timeout_s=25.0,
        )

        _, members_after_join = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/members",
            token=admin_tokens["a"],
            expected=(200,),
        )
        assert len(members_after_join) == baseline_member_count + 1
        assert_member_list_contains(members_after_join, guest1_id, should_exist=True)

        # Connect guest1 after joining so READY includes the guild subscription.
        guest1_ws = GatewayClient("guest1", NODES["a"].gateway_url, guest1_token)
        guest1_ws.connect()
        gateway_clients.append(guest1_ws)

        log("[9/14] Message + reaction + relay topology checks")
        _, created_msg = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/messages",
            payload={"content": "federation live message", "attachment_ids": []},
            token=admin_tokens["a"],
            expected=(201,),
        )
        message_id = parse_int_id(created_msg["id"], "message id")
        origin_event_id = f"${message_id}:{NODES['a'].server_name}"

        guest1_ws.wait_dispatch(
            "MESSAGE_CREATE",
            predicate=lambda d: d.get("id") == str(message_id)
            and d.get("channel_id") == str(text_channel_id),
            timeout_s=20.0,
        )

        wait_until(
            "message replicated to B",
            lambda: mapped_message_content("b", NODES["a"].server_name, message_id)
            == "federation live message",
        )
        wait_until(
            "message replicated to C",
            lambda: mapped_message_content("c", NODES["a"].server_name, message_id)
            == "federation live message",
        )

        with db_connect("a") as a_db, db_connect("b") as b_db, db_connect("c") as c_db:
            a_to_c = a_db.execute(
                "SELECT COUNT(*) FROM federation_delivery_attempts WHERE event_id = ? AND destination_server = ?",
                (origin_event_id, NODES["c"].server_name),
            ).fetchone()[0]
            b_to_c = b_db.execute(
                "SELECT COUNT(*) FROM federation_delivery_attempts WHERE event_id = ? AND destination_server = ?",
                (origin_event_id, NODES["c"].server_name),
            ).fetchone()[0]
            c_has_event = c_db.execute(
                "SELECT COUNT(*) FROM federation_events WHERE event_id = ?",
                (origin_event_id,),
            ).fetchone()[0]
            if int(c_has_event) <= 0:
                raise AssertionError("C did not ingest A-origin event")
            if int(a_to_c) <= 0 and int(b_to_c) <= 0:
                raise AssertionError("No delivery attempt to C observed from A or B")

        request_json(
            "PATCH",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}",
            payload={"content": "federation live message edited"},
            token=admin_tokens["a"],
            expected=(200,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_UPDATE",
            predicate=lambda d: d.get("id") == str(message_id)
            and d.get("content") == "federation live message edited",
            timeout_s=20.0,
        )
        wait_until(
            "edited message on B",
            lambda: mapped_message_content("b", NODES["a"].server_name, message_id)
            == "federation live message edited",
        )
        wait_until(
            "edited message on C",
            lambda: mapped_message_content("c", NODES["a"].server_name, message_id)
            == "federation live message edited",
        )

        emoji_name = "thumbsup"
        request_json(
            "PUT",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}/reactions/{emoji_name}/@me",
            token=admin_tokens["a"],
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_REACTION_ADD",
            predicate=lambda d: d.get("message_id") == str(message_id)
            and d.get("emoji") == emoji_name,
            timeout_s=20.0,
        )
        wait_until(
            "reaction add on B",
            lambda: reaction_count("b", NODES["a"].server_name, message_id, emoji_name) > 0,
        )
        wait_until(
            "reaction add on C",
            lambda: reaction_count("c", NODES["a"].server_name, message_id, emoji_name) > 0,
        )

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}/reactions/{emoji_name}/@me",
            token=admin_tokens["a"],
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_REACTION_REMOVE",
            predicate=lambda d: d.get("message_id") == str(message_id)
            and d.get("emoji") == emoji_name,
            timeout_s=20.0,
        )
        wait_until(
            "reaction remove on B",
            lambda: reaction_count("b", NODES["a"].server_name, message_id, emoji_name) == 0,
        )
        wait_until(
            "reaction remove on C",
            lambda: reaction_count("c", NODES["a"].server_name, message_id, emoji_name) == 0,
        )

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}",
            token=admin_tokens["a"],
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_DELETE",
            predicate=lambda d: d.get("id") == str(message_id)
            and d.get("channel_id") == str(text_channel_id),
            timeout_s=20.0,
        )
        wait_until(
            "deleted message absent on B",
            lambda: mapped_message_absent("b", NODES["a"].server_name, message_id),
        )
        wait_until(
            "deleted message absent on C",
            lambda: mapped_message_absent("c", NODES["a"].server_name, message_id),
        )

        log("[10/14] Stage 2: Threads + polls + custom emojis (with realtime event assertions)")
        _, thread = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/threads",
            payload={"name": "live-thread", "auto_archive_duration": 60},
            token=admin_tokens["a"],
            expected=(201,),
        )
        thread_id = parse_int_id(thread["id"], "thread id")
        guest1_ws.wait_dispatch(
            "THREAD_CREATE",
            predicate=lambda d: d.get("id") == str(thread_id),
            timeout_s=20.0,
        )

        request_json(
            "PATCH",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/threads/{thread_id}",
            payload={"name": "live-thread-renamed"},
            token=admin_tokens["a"],
            expected=(200,),
        )
        guest1_ws.wait_dispatch(
            "THREAD_UPDATE",
            predicate=lambda d: d.get("id") == str(thread_id)
            and d.get("name") == "live-thread-renamed",
            timeout_s=20.0,
        )

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/threads/{thread_id}",
            token=admin_tokens["a"],
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "THREAD_DELETE",
            predicate=lambda d: d.get("id") == str(thread_id),
            timeout_s=20.0,
        )

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls",
            payload={
                "question": "Best protocol?",
                "options": [{"text": "Matrix"}, {"text": "Paracord"}],
                "allow_multiselect": False,
                "expires_in_minutes": 60,
            },
            token=admin_tokens["a"],
            expected=(201,),
        )
        poll_id = latest_poll_id(text_channel_id)
        _, poll = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}",
            token=admin_tokens["a"],
            expected=(200,),
        )
        options = poll.get("options", [])
        if not isinstance(options, list) or len(options) < 2:
            raise AssertionError("Poll options missing in get_poll response")
        option_id = parse_int_id(options[0]["id"], "poll option id")

        request_json(
            "PUT",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}/votes/{option_id}",
            token=guest1_token,
            expected=(200,),
        )
        admin_a_ws.wait_dispatch(
            "POLL_VOTE_ADD",
            predicate=lambda d: d.get("poll_id") == str(poll_id)
            and d.get("option_id") == str(option_id)
            and d.get("user_id") == str(guest1_id),
            timeout_s=20.0,
        )
        _, poll_after_vote = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}",
            token=guest1_token,
            expected=(200,),
        )
        if int(poll_after_vote.get("total_votes", -1)) < 1:
            raise AssertionError("Poll total_votes did not increase after vote")
        voted_options = [
            opt
            for opt in poll_after_vote.get("options", [])
            if str(opt.get("id")) == str(option_id) and opt.get("voted") is True
        ]
        if not voted_options:
            raise AssertionError("Poll option was not marked voted for voting user")

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}/votes/{option_id}",
            token=guest1_token,
            expected=(200,),
        )
        admin_a_ws.wait_dispatch(
            "POLL_VOTE_REMOVE",
            predicate=lambda d: d.get("poll_id") == str(poll_id)
            and d.get("option_id") == str(option_id)
            and d.get("user_id") == str(guest1_id),
            timeout_s=20.0,
        )
        _, poll_after_unvote = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}",
            token=guest1_token,
            expected=(200,),
        )
        if int(poll_after_unvote.get("total_votes", -1)) != 0:
            raise AssertionError("Poll total_votes did not return to zero after vote removal")

        emoji = request_multipart(
            url=f"{NODES['a'].url}/api/v1/guilds/{guild_id}/emojis",
            token=admin_tokens["a"],
            data={"name": "tinywave"},
            files={"image": ("tiny.png", TINY_PNG, "image/png")},
            expected=(201,),
        )
        emoji_id = parse_int_id(emoji["id"], "emoji id")
        guest1_ws.wait_dispatch(
            "GUILD_EMOJIS_UPDATE",
            predicate=lambda d: d.get("guild_id") == str(guild_id)
            and isinstance(d.get("emoji"), dict)
            and d["emoji"].get("id") == str(emoji_id),
            timeout_s=20.0,
        )

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
            token=admin_tokens["a"],
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "GUILD_EMOJIS_UPDATE",
            predicate=lambda d: d.get("guild_id") == str(guild_id)
            and d.get("deleted_emoji_id") == str(emoji_id),
            timeout_s=20.0,
        )

        log("[11/14] Friends + DMs + user settings")
        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/users/@me/relationships",
            payload={"user_id": str(guest2_id)},
            token=guest1_token,
            expected=(204,),
        )
        guest2_ws.wait_dispatch(
            "RELATIONSHIP_ADD",
            predicate=lambda d: d.get("type") == 3
            and isinstance(d.get("user"), dict)
            and d["user"].get("id") == str(guest1_id),
            timeout_s=20.0,
        )

        request_json(
            "PUT",
            f"{NODES['a'].url}/api/v1/users/@me/relationships/{guest1_id}",
            token=guest2_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "RELATIONSHIP_ADD",
            predicate=lambda d: d.get("type") == 1
            and isinstance(d.get("user"), dict)
            and d["user"].get("id") == str(guest2_id),
            timeout_s=20.0,
        )
        guest2_ws.wait_dispatch(
            "RELATIONSHIP_ADD",
            predicate=lambda d: d.get("type") == 1
            and isinstance(d.get("user"), dict)
            and d["user"].get("id") == str(guest1_id),
            timeout_s=20.0,
        )

        _, dm = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/users/@me/dms",
            payload={"recipient_id": str(guest2_id)},
            token=guest1_token,
            expected=(201,),
        )
        dm_channel_id = parse_int_id(dm["id"], "dm channel id")

        _, dm_msg = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{dm_channel_id}/messages",
            payload={
                "content": "",
                "e2ee": {
                    "version": 1,
                    "nonce": "AA==",
                    "ciphertext": "aGVsbG8tZnJvbS1ndWVzdDE=",
                },
            },
            token=guest1_token,
            expected=(201,),
        )
        dm_message_id = parse_int_id(dm_msg["id"], "dm message id")
        guest2_ws.wait_dispatch(
            "MESSAGE_CREATE",
            predicate=lambda d: d.get("id") == str(dm_message_id)
            and d.get("channel_id") == str(dm_channel_id),
            timeout_s=20.0,
        )

        _, dm_reply = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{dm_channel_id}/messages",
            payload={
                "content": "",
                "e2ee": {
                    "version": 1,
                    "nonce": "AQ==",
                    "ciphertext": "cmVwbHktZnJvbS1ndWVzdDI=",
                },
            },
            token=guest2_token,
            expected=(201,),
        )
        dm_reply_id = parse_int_id(dm_reply["id"], "dm reply id")
        guest1_ws.wait_dispatch(
            "MESSAGE_CREATE",
            predicate=lambda d: d.get("id") == str(dm_reply_id)
            and d.get("channel_id") == str(dm_channel_id),
            timeout_s=20.0,
        )
        _, dm_history = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/channels/{dm_channel_id}/messages?limit=50",
            token=guest1_token,
            expected=(200,),
        )
        if not isinstance(dm_history, list):
            raise AssertionError("Expected DM history response to be a list")
        history_by_id = {
            str(item.get("id")): item for item in dm_history if isinstance(item, dict)
        }
        for expected_dm_id in (dm_message_id, dm_reply_id):
            entry = history_by_id.get(str(expected_dm_id))
            if entry is None:
                raise AssertionError(f"Missing DM message in history: {expected_dm_id}")
            e2ee_payload = entry.get("e2ee")
            if not isinstance(e2ee_payload, dict):
                raise AssertionError(f"DM message {expected_dm_id} missing e2ee payload")
            if not e2ee_payload.get("nonce") or not e2ee_payload.get("ciphertext"):
                raise AssertionError(f"DM message {expected_dm_id} has incomplete e2ee payload")

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/users/@me/relationships/{guest2_id}",
            token=guest1_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "RELATIONSHIP_REMOVE",
            predicate=lambda d: d.get("user_id") == str(guest2_id),
            timeout_s=20.0,
        )
        guest2_ws.wait_dispatch(
            "RELATIONSHIP_REMOVE",
            predicate=lambda d: d.get("user_id") == str(guest1_id),
            timeout_s=20.0,
        )

        request_json(
            "PATCH",
            f"{NODES['a'].url}/api/v1/users/@me/settings",
            payload={
                "theme": "light",
                "locale": "en-US",
                "message_display_compact": True,
                "custom_status": "live-test",
                "notifications": {"dm": True},
            },
            token=guest1_token,
            expected=(200,),
        )
        _, settings = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/users/@me/settings",
            token=guest1_token,
            expected=(200,),
        )
        if settings.get("theme") != "light":
            raise AssertionError(f"Unexpected settings.theme: {settings.get('theme')}")
        if settings.get("message_display_compact") is not True:
            raise AssertionError("Expected message_display_compact=true")
        if settings.get("locale") != "en-US":
            raise AssertionError(f"Unexpected settings.locale: {settings.get('locale')}")

        log("[12/14] Voice + live streaming checks with realtime VOICE_STATE_UPDATE")
        _, join_voice = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/join",
            token=guest1_token,
            expected=(200,),
        )
        if not join_voice.get("token") or not join_voice.get("room_name"):
            raise AssertionError("Voice join response missing token or room_name")
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(guest1_id)
            and d.get("channel_id") == str(voice_channel_id),
            timeout_s=25.0,
        )

        _, admin_join_voice = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/join",
            token=admin_tokens["a"],
            expected=(200,),
        )
        if not admin_join_voice.get("token") or not admin_join_voice.get("room_name"):
            raise AssertionError("Admin voice join response missing token or room_name")
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(admin_ids["a"])
            and d.get("channel_id") == str(voice_channel_id),
            timeout_s=25.0,
        )

        _, stream_started = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/stream",
            payload={"title": "fed-live-stream", "quality_preset": "1080p60"},
            token=admin_tokens["a"],
            expected=(200,),
        )
        if not stream_started.get("token") or not stream_started.get("room_name"):
            raise AssertionError("Voice stream start response missing token or room_name")
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(admin_ids["a"])
            and d.get("channel_id") == str(voice_channel_id)
            and d.get("self_stream") is True,
            timeout_s=25.0,
        )

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/stream/stop",
            token=admin_tokens["a"],
            expected=(204,),
        )
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(admin_ids["a"])
            and d.get("channel_id") == str(voice_channel_id)
            and d.get("self_stream") is False,
            timeout_s=25.0,
        )

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/leave",
            token=admin_tokens["a"],
            expected=(204,),
        )
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(admin_ids["a"])
            and (d.get("channel_id") is None),
            timeout_s=25.0,
        )

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/voice/{voice_channel_id}/leave",
            token=guest1_token,
            expected=(204,),
        )
        admin_a_ws.wait_dispatch(
            "VOICE_STATE_UPDATE",
            predicate=lambda d: d.get("user_id") == str(guest1_id)
            and (d.get("channel_id") is None),
            timeout_s=25.0,
        )

        log("[13/14] Member leave + realtime/member-list + federation leave propagation")
        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/members/@me",
            token=guest1_token,
            expected=(204,),
        )
        admin_a_ws.wait_dispatch(
            "GUILD_MEMBER_REMOVE",
            predicate=lambda d: d.get("guild_id") == str(guild_id)
            and d.get("user_id") == str(guest1_id),
            timeout_s=20.0,
        )

        _, members_after_leave = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/members",
            token=admin_tokens["a"],
            expected=(200,),
        )
        assert len(members_after_leave) == baseline_member_count
        assert_member_list_contains(members_after_leave, guest1_id, should_exist=False)

        log("[14/14] Final assertions")
        with db_connect("a") as a_db:
            peers = a_db.execute(
                "SELECT server_name FROM federated_servers WHERE trusted = TRUE"
            ).fetchall()
            peer_names = [str(r["server_name"]) for r in peers]
            if NODES["b"].server_name not in peer_names:
                raise AssertionError(f"A is missing trusted peer {NODES['b'].server_name}: {peer_names}")

        log("PASS: Live decentralized fundamentals validation succeeded.")
        log(
            "PASS: Realtime checks passed for messages, DMs, threads, members, emoji reactions/custom emojis, polls, relationships, settings, voice, and live streaming."
        )
        log("PASS: Cross-node federation propagation verified (A-origin events reached C).")
        log(f"Logs: {LOGS_DIR}")
        return 0
    finally:
        for client in gateway_clients:
            client.close()
        for proc in procs:
            if proc.poll() is None:
                try:
                    proc.send_signal(signal.SIGTERM)
                except Exception:
                    pass
        time.sleep(1.0)
        for proc in procs:
            if proc.poll() is None:
                try:
                    proc.kill()
                except Exception:
                    pass
        for fh in log_files:
            try:
                fh.close()
            except Exception:
                pass


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr, flush=True)
        raise
