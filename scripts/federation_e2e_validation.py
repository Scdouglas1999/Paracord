#!/usr/bin/env python3
"""Three-node end-to-end federation/decentralization validation.

This script boots three local Paracord servers, links federation trust, and
verifies cross-node propagation for:
  - message create/edit/delete
  - reaction add/remove
  - member join/leave
  - relay topology (A -> B -> C without A -> C direct peer)
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
BASE_DIR = ROOT / "data" / "fed-e2e"
KEYS_DIR = BASE_DIR / "keys"
LOGS_DIR = BASE_DIR / "logs"
BINARY = ROOT / "target" / "debug" / "paracord-server.exe"
PASSWORD = "Paracord!Federation!123"


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


NODES = {
    "a": Node("a", 18081, "node-a.test"),
    "b": Node("b", 18082, "node-b.test"),
    "c": Node("c", 18083, "node-c.test"),
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


def write_config(node: Node) -> Path:
    node_dir = BASE_DIR / node.key
    for path in (node_dir / "uploads", node_dir / "files", node_dir / "backups"):
        path.mkdir(parents=True, exist_ok=True)

    key_file = KEYS_DIR / f"{node.key}.hex"
    cfg = f"""
[server]
bind_address = "127.0.0.1:{node.port}"
server_name = "{node.server_name}"

[tls]
enabled = false
port = {node.port + 1000}

[database]
url = "sqlite://./data/fed-e2e/{node.key}/paracord.db?mode=rwc"
max_connections = 5

[auth]
jwt_secret = "fed-e2e-jwt-secret-{node.key}-0123456789abcdef"
jwt_expiry_seconds = 3600
registration_enabled = true

[storage]
storage_type = "local"
path = "./data/fed-e2e/{node.key}/uploads"
max_upload_size = 52428800

[media]
storage_path = "./data/fed-e2e/{node.key}/files"
max_file_size = 10485760
p2p_threshold = 10485760

[livekit]
api_key = "fed-e2e-livekit-{node.key}"
api_secret = "fed-e2e-livekit-secret-{node.key}-0123456789"
url = "ws://livekit.invalid:7880"
http_url = "http://livekit.invalid:7880"

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
backup_dir = "./data/fed-e2e/{node.key}/backups"
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
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url=url, method=method, data=data)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req, timeout=10) as resp:
        status = resp.getcode()
        body = resp.read().decode("utf-8").strip()
    if status not in expected:
        raise RuntimeError(f"{method} {url} unexpected status {status}: {body}")
    if not body:
        return status, {}
    return status, json.loads(body)


