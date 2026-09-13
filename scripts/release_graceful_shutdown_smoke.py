#!/usr/bin/env python3
"""Release-binary graceful shutdown smoke test.

Also covers the restart notice: a connected gateway session must be told the
server is going away *before* the listeners are torn down, so the client can
show "Server is restarting — you'll reconnect automatically" instead of a bare
connection loss. On POSIX the signal used is SIGTERM, because that is what
`systemctl restart` and `docker stop` actually send.
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests

try:
    import websocket
except ImportError as exc:  # pragma: no cover - dependency guard
    raise SystemExit(
        "Missing dependency: websocket-client. Install it before running this smoke."
    ) from exc


ROOT = Path(__file__).resolve().parents[1]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def wait_for_health(base_url: str, proc: subprocess.Popen[object]) -> float:
    start = time.time()
    for _ in range(90):
        if proc.poll() is not None:
            raise RuntimeError(f"server exited early with {proc.returncode}")
        try:
            if requests.get(f"{base_url}/health", timeout=2).status_code == 200:
                return time.time() - start
        except requests.RequestException:
            pass
        time.sleep(0.5)
    raise TimeoutError("server did not become healthy")


def send_interrupt(proc: subprocess.Popen[object]) -> None:
    if os.name == "nt":
        proc.send_signal(signal.CTRL_BREAK_EVENT)
    else:
        # SIGTERM, not SIGINT: this is the signal a supervisor sends, and the
        # graceful path has to answer it or `systemctl restart` kills the
        # process outright.
        proc.send_signal(signal.SIGTERM)


def recv_json(ws: "websocket.WebSocket", label: str) -> dict[str, Any]:
    raw = ws.recv()
    if isinstance(raw, bytes):
        raw = raw.decode("utf-8")
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AssertionError(f"{label}: invalid JSON websocket payload: {raw!r}") from exc


def connect_identified_gateway(base_url: str, port: int) -> "websocket.WebSocket":
    """Register an account and bring one gateway session to READY."""
    account = {
        "username": "shutdownwatcher",
        "email": "shutdown-watcher@example.com",
        "password": "Sup3rStr0ng!Passw0rd",
        "display_name": "Shutdown watcher",
    }
    response = requests.post(f"{base_url}/api/v1/auth/register", json=account, timeout=10)
    response.raise_for_status()
    token = response.json()["token"]

    websocket.enableTrace(False)
    ws = websocket.create_connection(f"ws://127.0.0.1:{port}/gateway", timeout=10)
    hello = recv_json(ws, "gateway HELLO")
    if hello.get("op") != 10:
        raise AssertionError(f"expected gateway HELLO, got {hello}")
    ws.send(json.dumps({"op": 2, "d": {"token": token}}))
    deadline = time.time() + 10
    while time.time() < deadline:
        frame = recv_json(ws, "READY")
        if frame.get("op") == 0 and frame.get("t") == "READY":
            return ws
    raise TimeoutError("gateway session never reached READY")


def wait_for_restart_notice(ws: "websocket.WebSocket", timeout_seconds: float) -> None:
    ws.settimeout(timeout_seconds)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        try:
            frame = recv_json(ws, "SERVER_RESTART")
        except (websocket.WebSocketTimeoutException, websocket.WebSocketConnectionClosedException) as exc:
            raise AssertionError(
                "the connection dropped without a SERVER_RESTART notice"
            ) from exc
        if frame.get("op") == 0 and frame.get("t") == "SERVER_RESTART":
            return
    raise AssertionError("no SERVER_RESTART notice before the timeout")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-shutdown-smoke-") as temp_dir:
        data = Path(temp_dir)
        log_path = data / "server.log"
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                # Native voice binds UDP 8443 by default — the product port, not
                # a test one — so every smoke that left it alone fought every
                # other smoke and anything real on the host for it, and two
                # could never run at once. Derive it from this smoke's own HTTP
                # port unless the caller named one.
                "PARACORD_VOICE_PORT": env.get("PARACORD_VOICE_PORT", str(args.port + 1000)),
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-shutdown-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                # The watcher account registers itself, so this throwaway
                # instance is bootstrapped without a first-owner claim.
                "PARACORD_SETUP_REQUIRE_CLAIM": "false",
                "PARACORD_LOG_ANSI": "false",
                "RUST_LOG": "info",
            }
        )

        creationflags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        with log_path.open("w", encoding="utf-8") as log_file:
            proc = subprocess.Popen(
                [str(server), "-c", str(data / "paracord.toml")],
                cwd=str(ROOT),
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
                creationflags=creationflags,
            )
            forced = False
            watcher: "websocket.WebSocket | None" = None
            try:
                startup_seconds = wait_for_health(base_url, proc)
                watcher = connect_identified_gateway(base_url, args.port)
                send_interrupt(proc)
                # Read the notice off the live socket before the process is
                # gone: it has to arrive ahead of the teardown, not after it.
                wait_for_restart_notice(watcher, args.timeout)
                try:
                    proc.wait(timeout=args.timeout)
                except subprocess.TimeoutExpired:
                    forced = True
                    proc.kill()
                    proc.wait(timeout=10)
            finally:
                if watcher is not None:
                    try:
                        watcher.close()
                    except OSError:
                        pass
                if proc.poll() is None:
                    forced = True
                    proc.kill()
                    proc.wait(timeout=10)

        log_text = log_path.read_text(encoding="utf-8", errors="replace")
        if forced:
            raise AssertionError("server did not exit after interrupt before timeout")
        success_returncodes = {0, 130}
        if os.name == "nt":
            success_returncodes.update({0xC000013A, -1073741510})
        if proc.returncode not in success_returncodes:
            raise AssertionError(f"unexpected shutdown return code {proc.returncode}")
        if "Shutting down" not in log_text:
            raise AssertionError(f"shutdown log line missing from captured logs: {log_text[-1000:]}")
        print(
            "PASS: release server graceful shutdown smoke passed "
            "(SIGTERM handled, SERVER_RESTART delivered before teardown); "
            f"startup_health_seconds={startup_seconds:.2f}; returncode={proc.returncode}; "
            f"log_bytes={len(log_text)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18126)
    parser.add_argument("--timeout", type=float, default=12.0)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
