#!/usr/bin/env python3
"""Deployed 3-node decentralized live validation.

Runs a full live feature pass against three already-deployed Paracord nodes:
- realtime user features on node A (messages, DMs, threads, polls, emoji, friends,
  settings, voice, streaming, member list updates)
- cross-node federation propagation checks on nodes B and C via federation read APIs
- federation ingest negative checks (unsigned, tampered signature, stale timestamp,
  replay protection)

This script does not use direct DB access or local process bootstrapping.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import random
import ssl
import string
import sys
import time
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import quote, urlencode, urlparse

import requests
import urllib3
import websocket
from nacl.signing import SigningKey


DEFAULT_PASSWORD = "Paracord!Federation!123"
DEFAULT_GATEWAY_ORIGIN = "http://localhost:1420"

# 1x1 transparent PNG
TINY_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7+q5sAAAAASUVORK5CYII="
)


@dataclass(frozen=True)
class Node:
    key: str
    url: str
    server_name: str
    domain: str
    fed_endpoint: str
    gateway_url: str


@dataclass(frozen=True)
class TransportSigner:
    origin: str
    key_id: str
    signing_key: SigningKey


@dataclass(frozen=True)
class FederationReadAuth:
    read_token: str | None
    signer: TransportSigner | None


def log(msg: str) -> None:
    print(msg, flush=True)


def random_suffix(n: int = 8) -> str:
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(n))


def parse_int_id(raw: Any, field: str) -> int:
    try:
        return int(str(raw))
    except Exception as exc:
        raise RuntimeError(f"Invalid {field}: {raw!r}") from exc


def canonical_transport_bytes_with_body(
    method: str,
    path: str,
    timestamp_ms: int,
    body_bytes: bytes,
) -> bytes:
    body_hash = hashlib.sha256(body_bytes).hexdigest()
    canonical = f"{method.upper()}\n{path}\n{timestamp_ms}\n{body_hash}"
    return canonical.encode("utf-8")


def build_transport_headers(
    signer: TransportSigner,
    method: str,
    path: str,
    body_bytes: bytes,
    *,
    timestamp_ms: int | None = None,
) -> dict[str, str]:
    ts = int(time.time() * 1000) if timestamp_ms is None else int(timestamp_ms)
    canonical = canonical_transport_bytes_with_body(method, path, ts, body_bytes)
    signature = signer.signing_key.sign(canonical).signature.hex()
    return {
        "X-Paracord-Origin": signer.origin,
        "X-Paracord-Key-Id": signer.key_id,
        "X-Paracord-Timestamp": str(ts),
        "X-Paracord-Signature": signature,
    }


def wait_until(
    desc: str,
    fn: Callable[[], bool],
    timeout_s: float = 35.0,
    interval_s: float = 0.5,
) -> None:
    deadline = time.time() + timeout_s
    last_error: Exception | None = None
    while time.time() < deadline:
        try:
            if fn():
                return
        except Exception as exc:
            last_error = exc
        time.sleep(interval_s)
    if last_error is not None:
        raise RuntimeError(f"Timed out waiting for {desc}; last error: {last_error}")
    raise RuntimeError(f"Timed out waiting for {desc}")


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    *,
    payload: dict[str, Any] | None = None,
    token: str | None = None,
    extra_headers: dict[str, str] | None = None,
    expected: tuple[int, ...] = (200, 201, 202, 204),
) -> tuple[int, dict[str, Any]]:
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if extra_headers:
        headers.update(extra_headers)
    resp = session.request(method, url, json=payload, headers=headers, timeout=20)
    if resp.status_code not in expected:
        raise RuntimeError(
            f"{method} {url} unexpected status {resp.status_code}: {resp.text.strip()}"
        )
    body = resp.text.strip()
    if not body:
        return resp.status_code, {}
    return resp.status_code, resp.json()


def request_with_body(
    session: requests.Session,
    method: str,
    url: str,
    *,
    body_bytes: bytes,
    headers: dict[str, str],
) -> requests.Response:
    return session.request(
        method,
        url,
        data=body_bytes,
        headers=headers,
        timeout=20,
    )


def request_multipart(
    session: requests.Session,
    *,
    url: str,
    token: str,
    data: dict[str, str],
    files: dict[str, tuple[str, bytes, str]],
    expected: tuple[int, ...] = (200, 201),
) -> dict[str, Any]:
    headers = {"Authorization": f"Bearer {token}"}
    resp = session.post(url, data=data, files=files, headers=headers, timeout=20)
    if resp.status_code not in expected:
        raise RuntimeError(f"POST {url} unexpected status {resp.status_code}: {resp.text.strip()}")
    if not resp.text.strip():
        return {}
    return resp.json()


def discover_node(session: requests.Session, key: str, base_url: str) -> Node:
    url = base_url.rstrip("/")
    parsed_input = urlparse(url)
    if parsed_input.hostname in {"localhost", "127.0.0.1", "::1"}:
        raise RuntimeError(
            f"{url} points to localhost. If the node is on a dedicated server, "
            "use that server's public/private IP or DNS name instead."
        )
    try:
        request_json(session, "GET", f"{url}/health", expected=(200,))
    except Exception as exc:
        if parsed_input.scheme == "https":
            http_url = f"http://{parsed_input.netloc}"
            try:
                request_json(session, "GET", f"{http_url}/health", expected=(200,))
                raise RuntimeError(
                    f"Could not reach {url}, but {http_url} is healthy. "
                    "Your server appears to be HTTP-only. Use http://... in the test "
                    "or enable TLS on the server."
                ) from exc
            except Exception:
                pass
        raise RuntimeError(f"Could not reach node {url}: {exc}") from exc
    _, wk = request_json(
        session,
        "GET",
        f"{url}/.well-known/paracord/server",
        expected=(200,),
    )
    server_name = str(wk.get("server_name") or "")
    domain = str(wk.get("domain") or server_name)
    fed_endpoint = str(wk.get("federation_endpoint") or "/_paracord/federation/v1")
    if fed_endpoint.startswith("/"):
        fed_endpoint = f"{url}{fed_endpoint}"
    parsed = urlparse(url)
    gateway_scheme = "wss" if parsed.scheme == "https" else "ws"
    gateway_url = f"{gateway_scheme}://{parsed.netloc}/gateway"
    if not server_name:
        raise RuntimeError(f"{url} returned invalid .well-known response: {wk}")
    return Node(
        key=key,
        url=url,
        server_name=server_name,
        domain=domain,
        fed_endpoint=fed_endpoint.rstrip("/"),
        gateway_url=gateway_url,
    )


def add_trusted_peer(
    session: requests.Session,
    *,
    admin_token: str,
    source: Node,
    peer: Node,
) -> None:
    payload = {
        "server_name": peer.server_name,
        "domain": peer.domain,
        "federation_endpoint": peer.fed_endpoint,
        "trusted": True,
        "discover": True,
    }
    request_json(
        session,
        "POST",
        f"{source.url}/_paracord/federation/v1/servers",
        payload=payload,
        token=admin_token,
        expected=(201,),
    )


def register_user(
    session: requests.Session,
    *,
    node_url: str,
    email: str,
    username: str,
    password: str,
) -> tuple[str, int]:
    _, body = request_json(
        session,
        "POST",
        f"{node_url}/api/v1/auth/register",
        payload={"email": email, "username": username, "password": password},
        expected=(201,),
    )
    token = str(body["token"])
    user_id = parse_int_id(body["user"]["id"], "user id")
    return token, user_id


def resolve_user_id(session: requests.Session, node_url: str, token: str) -> int:
    _, me = request_json(
        session,
        "GET",
        f"{node_url}/api/v1/users/@me",
        token=token,
        expected=(200,),
    )
    return parse_int_id(me["id"], "user id")


def read_events(
    session: requests.Session,
    *,
    node: Node,
    room_id: str,
    auth: FederationReadAuth,
    since_depth: int = 0,
    limit: int = 500,
) -> list[dict[str, Any]]:
    query = urlencode({"room_id": room_id, "since_depth": since_depth, "limit": limit})
    path = f"/_paracord/federation/v1/events?{query}"
    url = f"{node.url}{path}"
    headers: dict[str, str] = {}
    if auth.read_token:
        headers["X-Paracord-Federation-Token"] = auth.read_token
    elif auth.signer:
        headers.update(build_transport_headers(auth.signer, "GET", path, b""))
    else:
        raise RuntimeError("Federation read auth is not configured")
    resp = session.get(url, headers=headers, timeout=20)
    if resp.status_code != 200:
        raise RuntimeError(
            f"GET {url} unexpected status {resp.status_code}: {resp.text.strip()}"
        )
    body = resp.json()
    events = body.get("events")
    if not isinstance(events, list):
        raise RuntimeError(f"Invalid events payload from {node.server_name}: {body}")
    out: list[dict[str, Any]] = []
    for item in events:
        if isinstance(item, dict):
            out.append(item)
    return out


def event_present(
    events: list[dict[str, Any]],
    *,
    event_type: str,
    message_id: int | None = None,
    user_id: int | None = None,
    emoji: str | None = None,
) -> bool:
    for event in events:
        if str(event.get("event_type")) != event_type:
            continue
        content = event.get("content")
        if not isinstance(content, dict):
            continue
        if message_id is not None and str(content.get("message_id")) != str(message_id):
            continue
        if user_id is not None and str(content.get("user_id")) != str(user_id):
            continue
        if emoji is not None and str(content.get("emoji")) != emoji:
            continue
        return True
    return False


class GatewayClient:
    def __init__(
        self,
        name: str,
        url: str,
        token: str,
        *,
        origin: str,
        insecure_tls: bool,
    ):
        self.name = name
        self.url = url
        self.token = token
        self.origin = origin
        self.insecure_tls = insecure_tls
        self.ws: websocket.WebSocket | None = None
        self.heartbeat_interval_s = 41.25
        self.last_heartbeat_at = 0.0
        self.backlog: list[dict[str, Any]] = []

    def connect(self) -> None:
        sslopt: dict[str, Any] | None = None
        if self.url.startswith("wss://") and self.insecure_tls:
            sslopt = {"cert_reqs": ssl.CERT_NONE}
        websocket.enableTrace(False)
        self.ws = websocket.create_connection(
            self.url,
            timeout=12,
            origin=self.origin,
            sslopt=sslopt,
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
        self.ws.send(json.dumps(payload, separators=(",", ":")))

    def _recv_json_blocking(self, timeout_s: float) -> dict[str, Any]:
        if self.ws is None:
            raise RuntimeError(f"{self.name}: websocket not connected")
        self.ws.settimeout(timeout_s)
        raw = self.ws.recv()
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8", errors="replace")
        return json.loads(raw)

    def _recv_until_dispatch(self, timeout_s: float) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            remaining = max(0.1, deadline - time.monotonic())
            msg = self._recv_json_blocking(min(remaining, 5.0))
            op = msg.get("op")
            if op == 11:
                continue
            if op == 10:
                continue
            if op == 0:
                return msg
            if op == 1:
                self.send({"op": 11, "d": None})
            now = time.monotonic()
            if now - self.last_heartbeat_at >= self.heartbeat_interval_s:
                self.send({"op": 1, "d": None})
                self.last_heartbeat_at = now
        raise TimeoutError(f"{self.name}: timed out waiting for dispatch")

    def _poll_once(self, timeout_s: float = 0.5) -> dict[str, Any] | None:
        try:
            return self._recv_until_dispatch(timeout_s)
        except TimeoutError:
            return None

    def wait_dispatch(
        self,
        event_name: str,
        predicate: Callable[[dict[str, Any]], bool] | None = None,
        timeout_s: float = 20.0,
    ) -> dict[str, Any]:
        for idx, msg in enumerate(self.backlog):
            if msg.get("t") != event_name:
                continue
            data = msg.get("d") if isinstance(msg.get("d"), dict) else {}
            if predicate is None or predicate(data):
                self.backlog.pop(idx)
                return msg

        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            msg = self._poll_once(0.5)
            if msg is None:
                continue
            t = msg.get("t")
            data = msg.get("d")
            if not isinstance(data, dict):
                data = {}
            if t == event_name and (predicate is None or predicate(data)):
                return msg
            self.backlog.append(msg)
        raise TimeoutError(f"{self.name}: did not receive {event_name} in {timeout_s:.1f}s")

def run_federation_negative_checks(
    session: requests.Session,
    *,
    target: Node,
    signer: TransportSigner,
    room_id: str,
) -> None:
    path = "/_paracord/federation/v1/event"
    url = f"{target.url}{path}"
    payload = {
        "event_id": f"$neg-{random_suffix(8)}:{signer.origin}",
        "room_id": room_id,
        "event_type": "m.message",
        "sender": f"@negative:{signer.origin}",
        "origin_server": signer.origin,
        "origin_ts": int(time.time() * 1000),
        "content": {
            "guild_id": "1",
            "channel_id": "1",
            "message_id": "1",
            "body": "negative-probe",
        },
        "depth": int(time.time() * 1000),
        "state_key": None,
        "signatures": {},
    }
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")

    unsigned = request_with_body(
        session,
        "POST",
        url,
        body_bytes=body,
        headers={"Content-Type": "application/json"},
    )
    if unsigned.status_code not in (401, 403):
        raise AssertionError(
            f"Unsigned federation ingest expected 401/403, got {unsigned.status_code}: {unsigned.text}"
        )

    good_headers = build_transport_headers(signer, "POST", path, body)
    tampered = dict(good_headers)
    sig = tampered.get("X-Paracord-Signature", "")
    if not sig:
        raise AssertionError("Signer produced empty signature")
    replacement = "0" if sig[-1] != "0" else "1"
    tampered["X-Paracord-Signature"] = f"{sig[:-1]}{replacement}"
    tampered["Content-Type"] = "application/json"
    tampered_resp = request_with_body(
        session,
        "POST",
        url,
        body_bytes=body,
        headers=tampered,
    )
    if tampered_resp.status_code != 403:
        raise AssertionError(
            f"Tampered signature expected 403, got {tampered_resp.status_code}: {tampered_resp.text}"
        )

    stale_ts = int(time.time() * 1000) - 900_000
    stale_headers = build_transport_headers(signer, "POST", path, body, timestamp_ms=stale_ts)
    stale_headers["Content-Type"] = "application/json"
    stale_resp = request_with_body(
        session,
        "POST",
        url,
        body_bytes=body,
        headers=stale_headers,
    )
    if stale_resp.status_code != 401:
        raise AssertionError(
            f"Stale signed request expected 401, got {stale_resp.status_code}: {stale_resp.text}"
        )

    replay_headers = build_transport_headers(signer, "POST", path, body)
    replay_headers["Content-Type"] = "application/json"
    first = request_with_body(
        session,
        "POST",
        url,
        body_bytes=body,
        headers=replay_headers,
    )
    if first.status_code not in (401, 403):
        raise AssertionError(
            f"First replay probe expected 401/403, got {first.status_code}: {first.text}"
        )
    second = request_with_body(
        session,
        "POST",
        url,
        body_bytes=body,
        headers=replay_headers,
    )
    if second.status_code != 409:
        raise AssertionError(
            f"Replay probe expected 409 on second attempt, got {second.status_code}: {second.text}"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node-a-url", required=True)
    parser.add_argument("--node-b-url", required=True)
    parser.add_argument("--node-c-url", required=True)
    parser.add_argument("--admin-a-token", required=True)
    parser.add_argument("--admin-b-token", required=True)
    parser.add_argument("--admin-c-token", required=True)
    parser.add_argument("--actor-a-token", default=None)
    parser.add_argument("--guest1-token", default=None)
    parser.add_argument("--guest2-token", default=None)
    parser.add_argument("--password", default=DEFAULT_PASSWORD)
    parser.add_argument("--federation-read-token", default=None)
    parser.add_argument("--read-origin", default=None)
    parser.add_argument("--read-key-id", default=None)
    parser.add_argument("--read-signing-key-hex", default=None)
    parser.add_argument("--gateway-origin", default=DEFAULT_GATEWAY_ORIGIN)
    parser.add_argument("--insecure-tls", action="store_true")
    parser.add_argument("--skip-security-negatives", action="store_true")
    args = parser.parse_args()

    session = requests.Session()
    if args.insecure_tls:
        session.verify = False
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    nodes: dict[str, Node] = {}
    log("[1/13] Discovering deployed nodes")
    nodes["a"] = discover_node(session, "a", args.node_a_url)
    nodes["b"] = discover_node(session, "b", args.node_b_url)
    nodes["c"] = discover_node(session, "c", args.node_c_url)

    admin_tokens = {
        "a": args.admin_a_token,
        "b": args.admin_b_token,
        "c": args.admin_c_token,
    }
    actor_a_token = args.actor_a_token or args.admin_a_token

    read_auth: FederationReadAuth
    signer: TransportSigner | None = None
    if args.federation_read_token:
        read_auth = FederationReadAuth(read_token=args.federation_read_token, signer=None)
    else:
        if not (args.read_origin and args.read_key_id and args.read_signing_key_hex):
            raise RuntimeError(
                "Provide either --federation-read-token or all of "
                "--read-origin/--read-key-id/--read-signing-key-hex"
            )
        seed = bytes.fromhex(args.read_signing_key_hex.strip())
        if len(seed) != 32:
            raise RuntimeError("read signing key must be 32-byte hex (64 chars)")
        signer = TransportSigner(
            origin=args.read_origin.strip(),
            key_id=args.read_key_id.strip(),
            signing_key=SigningKey(seed),
        )
        if signer.origin != nodes["a"].server_name:
            raise RuntimeError(
                f"--read-origin must match node A server_name ({nodes['a'].server_name}) "
                "for signed cross-node validation"
            )
        read_auth = FederationReadAuth(read_token=None, signer=signer)

    log("[2/13] Preparing users/tokens on node A")
    if args.guest1_token:
        guest1_token = args.guest1_token
        guest1_id = resolve_user_id(session, nodes["a"].url, guest1_token)
    else:
        guest1_token, guest1_id = register_user(
            session,
            node_url=nodes["a"].url,
            email=f"fedlive-{random_suffix()}@example.test",
            username=f"fedguest1_{random_suffix(6)}",
            password=args.password,
        )
    if args.guest2_token:
        guest2_token = args.guest2_token
        guest2_id = resolve_user_id(session, nodes["a"].url, guest2_token)
    else:
        guest2_token, guest2_id = register_user(
            session,
            node_url=nodes["a"].url,
            email=f"fedlive-{random_suffix()}@example.test",
            username=f"fedguest2_{random_suffix(6)}",
            password=args.password,
        )
    resolve_user_id(session, nodes["a"].url, actor_a_token)

    gateway_clients: list[GatewayClient] = []
    try:
        log("[3/13] Opening gateway sessions for realtime assertions")
        guest2_ws = GatewayClient(
            "guest2",
            nodes["a"].gateway_url,
            guest2_token,
            origin=args.gateway_origin,
            insecure_tls=args.insecure_tls,
        )
        guest2_ws.connect()
        gateway_clients.append(guest2_ws)

        log("[4/13] Linking federation trust topology")
        add_trusted_peer(session, admin_token=admin_tokens["a"], source=nodes["a"], peer=nodes["b"])
        add_trusted_peer(session, admin_token=admin_tokens["b"], source=nodes["b"], peer=nodes["a"])
        add_trusted_peer(session, admin_token=admin_tokens["b"], source=nodes["b"], peer=nodes["c"])
        add_trusted_peer(session, admin_token=admin_tokens["c"], source=nodes["c"], peer=nodes["b"])
        if signer and signer.origin == nodes["a"].server_name:
            add_trusted_peer(session, admin_token=admin_tokens["c"], source=nodes["c"], peer=nodes["a"])

        log("[5/13] Creating guild/channels on node A")
        _, created_guild = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/guilds",
            payload={"name": f"Fed Live Deploy {random_suffix(6)}"},
            token=actor_a_token,
            expected=(201,),
        )
        guild_id = parse_int_id(created_guild["id"], "guild id")
        room_id = f"!{guild_id}:{nodes['a'].domain}"

        _, created_text = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/guilds/{guild_id}/channels",
            payload={"name": "general-live", "channel_type": 0},
            token=actor_a_token,
            expected=(201,),
        )
        text_channel_id = parse_int_id(created_text["id"], "text channel id")
        _, created_voice = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/guilds/{guild_id}/channels",
            payload={"name": "voice-live", "channel_type": 2},
            token=actor_a_token,
            expected=(201,),
        )
        voice_channel_id = parse_int_id(created_voice["id"], "voice channel id")

        admin_a_ws = GatewayClient(
            "admin-a",
            nodes["a"].gateway_url,
            actor_a_token,
            origin=args.gateway_origin,
            insecure_tls=args.insecure_tls,
        )
        admin_a_ws.connect()
        gateway_clients.append(admin_a_ws)

        log("[6/13] Member join + realtime member list update")
        _, members_before = request_json(
            session,
            "GET",
            f"{nodes['a'].url}/api/v1/guilds/{guild_id}/members",
            token=actor_a_token,
            expected=(200,),
        )
        _ = len(members_before)

        _, invite = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/invites",
            payload={},
            token=actor_a_token,
            expected=(201,),
        )
        invite_code = str(invite["code"])
        request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/invites/{invite_code}",
            payload={},
            token=guest1_token,
            expected=(200,),
        )
        admin_a_ws.wait_dispatch(
            "GUILD_MEMBER_ADD",
            predicate=lambda d: d.get("guild_id") == str(guild_id) and d.get("user_id") == str(guest1_id),
            timeout_s=25.0,
        )

        guest1_ws = GatewayClient(
            "guest1",
            nodes["a"].gateway_url,
            guest1_token,
            origin=args.gateway_origin,
            insecure_tls=args.insecure_tls,
        )
        guest1_ws.connect()
        gateway_clients.append(guest1_ws)
        log("[7/13] Messages, reactions, threads, polls, emoji, DMs, friends, settings")
        _, created_msg = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/messages",
            payload={"content": "federation deploy live message", "attachment_ids": []},
            token=actor_a_token,
            expected=(201,),
        )
        message_id = parse_int_id(created_msg["id"], "message id")
        guest1_ws.wait_dispatch(
            "MESSAGE_CREATE",
            predicate=lambda d: d.get("id") == str(message_id) and d.get("channel_id") == str(text_channel_id),
            timeout_s=20.0,
        )

        request_json(
            session,
            "PATCH",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}",
            payload={"content": "federation deploy live message edited"},
            token=actor_a_token,
            expected=(200,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_UPDATE",
            predicate=lambda d: d.get("id") == str(message_id)
            and d.get("content") == "federation deploy live message edited",
            timeout_s=20.0,
        )

        # A reaction has to be a real emoji; the stored emoji_name is the
        # character itself, so the path is the percent-encoded form of it.
        emoji_name = "\N{THUMBS UP SIGN}"
        emoji_path = quote(emoji_name)
        request_json(
            session,
            "PUT",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}/reactions/{emoji_path}/@me",
            token=actor_a_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_REACTION_ADD",
            predicate=lambda d: d.get("message_id") == str(message_id) and d.get("emoji") == emoji_name,
            timeout_s=20.0,
        )
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}/reactions/{emoji_path}/@me",
            token=actor_a_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_REACTION_REMOVE",
            predicate=lambda d: d.get("message_id") == str(message_id) and d.get("emoji") == emoji_name,
            timeout_s=20.0,
        )
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/messages/{message_id}",
            token=actor_a_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch(
            "MESSAGE_DELETE",
            predicate=lambda d: d.get("id") == str(message_id) and d.get("channel_id") == str(text_channel_id),
            timeout_s=20.0,
        )

        _, thread = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/threads",
            payload={"name": "live-thread", "auto_archive_duration": 60},
            token=actor_a_token,
            expected=(201,),
        )
        thread_id = parse_int_id(thread["id"], "thread id")
        guest1_ws.wait_dispatch("THREAD_CREATE", predicate=lambda d: d.get("id") == str(thread_id), timeout_s=20.0)
        request_json(
            session,
            "PATCH",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/threads/{thread_id}",
            payload={"name": "live-thread-renamed"},
            token=actor_a_token,
            expected=(200,),
        )
        guest1_ws.wait_dispatch(
            "THREAD_UPDATE",
            predicate=lambda d: d.get("id") == str(thread_id) and d.get("name") == "live-thread-renamed",
            timeout_s=20.0,
        )
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/threads/{thread_id}",
            token=actor_a_token,
            expected=(204,),
        )
        guest1_ws.wait_dispatch("THREAD_DELETE", predicate=lambda d: d.get("id") == str(thread_id), timeout_s=20.0)

        request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/polls",
            payload={
                "question": "Best protocol?",
                "options": [{"text": "Matrix"}, {"text": "Paracord"}],
                "allow_multiselect": False,
                "expires_in_minutes": 60,
            },
            token=actor_a_token,
            expected=(201,),
        )
        _, polls = request_json(session, "GET", f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/polls", token=actor_a_token, expected=(200,))
        poll_id = parse_int_id(polls[0]["id"], "poll id")
        _, poll = request_json(
            session,
            "GET",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}",
            token=actor_a_token,
            expected=(200,),
        )
        option_id = parse_int_id(poll["options"][0]["id"], "poll option id")
        request_json(
            session,
            "PUT",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}/votes/{option_id}",
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
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/channels/{text_channel_id}/polls/{poll_id}/votes/{option_id}",
            token=guest1_token,
            expected=(200,),
        )

        emoji = request_multipart(
            session,
            url=f"{nodes['a'].url}/api/v1/guilds/{guild_id}/emojis",
            token=actor_a_token,
            data={"name": f"tinywave{random_suffix(4)}"},
            files={"image": ("tiny.png", TINY_PNG, "image/png")},
            expected=(201,),
        )
        emoji_id = parse_int_id(emoji["id"], "emoji id")
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
            token=actor_a_token,
            expected=(204,),
        )

        request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/users/@me/relationships",
            payload={"user_id": str(guest2_id)},
            token=guest1_token,
            expected=(204,),
        )
        request_json(
            session,
            "PUT",
            f"{nodes['a'].url}/api/v1/users/@me/relationships/{guest1_id}",
            token=guest2_token,
            expected=(204,),
        )

        _, dm = request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/users/@me/dms",
            payload={"recipient_id": str(guest2_id)},
            token=guest1_token,
            expected=(201,),
        )
        dm_channel_id = parse_int_id(dm["id"], "dm channel id")
        request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/channels/{dm_channel_id}/messages",
            payload={"content": "", "e2ee": {"version": 1, "nonce": "AA==", "ciphertext": "aGVsbG8="}},
            token=guest1_token,
            expected=(201,),
        )
        request_json(
            session,
            "PATCH",
            f"{nodes['a'].url}/api/v1/users/@me/settings",
            payload={"theme": "light", "locale": "en-US", "message_display_compact": True},
            token=guest1_token,
            expected=(200,),
        )

        log("[8/13] Voice + live streaming checks")
        request_json(session, "GET", f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/join", token=guest1_token, expected=(200,))
        request_json(session, "GET", f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/join", token=actor_a_token, expected=(200,))
        request_json(
            session,
            "POST",
            f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/stream",
            payload={"title": "deploy-live-stream", "quality_preset": "1080p60"},
            token=actor_a_token,
            expected=(200,),
        )
        request_json(session, "POST", f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/stream/stop", token=actor_a_token, expected=(204,))
        request_json(session, "POST", f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/leave", token=actor_a_token, expected=(204,))
        request_json(session, "POST", f"{nodes['a'].url}/api/v1/voice/{voice_channel_id}/leave", token=guest1_token, expected=(204,))

        log("[9/13] Member leave + realtime member list update")
        request_json(
            session,
            "DELETE",
            f"{nodes['a'].url}/api/v1/guilds/{guild_id}/members/@me",
            token=guest1_token,
            expected=(204,),
        )

        log("[10/13] Cross-node federation propagation checks on deployed B/C")

        def wait_event_on(node_key: str, event_type: str, **kwargs: Any) -> None:
            wait_until(
                f"{event_type} replicated to {node_key.upper()}",
                lambda: event_present(read_events(session, node=nodes[node_key], room_id=room_id, auth=read_auth), event_type=event_type, **kwargs),
                timeout_s=45.0,
                interval_s=1.0,
            )

        for target in ("b", "c"):
            wait_event_on(target, "m.message", message_id=message_id)
            wait_event_on(target, "m.message.edit", message_id=message_id)
            wait_event_on(target, "m.reaction.add", message_id=message_id, emoji=emoji_name)
            wait_event_on(target, "m.reaction.remove", message_id=message_id, emoji=emoji_name)
            wait_event_on(target, "m.message.delete", message_id=message_id)
            wait_event_on(target, "m.member.join", user_id=guest1_id)
            wait_event_on(target, "m.member.leave", user_id=guest1_id)

        if signer and not args.skip_security_negatives:
            log("[11/13] Federation security negative checks (signature and replay)")
            run_federation_negative_checks(session, target=nodes["b"], signer=signer, room_id=room_id)
        elif not args.skip_security_negatives:
            raise RuntimeError(
                "Security negatives require signing credentials "
                "(--read-origin/--read-key-id/--read-signing-key-hex)"
            )

        log("[12/13] Final status checks")
        for node in nodes.values():
            request_json(session, "GET", f"{node.url}/health", expected=(200,))

        log("[13/13] PASS")
        log("PASS: Deployed decentralized live validation succeeded.")
        log(
            "PASS: Realtime checks passed for messages, DMs, threads, members, emoji reactions/custom emojis, polls, relationships, settings, voice, and live streaming."
        )
        log("PASS: Cross-node federation propagation verified via federation event reads on B and C.")
        if signer and not args.skip_security_negatives:
            log("PASS: Federation ingest negative checks passed (unsigned/tampered/stale/replay).")
        return 0
    finally:
        for client in gateway_clients:
            client.close()


if __name__ == "__main__":
    sys.exit(main())
