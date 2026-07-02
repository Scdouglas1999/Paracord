#!/usr/bin/env python3
"""Release-binary chat, voice, and pagination load smoke test."""

from __future__ import annotations

import argparse
import ctypes
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import requests


ROOT = Path(__file__).resolve().parents[1]
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
PROCESS_VM_READ = 0x0010


class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("cb", ctypes.c_ulong),
        ("PageFaultCount", ctypes.c_ulong),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
    ]


def release_server_path() -> Path:
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    return ROOT / "target" / "release" / name


def rss_bytes(pid: int) -> int | None:
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, False, pid)
        if not handle:
            return None
        try:
            counters = PROCESS_MEMORY_COUNTERS()
            counters.cb = ctypes.sizeof(counters)
            ok = psapi.GetProcessMemoryInfo(handle, ctypes.byref(counters), counters.cb)
            return int(counters.WorkingSetSize) if ok else None
        finally:
            kernel32.CloseHandle(handle)

    status_path = Path(f"/proc/{pid}/status")
    if status_path.exists():
        for line in status_path.read_text(encoding="utf-8", errors="ignore").splitlines():
            if line.startswith("VmRSS:"):
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    return None


def assert_status(response: requests.Response, expected: int | tuple[int, ...], label: str) -> None:
    ok = response.status_code in expected if isinstance(expected, tuple) else response.status_code == expected
    if not ok:
        raise AssertionError(f"{label}: expected {expected}, got {response.status_code}: {response.text[:500]}")


def request_json(
    session: requests.Session,
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    expected: int | tuple[int, ...] = 200,
    label: str,
) -> Any:
    session.cookies.clear()
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    response = session.request(method, f"{base_url}{path}", headers=headers, json=body, timeout=20)
    assert_status(response, expected, label)
    return response.json() if response.text else None


