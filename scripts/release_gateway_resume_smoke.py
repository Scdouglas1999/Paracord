#!/usr/bin/env python3
"""Release-binary WebSocket gateway resume/replay smoke test."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests

try:
    import websocket
except ImportError as exc:  # pragma: no cover - actionable local setup failure
    raise SystemExit(
        "Missing dependency: websocket-client. Install it before running this smoke."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def assert_status(response: requests.Response, expected: int, label: str) -> None:
    if response.status_code != expected:
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
    expected: int = 200,
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


def start_server(
    server: Path,
    config_path: Path,
    env: dict[str, str],
    base_url: str,
) -> subprocess.Popen[object]:
    proc = subprocess.Popen(
        [str(server), "-c", str(config_path)],
        cwd=str(ROOT),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
    )
    wait_for_health(base_url, proc)
    return proc


def stop_server(proc: subprocess.Popen[object]) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=10)


def recv_json(ws: websocket.WebSocket, label: str) -> dict[str, Any]:
    try:
        raw = ws.recv()
    except websocket.WebSocketTimeoutException as exc:
        raise TimeoutError(f"timed out waiting for {label}") from exc
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{label}: invalid JSON websocket payload: {raw!r}") from exc


def connect_gateway(ws_url: str) -> websocket.WebSocket:
    websocket.enableTrace(False)
    ws = websocket.create_connection(ws_url, timeout=5)
    hello = recv_json(ws, "gateway HELLO")
    if hello.get("op") != 10:
        raise AssertionError(f"expected gateway HELLO, got {hello}")
    return ws


def identify(ws: websocket.WebSocket, token: str) -> tuple[str, int]:
    ws.send(json.dumps({"op": 2, "d": {"token": token}}))
    ready = wait_dispatch(ws, "READY")
    session_id = ready.get("d", {}).get("session_id")
    sequence = ready.get("s")
    if not isinstance(session_id, str) or not isinstance(sequence, int):
        raise AssertionError(f"READY missing session_id/sequence: {ready}")
    return session_id, sequence


def resume(ws: websocket.WebSocket, token: str, session_id: str, sequence: int) -> dict[str, Any]:
    ws.send(
        json.dumps(
            {
                "op": 6,
                "d": {
                    "token": token,
                    "session_id": session_id,
                    "seq": sequence,
                },
            }
        )
    )
    return wait_dispatch(ws, "RESUMED")


def wait_dispatch(ws: websocket.WebSocket, event_type: str, timeout_seconds: float = 10.0) -> dict[str, Any]:
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        payload = recv_json(ws, event_type)
        if payload.get("op") == 0 and payload.get("t") == event_type:
            return payload
    raise TimeoutError(f"timed out waiting for {event_type}")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-gateway-resume-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        ws_url = f"ws://127.0.0.1:{args.port}/gateway"
        config_path = data / "paracord.toml"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-gateway-resume-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
            }
        )

        proc: subprocess.Popen[object] | None = None
        ws: websocket.WebSocket | None = None
        resumed_ws: websocket.WebSocket | None = None
        fallback_ws: websocket.WebSocket | None = None
        try:
            proc = start_server(server, config_path, env, base_url)
            admin = request_json(
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={
                    "email": "gateway-resume-admin@example.com",
                    "username": "gatewayresume",
                    "password": "GatewayResume123!",
                },
                expected=201,
                label="register admin",
            )
            token = admin["token"]
            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=token,
                body={"name": "Gateway Resume Guild", "icon": None},
                expected=201,
                label="create guild",
            )
            channel = request_json(
                "POST",
                base_url,
                f"/api/v1/guilds/{guild['id']}/channels",
                token=token,
                body={
                    "name": "gateway-resume-text",
                    "channel_type": 0,
                    "parent_id": None,
                    "required_role_ids": None,
                },
                expected=201,
                label="create channel",
            )

            ws = connect_gateway(ws_url)
            session_id, ready_seq = identify(ws, token)
            message = request_json(
                "POST",
                base_url,
                f"/api/v1/channels/{channel['id']}/messages",
                token=token,
                body={"content": "gateway replay me"},
                expected=201,
                label="create websocket replay message",
            )
            first_event = wait_dispatch(ws, "MESSAGE_CREATE")
            if first_event.get("d", {}).get("id") != message["id"]:
                raise AssertionError(f"unexpected live message event: {first_event}")
            event_seq = first_event.get("s")
            if not isinstance(event_seq, int) or event_seq <= ready_seq:
                raise AssertionError(f"unexpected live event sequence: {first_event}")
            ws.close()
            ws = None
            time.sleep(0.5)

            resumed_ws = connect_gateway(ws_url)
            resumed = resume(resumed_ws, token, session_id, ready_seq)
            if resumed.get("d", {}).get("session_id") != session_id:
                raise AssertionError(f"unexpected RESUMED payload: {resumed}")
            replayed = wait_dispatch(resumed_ws, "MESSAGE_CREATE")
            if replayed.get("s") != event_seq or replayed.get("d", {}).get("id") != message["id"]:
                raise AssertionError(f"unexpected replayed event: {replayed}")
            resumed_ws.close()
            resumed_ws = None
            time.sleep(0.5)

            fallback_ws = connect_gateway(ws_url)
            fallback_ws.send(
                json.dumps(
                    {
                        "op": 6,
                        "d": {
                            "token": token,
                            "session_id": "missing-session",
                            "seq": 0,
                        },
                    }
                )
            )
            fallback_ready = wait_dispatch(fallback_ws, "READY")
            if fallback_ready.get("d", {}).get("session_id") == "missing-session":
                raise AssertionError(f"resume cache miss reused missing session: {fallback_ready}")

            print("PASS: release gateway resume/replay smoke passed")
            print(
                " ".join(
                    [
                        f"guild={guild['id']}",
                        f"channel={channel['id']}",
                        f"message={message['id']}",
                        f"session={session_id}",
                        f"ready_seq={ready_seq}",
                        f"event_seq={event_seq}",
                    ]
                )
            )
        finally:
            for socket in (fallback_ws, resumed_ws, ws):
                if socket is not None:
                    try:
                        socket.close()
                    except Exception:
                        pass
            if proc is not None:
                stop_server(proc)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18139)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
