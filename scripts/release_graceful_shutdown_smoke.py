#!/usr/bin/env python3
"""Release-binary graceful shutdown smoke test."""

from __future__ import annotations

import argparse
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests


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
        proc.send_signal(signal.SIGINT)


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
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-shutdown-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
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
            try:
                startup_seconds = wait_for_health(base_url, proc)
                send_interrupt(proc)
                try:
                    proc.wait(timeout=args.timeout)
                except subprocess.TimeoutExpired:
                    forced = True
                    proc.kill()
                    proc.wait(timeout=10)
            finally:
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
            "PASS: release server graceful shutdown smoke passed; "
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