def send_message_with_retry(
    session: requests.Session,
    base_url: str,
    channel_id: str,
    token: str,
    content: str,
) -> tuple[Any, int]:
    retries = 0
    while True:
        session.cookies.clear()
        response = session.post(
            f"{base_url}/api/v1/channels/{channel_id}/messages",
            headers={"Authorization": f"Bearer {token}"},
            json={"content": content},
            timeout=20,
        )
        if response.status_code != 429:
            assert_status(response, 201, "send message")
            return response.json(), retries

        retries += 1
        try:
            retry_after = float(response.json().get("retry_after") or 1)
        except ValueError:
            retry_after = 1.0
        time.sleep(max(retry_after, 0.25) + 0.05)


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

    with tempfile.TemporaryDirectory(prefix="paracord-load-smoke-") as temp_dir:
        data = Path(temp_dir)
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "release-load-smoke-secret-0123456789abcdef",
                "PARACORD_TLS_ENABLED": "false",
                "PARACORD_STORAGE_PATH": str(data / "uploads"),
                "PARACORD_MEDIA_STORAGE_PATH": str(data / "files"),
                "PARACORD_BACKUP_DIR": str(data / "backups"),
                "PARACORD_REGISTRATION_ENABLED": "true",
                "PARACORD_AUTH_REQUIRE_EMAIL": "true",
                "PARACORD_LOG_ANSI": "false",
                "PARACORD_VOICE_NATIVE_MEDIA": "true",
                "PARACORD_VOICE_PORT": str(args.port + 1000),
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
            idle_rss = rss_bytes(proc.pid)
            session = requests.Session()

            admin = request_json(
                session,
                "POST",
                base_url,
                "/api/v1/auth/register",
                body={"email": "load@example.com", "username": "loaduser", "password": "Loadpass123!"},
                expected=201,
                label="register load user",
            )
            token = admin["token"]
            guild = request_json(
                session,
                "POST",
                base_url,
                "/api/v1/guilds",
                token=token,
                body={"name": "Release Load Guild", "icon": None},
                expected=201,
                label="create load guild",
            )
            channel = request_json(
                session,
                "POST",
                base_url,
                f"/api/v1/guilds/{guild['id']}/channels",
                token=token,
                body={"name": "load-chat", "channel_type": 0, "parent_id": None, "required_role_ids": None},
                expected=201,
                label="create load channel",
            )
            channel_id = channel["id"]
            voice_channel = request_json(
                session,
                "POST",
                base_url,
                f"/api/v1/guilds/{guild['id']}/channels",
                token=token,
                body={"name": "load-voice", "channel_type": 2, "parent_id": None, "required_role_ids": None},
                expected=201,
                label="create load voice channel",
            )
            voice_channel_id = voice_channel["id"]

            start = time.perf_counter()
            first_message_id: str | None = None
            rate_limit_retries = 0
            for i in range(args.messages):
                message, retries = send_message_with_retry(
                    session,
                    base_url,
                    channel_id,
                    token,
                    f"release load smoke message {i:04d}",
                )
                rate_limit_retries += retries
                if first_message_id is None:
                    first_message_id = message["id"]
            send_seconds = time.perf_counter() - start

            page_start = time.perf_counter()
            page = request_json(
                session,
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/messages?limit=100",
                token=token,
                label="page latest messages",
            )
            page_seconds = time.perf_counter() - page_start
            if len(page) != min(args.messages, 100):
                raise AssertionError(f"unexpected first page size: {len(page)}")

            before_page_start = time.perf_counter()
            before_page = request_json(
                session,
                "GET",
                base_url,
                f"/api/v1/channels/{channel_id}/messages?limit=50&before={first_message_id}",
                token=token,
                label="page before first message",
            )
            before_page_seconds = time.perf_counter() - before_page_start
            if before_page:
                raise AssertionError(f"before-first pagination should be empty, got {len(before_page)}")

            loaded_rss = rss_bytes(proc.pid)
            if page_seconds > args.max_page_seconds or before_page_seconds > args.max_page_seconds:
                raise AssertionError(
                    "message pagination exceeded threshold: "
                    f"latest={page_seconds:.3f}s before={before_page_seconds:.3f}s "
                    f"threshold={args.max_page_seconds:.3f}s"
                )

            voice_tokens = [token]
            if args.voice_participants > 1:
                invite = request_json(
                    session,
                    "POST",
                    base_url,
                    f"/api/v1/channels/{channel_id}/invites",
                    token=token,
                    body={"max_uses": args.voice_participants - 1, "max_age": 3600},
                    expected=201,
                    label="create voice load invite",
                )
                code = invite["code"]
                for i in range(1, args.voice_participants):
                    user = request_json(
                        session,
                        "POST",
                        base_url,
                        "/api/v1/auth/register",
                        body={
                            "email": f"voice-load-{i}@example.com",
                            "username": f"voiceload{i}",
                            "password": "Loadpass123!",
                        },
                        expected=201,
                        label=f"register voice load user {i}",
                    )
                    user_token = user["token"]
                    request_json(
                        session,
                        "POST",
                        base_url,
                        f"/api/v1/invites/{code}",
                        token=user_token,
                        body={},
                        label=f"accept voice load invite {i}",
                    )
                    voice_tokens.append(user_token)

            voice_start = time.perf_counter()
            voice_sessions: list[str] = []
            for i, voice_token in enumerate(voice_tokens):
                join = request_json(
                    session,
                    "GET",
                    base_url,
                    f"/api/v1/voice/{voice_channel_id}/join",
                    token=voice_token,
                    label=f"join native voice {i}",
                )
                if join.get("native_media") is not True:
                    raise AssertionError(f"native voice join did not return native_media=true: {join}")
                session_id = join.get("session_id")
                if not session_id:
                    raise AssertionError(f"native voice join missing session_id: {join}")
                voice_sessions.append(session_id)

            stream = request_json(
                session,
                "POST",
                base_url,
                f"/api/v1/voice/{voice_channel_id}/stream",
                token=voice_tokens[0],
                body={"title": "Release load smoke stream", "quality_preset": "720p30"},
                label="start native voice load stream",
            )
            if stream.get("native_media") is not True:
                raise AssertionError(f"native stream did not return native_media=true: {stream}")
            request_json(
                session,
                "POST",
                base_url,
                f"/api/v1/voice/{voice_channel_id}/stream/stop",
                token=voice_tokens[0],
                expected=204,
                label="stop native voice load stream",
            )
            for i, (voice_token, session_id) in enumerate(zip(voice_tokens, voice_sessions)):
                request_json(
                    session,
                    "POST",
                    base_url,
                    f"/api/v1/voice/{voice_channel_id}/leave?session_id={session_id}",
                    token=voice_token,
                    expected=204,
                    label=f"leave native voice {i}",
                )
            voice_seconds = time.perf_counter() - voice_start
            voice_rss = rss_bytes(proc.pid)

            print("PASS: release server chat and native voice load smoke passed")
            print(
                " ".join(
                    [
                        f"messages={args.messages}",
                        f"voice_participants={len(voice_tokens)}",
                        f"rate_limit_retries={rate_limit_retries}",
                        f"send_seconds={send_seconds:.3f}",
                        f"page_seconds={page_seconds:.3f}",
                        f"before_page_seconds={before_page_seconds:.3f}",
                        f"voice_seconds={voice_seconds:.3f}",
                        f"idle_rss_bytes={idle_rss if idle_rss is not None else 'unknown'}",
                        f"loaded_rss_bytes={loaded_rss if loaded_rss is not None else 'unknown'}",
                        f"voice_rss_bytes={voice_rss if voice_rss is not None else 'unknown'}",
                    ]
                )
            )
        finally:
            if "session" in locals():
                session.close()
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
    parser.add_argument("--port", type=int, default=18106)
    parser.add_argument("--messages", type=int, default=250)
    parser.add_argument("--max-page-seconds", type=float, default=2.0)
    parser.add_argument("--voice-participants", type=int, default=4)
    args = parser.parse_args()
    if args.voice_participants < 1:
        parser.error("--voice-participants must be at least 1")
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
