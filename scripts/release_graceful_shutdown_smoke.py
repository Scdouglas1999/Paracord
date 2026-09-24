#!/usr/bin/env python3
"""Release-binary graceful shutdown smoke test.

Also covers the restart notice: a connected gateway session must be told the
server is going away *before* the listeners are torn down, so the client can
show "Server is restarting — you'll reconnect automatically" instead of a bare
connection loss. On POSIX the signal used is SIGTERM, because that is what
`systemctl restart` and `docker stop` actually send.

And it covers the drain the notice precedes. A browser holds two connections
open for as long as its tab is: the realtime SSE stream and the gateway
websocket. `with_graceful_shutdown` waits for every in-flight connection, so
until those two end themselves a restart never completed at all — the process
sat there until something SIGKILLed it. This smoke attaches both, and requires
that each is told before it is closed, that the process exits within the
graceful budget, and that it exits because the connections went rather than
because the drain deadline ran out.
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


def connect_identified_gateway(base_url: str, port: int) -> tuple["websocket.WebSocket", str]:
    """Register an account and bring one gateway session to READY.

    Returns the live socket and the account's access token, which the realtime
    stream below needs to mint its own ticket.
    """
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
            return ws, token
    raise TimeoutError("gateway session never reached READY")


def open_realtime_stream(base_url: str, token: str, timeout_seconds: float):
    """Attach the SSE realtime stream and read it up to its READY frame.

    This is the connection a browser holds open for the life of the tab, and the
    one that used to make `with_graceful_shutdown` wait forever.
    """
    ticket_resp = requests.post(
        f"{base_url}/api/v1/stream/ticket",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    ticket_resp.raise_for_status()
    ticket = ticket_resp.json()["ticket"]

    stream = requests.get(
        f"{base_url}/api/v2/rt/events",
        params={"ticket": ticket},
        headers={"Accept": "text/event-stream"},
        stream=True,
        timeout=(10, timeout_seconds),
    )
    stream.raise_for_status()
    lines = stream.iter_lines(decode_unicode=True)
    deadline = time.time() + timeout_seconds
    while time.time() < deadline:
        frame = next_stream_frame(lines)
        if frame is None:
            raise AssertionError("the realtime stream ended before READY")
        if frame.get("t") == "READY":
            return stream, lines
    raise TimeoutError("realtime stream never reached READY")


def next_stream_frame(lines) -> dict[str, Any] | None:
    """Next parsed `data:` frame from an SSE line iterator, or None at end."""
    for line in lines:
        if not line or not line.startswith("data:"):
            continue
        payload = line[len("data:") :].strip()
        if not payload or payload == "keep-alive":
            continue
        try:
            return json.loads(payload)
        except json.JSONDecodeError as exc:
            raise AssertionError(f"invalid JSON SSE payload: {payload!r}") from exc
    return None


def wait_for_stream_restart_notice(lines, timeout_seconds: float) -> None:
    """The stream must carry the notice and then end, by itself, promptly."""
    deadline = time.time() + timeout_seconds
    saw_notice = False
    while time.time() < deadline:
        try:
            frame = next_stream_frame(lines)
        except requests.RequestException as exc:
            raise AssertionError(
                "the realtime stream was cut off instead of being closed cleanly"
            ) from exc
        if frame is None:
            if not saw_notice:
                raise AssertionError(
                    "the realtime stream ended without a SERVER_RESTART notice"
                )
            return
        if frame.get("t") == "SERVER_RESTART":
            saw_notice = True
    raise AssertionError("the realtime stream neither notified nor ended before the timeout")


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
                "PARACORD_REGISTRATION_MODE": "open",
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
            stream = None
            exit_seconds = 0.0
            try:
                startup_seconds = wait_for_health(base_url, proc)
                watcher, token = connect_identified_gateway(base_url, args.port)
                # Both of the connections a real client holds open, attached at
                # once: this is the state in which the process used to hang.
                stream, stream_lines = open_realtime_stream(base_url, token, args.timeout)
                signaled_at = time.time()
                send_interrupt(proc)
                # Read the notice off each live connection before the process is
                # gone: it has to arrive ahead of the teardown, not after it.
                wait_for_restart_notice(watcher, args.timeout)
                wait_for_stream_restart_notice(stream_lines, args.timeout)
                try:
                    proc.wait(timeout=args.timeout)
                    exit_seconds = time.time() - signaled_at
                except subprocess.TimeoutExpired:
                    forced = True
                    proc.kill()
                    proc.wait(timeout=10)
            finally:
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
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
        # The deadline is the backstop for a client that will not let go, not
        # the way a healthy restart ends. Reaching it here would mean the
        # connections never closed themselves after all.
        if "Exiting with connections still open" in log_text:
            raise AssertionError(
                "the drain deadline expired: attached connections did not end themselves\n"
                f"{log_text[-1500:]}"
            )
        if exit_seconds > args.exit_deadline:
            raise AssertionError(
                f"exit took {exit_seconds:.2f}s with clients attached, over the "
                f"{args.exit_deadline:.2f}s budget"
            )
        print(
            "PASS: release server graceful shutdown smoke passed "
            "(SIGTERM handled, SERVER_RESTART delivered to gateway and realtime stream "
            "before teardown, both connections drained without the deadline); "
            f"startup_health_seconds={startup_seconds:.2f}; exit_seconds={exit_seconds:.2f}; "
            f"returncode={proc.returncode}; log_bytes={len(log_text)}"
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--server", help="Path to release server binary")
    parser.add_argument("--port", type=int, default=18126)
    parser.add_argument("--timeout", type=float, default=12.0)
    # The graceful budget with clients attached: the restart-notice flush, the
    # worker grace period, and the connection drain deadline, plus slack.
    parser.add_argument("--exit-deadline", type=float, default=11.0)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