def wait_until(desc: str, fn: Callable[[], bool], timeout_s: float = 30.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            if fn():
                return
        except Exception:
            pass
        time.sleep(0.5)
    raise TimeoutError(f"Timed out waiting for: {desc}")


def db_connect(node_key: str) -> sqlite3.Connection:
    db_path = BASE_DIR / node_key / "paracord.db"
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    return conn


def clone_shared_guild_and_channel(
    guild_id: int,
    channel_id: int,
    owner_user_id: int,
    target_node_key: str,
) -> None:
    with db_connect("a") as src, db_connect(target_node_key) as dst:
        space = src.execute("SELECT * FROM spaces WHERE id = ?", (guild_id,)).fetchone()
        channel = src.execute("SELECT * FROM channels WHERE id = ?", (channel_id,)).fetchone()
        roles = src.execute("SELECT * FROM roles WHERE space_id = ?", (guild_id,)).fetchall()
        if not space or not channel:
            raise RuntimeError("Failed to locate source guild/channel in node A database")

        space_data = dict(space)
        space_data["owner_id"] = owner_user_id
        insert_row(dst, "spaces", space_data)
        insert_row(dst, "channels", dict(channel))
        for role in roles:
            insert_row(dst, "roles", dict(role))
        dst.commit()


def insert_row(conn: sqlite3.Connection, table: str, row: dict[str, Any]) -> None:
    cols = list(row.keys())
    placeholders = ", ".join(["?"] * len(cols))
    sql = f"INSERT OR IGNORE INTO {table} ({', '.join(cols)}) VALUES ({placeholders})"
    conn.execute(sql, [row[c] for c in cols])


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


def main() -> int:
    procs: list[subprocess.Popen[str]] = []
    log_files: list[Any] = []
    try:
        log("[1/9] Preparing clean federation E2E workspace")
        if BASE_DIR.exists():
            shutil.rmtree(BASE_DIR)
        KEYS_DIR.mkdir(parents=True, exist_ok=True)
        LOGS_DIR.mkdir(parents=True, exist_ok=True)

        for node in NODES.values():
            key_hex = os.urandom(32).hex()
            (KEYS_DIR / f"{node.key}.hex").write_text(key_hex, encoding="utf-8")

        log("[2/9] Building paracord-server binary")
        run(["cargo", "build", "-p", "paracord-server"], cwd=ROOT)
        if not BINARY.exists():
            raise RuntimeError(f"Missing expected server binary: {BINARY}")

        cfg_paths = {k: write_config(v) for k, v in NODES.items()}
        child_env = os.environ.copy()
        # This script intentionally validates loopback-only local federation.
        # Production deployments should leave this unset so SSRF protections
        # continue blocking private/internal federation endpoints by default.
        child_env["PARACORD_ALLOW_PRIVATE_FEDERATION_URLS"] = "true"
        child_env["PARACORD_FEDERATION_ALLOWED_GUILD_IDS"] = "*"

        log("[3/9] Starting three federation-enabled nodes (A, B, C)")
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
                timeout_s=90.0,
            )

        log("[4/9] Registering per-node admin users")
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
            admin_tokens[key] = body["token"]
            admin_ids[key] = int(body["user"]["id"])

        # Register a non-admin user on A before the guild is created.
        # This avoids auto-join side effects for public spaces at registration time.
        _, guest = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/auth/register",
            payload={
                "email": "guest-a@example.test",
                "username": "guest_a",
                "password": PASSWORD,
            },
            expected=(201,),
        )
        guest_token = guest["token"]
        guest_username = guest["user"]["username"]

        log("[5/9] Linking federation trust (relay topology: A->B->C; no A->C peer)")
        add_trusted_peer(admin_tokens["a"], NODES["a"], NODES["b"])
        add_trusted_peer(admin_tokens["b"], NODES["b"], NODES["a"])
        add_trusted_peer(admin_tokens["b"], NODES["b"], NODES["c"])
        add_trusted_peer(admin_tokens["c"], NODES["c"], NODES["b"])
        add_trusted_peer(admin_tokens["c"], NODES["c"], NODES["a"])

        log("[6/9] Creating source guild/channel on A and mirroring IDs to B/C")
        _, guild = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/guilds",
            payload={"name": "Federation E2E Guild"},
            token=admin_tokens["a"],
            expected=(201,),
        )
        guild_id = int(guild["id"])

        _, channels = request_json(
            "GET",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/channels",
            token=admin_tokens["a"],
            expected=(200,),
        )
        text_channels = [c for c in channels if int(c.get("channel_type", 0)) == 0]
        if not text_channels:
            _, created = request_json(
                "POST",
                f"{NODES['a'].url}/api/v1/guilds/{guild_id}/channels",
                payload={"name": "general", "channel_type": 0},
                token=admin_tokens["a"],
                expected=(201,),
            )
            channel_id = int(created["id"])
        else:
            channel_id = int(text_channels[0]["id"])

        clone_shared_guild_and_channel(guild_id, channel_id, admin_ids["b"], "b")
        clone_shared_guild_and_channel(guild_id, channel_id, admin_ids["c"], "c")

        log("[7/9] Validating cross-node message/reaction propagation and relay")
        message_text = "federation e2e message"
        _, created_msg = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/messages",
            payload={"content": message_text, "attachment_ids": []},
            token=admin_tokens["a"],
            expected=(201,),
        )
        message_id = int(created_msg["id"])
        origin_event_id = f"${message_id}:{NODES['a'].server_name}"

        def mapped_message_content(node_key: str) -> str | None:
            with db_connect(node_key) as conn:
                row = conn.execute(
                    """
                    SELECT m.content
                    FROM federation_message_map fm
                    JOIN messages m ON m.id = fm.local_message_id
                    WHERE fm.origin_server = ? AND fm.remote_message_id = ?
                    LIMIT 1
                    """,
                    (NODES["a"].server_name, str(message_id)),
                ).fetchone()
                return None if row is None else str(row["content"])

        wait_until("message replicated to B", lambda: mapped_message_content("b") == message_text, 30.0)
        wait_until("message relayed to C", lambda: mapped_message_content("c") == message_text, 30.0)

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
            if int(a_to_c) != 0:
                raise AssertionError("A unexpectedly delivered message directly to C")
            if int(b_to_c) <= 0 or int(c_has_event) <= 0:
                raise AssertionError("Relay evidence missing: expected B->C delivery and C event")

        edited_text = "federation e2e message edited"
        request_json(
            "PATCH",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/messages/{message_id}",
            payload={"content": edited_text},
            token=admin_tokens["a"],
            expected=(200,),
        )

        def mapped_guild_id(node_key: str) -> int | None:
            with db_connect(node_key) as conn:
                row = conn.execute(
                    "SELECT local_guild_id FROM federation_space_map WHERE origin_server = ? AND remote_space_id = ?",
                    (NODES["a"].server_name, str(guild_id)),
                ).fetchone()
                return None if row is None else int(row["local_guild_id"])

        wait_until("edited message on B", lambda: mapped_message_content("b") == edited_text, 30.0)
        wait_until("edited message on C", lambda: mapped_message_content("c") == edited_text, 30.0)

        emoji = "thumbsup"
        request_json(
            "PUT",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
            token=admin_tokens["a"],
            expected=(204,),
        )

        def reaction_count(node_key: str) -> int:
            with db_connect(node_key) as conn:
                row = conn.execute(
                    """
                    SELECT COUNT(*)
                    FROM reactions r
                    JOIN federation_message_map fm ON fm.local_message_id = r.message_id
                    WHERE fm.origin_server = ? AND fm.remote_message_id = ? AND r.emoji_name = ?
                    """,
                    (NODES["a"].server_name, str(message_id), emoji),
                ).fetchone()
                return int(row[0])

        wait_until("reaction add on B", lambda: reaction_count("b") > 0, 30.0)
        wait_until("reaction add on C", lambda: reaction_count("c") > 0, 30.0)

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
            token=admin_tokens["a"],
            expected=(204,),
        )
        wait_until("reaction remove on B", lambda: reaction_count("b") == 0, 30.0)
        wait_until("reaction remove on C", lambda: reaction_count("c") == 0, 30.0)

        log("[8/9] Validating cross-node member join/leave propagation")
        _, invite = request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/invites",
            payload={},
            token=admin_tokens["a"],
            expected=(201,),
        )
        invite_code = invite["code"]

        request_json(
            "POST",
            f"{NODES['a'].url}/api/v1/invites/{invite_code}",
            payload={},
            token=guest_token,
            expected=(200,),
        )
        remote_guest_id = f"@{guest_username}:{NODES['a'].server_name}"

        def remote_member_present(node_key: str) -> bool:
            with db_connect(node_key) as conn:
                mapping = conn.execute(
                    "SELECT local_user_id FROM federation_remote_users WHERE remote_user_id = ?",
                    (remote_guest_id,),
                ).fetchone()
                if mapping is None:
                    return False
                local_guild_id = mapped_guild_id(node_key)
                if local_guild_id is None:
                    return False
                row = conn.execute(
                    "SELECT COUNT(*) FROM members WHERE user_id = ? AND guild_id = ?",
                    (int(mapping["local_user_id"]), local_guild_id),
                ).fetchone()
                return int(row[0]) > 0

        wait_until("member join on B", lambda: remote_member_present("b"), 30.0)
        wait_until("member join on C", lambda: remote_member_present("c"), 30.0)

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/guilds/{guild_id}/members/@me",
            token=guest_token,
            expected=(204,),
        )

        def remote_member_absent(node_key: str) -> bool:
            with db_connect(node_key) as conn:
                mapping = conn.execute(
                    "SELECT local_user_id FROM federation_remote_users WHERE remote_user_id = ?",
                    (remote_guest_id,),
                ).fetchone()
                if mapping is None:
                    return False
                local_guild_id = mapped_guild_id(node_key)
                if local_guild_id is None:
                    return False
                row = conn.execute(
                    "SELECT COUNT(*) FROM members WHERE user_id = ? AND guild_id = ?",
                    (int(mapping["local_user_id"]), local_guild_id),
                ).fetchone()
                return int(row[0]) == 0

        wait_until("member leave on B", lambda: remote_member_absent("b"), 30.0)
        wait_until("member leave on C", lambda: remote_member_absent("c"), 30.0)

        request_json(
            "DELETE",
            f"{NODES['a'].url}/api/v1/channels/{channel_id}/messages/{message_id}",
            token=admin_tokens["a"],
            expected=(204,),
        )

        def mapped_message_absent(node_key: str) -> bool:
            with db_connect(node_key) as conn:
                mapped = conn.execute(
                    "SELECT local_message_id FROM federation_message_map WHERE origin_server = ? AND remote_message_id = ?",
                    (NODES["a"].server_name, str(message_id)),
                ).fetchone()
                if mapped is None:
                    return True
                row = conn.execute(
                    "SELECT COUNT(*) FROM messages WHERE id = ?",
                    (int(mapped["local_message_id"]),),
                ).fetchone()
                return int(row[0]) == 0

        wait_until("message delete on B", lambda: mapped_message_absent("b"), 30.0)
        wait_until("message delete on C", lambda: mapped_message_absent("c"), 30.0)

        log("[9/9] Final assertions and summary")
        with db_connect("a") as a_db:
            peers = a_db.execute(
                "SELECT server_name FROM federated_servers WHERE trusted = TRUE ORDER BY server_name"
            ).fetchall()
            peer_names = [str(r["server_name"]) for r in peers]
            if peer_names != [NODES["b"].server_name]:
                raise AssertionError(f"Unexpected A trusted peers: {peer_names}")

        log("PASS: 3-node federation/decentralization validation succeeded.")
        log("PASS: Relay verified (A had no direct C peer; C still received A-origin events via B).")
        log(f"Logs: {LOGS_DIR}")
        return 0
    finally:
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
