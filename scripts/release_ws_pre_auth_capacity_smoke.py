#!/usr/bin/env python3
"""Release-binary pre-auth WebSocket capacity smoke test."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

try:
    import websocket
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit(
        "Missing dependency: websocket-client. Install it before running this smoke."
    ) from exc


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


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")
    if args.connections <= args.max_connections:
        raise ValueError("--connections must be greater than --max-connections")

    with tempfile.TemporaryDirectory(prefix="paracord-ws-preauth-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        ws_url = f"ws://127.0.0.1:{args.port}/gateway"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "ws-preauth-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_WS_MAX_CONNECTIONS": str(args.max_connections),
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
        sockets: list[websocket.WebSocket] = []
        hello_count = 0
        closed_count = 0

        try:
            wait_for_health(base_url, proc)
            for _ in range(args.connections):
                ws = websocket.create_connection(ws_url, timeout=3)
                try:
                    payload = ws.recv()
                    if '"op":10' in payload or '"op": 10' in payload:
                        hello_count += 1
                        sockets.append(ws)
                    else:
                        ws.close()
                        closed_count += 1
                except websocket.WebSocketConnectionClosedException:
                    closed_count += 1
                except websocket.WebSocketTimeoutException as exc:
                    ws.close()
                    raise AssertionError("gateway connection timed out before HELLO/close") from exc

            if hello_count != args.max_connections:
                raise AssertionError(
                    f"expected exactly {args.max_connections} pre-auth HELLO sockets, got {hello_count}"
                )
            if closed_count != args.connections - args.max_connections:
                raise AssertionError(
                    f"expected {args.connections - args.max_connections} overflow closes, got {closed_count}"
                )

            print(
                "PASS: pre-auth websocket capacity enforced "
                f"(hello={hello_count}, overflow_closed={closed_count})"
            )
        finally:
            for ws in sockets:
                try:
                    ws.close()
                except Exception:
                    pass
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
    parser.add_argument("--port", type=int, default=18127)
    parser.add_argument("--max-connections", type=int, default=3)
    parser.add_argument("--connections", type=int, default=5)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
