#!/usr/bin/env python3
"""Run release-binary security smoke checks against a temporary server.

This starts `target/release/paracord-server` with a throwaway SQLite database,
waits for health, then runs the lightweight DAST and API fuzz scripts against
that real release binary.
"""

from __future__ import annotations

import argparse
import os
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


def run_child(label: str, command: list[str]) -> None:
    completed = subprocess.run(command, cwd=str(ROOT), text=True, capture_output=True, timeout=180)
    if completed.stdout:
        print(completed.stdout, end="" if completed.stdout.endswith("\n") else "\n")
    if completed.stderr:
        print(completed.stderr, file=sys.stderr, end="" if completed.stderr.endswith("\n") else "\n")
    if completed.returncode != 0:
        raise RuntimeError(f"{label} failed with exit code {completed.returncode}")


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(prefix="paracord-security-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-security-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
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
        try:
            wait_for_health(base_url, proc)
            run_child(
                "DAST smoke",
                [sys.executable, "scripts/security_dast_smoke.py", "--base-url", base_url],
            )
            run_child(
                "API fuzz smoke",
                [
                    sys.executable,
                    "scripts/security_api_fuzz.py",
                    "--base-url",
                    base_url,
                    "--iterations",
                    str(args.fuzz_iterations),
                ],
            )
            print("PASS: release server security smoke passed")
        finally:
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
    parser.add_argument("--port", type=int, default=18104)
    parser.add_argument("--fuzz-iterations", type=int, default=120)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
