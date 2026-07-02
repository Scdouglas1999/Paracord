#!/usr/bin/env python3
"""Release-binary bot store review/metrics smoke test."""

from __future__ import annotations

import argparse
import os
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

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


def request_json(
    method: str,
    base_url: str,
    path: str,
    *,
    token: str | None = None,
    body: Any = None,
    expected: int | tuple[int, ...] = 200,
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
    ok = response.status_code in expected if isinstance(expected, tuple) else response.status_code == expected
    if not ok:
        raise AssertionError(
            f"{method} {path}: expected {expected}, got {response.status_code}: {response.text[:300]}"
        )
    return response.json() if response.text else None


def register(base_url: str, email: str, username: str) -> dict[str, Any]:
    return request_json(
        "POST",
        base_url,
        "/api/v1/auth/register",
        body={"email": email, "username": username, "password": "BotStore123!"},
        expected=201,
    )


def publish_bot_in_store(db_path: Path, app_id: str) -> None:
    deadline = time.time() + 10
    while True:
        try:
            with sqlite3.connect(db_path, timeout=5) as conn:
                cur = conn.execute(
                    """
                    UPDATE bot_applications
                    SET public_listed = 1,
                        category = 'utility',
                        tags = 'moderation,productivity',
                        updated_at = CURRENT_TIMESTAMP
                    WHERE id = ?
                    """,
                    (int(app_id),),
                )
                if cur.rowcount != 1:
                    raise AssertionError(f"expected one bot app row to publish, got {cur.rowcount}")
                conn.commit()
                return
        except sqlite3.OperationalError:
            if time.time() >= deadline:
                raise
            time.sleep(0.2)


def bot_ids(payload: dict[str, Any]) -> set[str]:
    bots = payload.get("bots", [])
    if not isinstance(bots, list):
        raise AssertionError(f"bot store payload missing bots list: {payload}")
    return {str(item.get("id")) for item in bots}


def metric_count(payload: dict[str, Any], event_type: str) -> int:
    buckets = payload.get("metrics_30d", [])
    if not isinstance(buckets, list):
        raise AssertionError(f"metrics payload missing metrics_30d list: {payload}")
    for bucket in buckets:
        if bucket.get("event_type") == event_type:
            return int(bucket.get("count", 0))
    return 0


def run_smoke(args: argparse.Namespace) -> None:
    server = Path(args.server) if args.server else release_server_path()
    if not server.exists():
        raise FileNotFoundError(f"missing release server binary: {server}")

    with tempfile.TemporaryDirectory(
        prefix="paracord-bot-store-",
        ignore_cleanup_errors=True,
    ) as temp_dir:
        data = Path(temp_dir)
        db_path = data / "paracord.db"
        base_url = f"http://127.0.0.1:{args.port}"
        env = os.environ.copy()
        env.update(
            {
                "PARACORD_BIND_ADDRESS": f"127.0.0.1:{args.port}",
                "PARACORD_DATABASE_ENGINE": "sqlite",
                "PARACORD_DATABASE_URL": f"sqlite://{db_path.as_posix()}?mode=rwc",
                "PARACORD_JWT_SECRET": "bot-store-smoke-secret-0123456789abcdef",
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
            owner = register(base_url, "bot-store-owner@example.com", "botstoreowner")
            reviewer_a = register(base_url, "bot-store-reviewer-a@example.com", "botreviewera")
            reviewer_b = register(base_url, "bot-store-reviewer-b@example.com", "botreviewerb")
            owner_token = owner["token"]
            reviewer_a_token = reviewer_a["token"]
            reviewer_b_token = reviewer_b["token"]

            app = request_json(
                "POST",
                base_url,
                "/api/v1/bots/applications",
                token=owner_token,
                body={
                    "name": "StoreSmokeBot",
                    "description": "Release smoke bot store validation",
                    "permissions": "3072",
                },
                expected=201,
            )
            app_id = app["id"]
            request_json(
                "GET",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews",
                expected=404,
            )

            publish_bot_in_store(db_path, app_id)

            search = request_json(
                "GET",
                base_url,
                "/api/v1/bots/store?q=storesmoke&category=utility&limit=10",
                expected=200,
            )
            if app_id not in bot_ids(search):
                raise AssertionError(f"published bot missing from search: {search}")
            categories = request_json("GET", base_url, "/api/v1/bots/store/categories", expected=200)
            if "utility" not in categories.get("categories", []):
                raise AssertionError(f"published category missing: {categories}")
            featured = request_json("GET", base_url, "/api/v1/bots/store/featured", expected=200)
            if app_id not in bot_ids(featured):
                raise AssertionError(f"published bot missing from featured: {featured}")

            request_json(
                "PUT",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews/@me",
                token=reviewer_a_token,
                body={"rating": 0, "title": "Bad"},
                expected=400,
            )
            request_json(
                "PUT",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews/@me",
                token=reviewer_a_token,
                body={"rating": 5, "title": "x" * 121},
                expected=400,
            )

            first_review = request_json(
                "PUT",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews/@me",
                token=reviewer_a_token,
                body={"rating": 5, "title": "Helpful", "body": "Works well"},
                expected=200,
            )
            if first_review["summary"]["review_count"] != 1:
                raise AssertionError(f"first review did not create one review: {first_review}")

            updated_review = request_json(
                "PUT",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews/@me",
                token=reviewer_a_token,
                body={"rating": 4, "title": "Still helpful", "body": "Updated review"},
                expected=200,
            )
            if updated_review["summary"]["review_count"] != 1:
                raise AssertionError(f"review upsert created a duplicate: {updated_review}")
            request_json(
                "PUT",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews/@me",
                token=reviewer_b_token,
                body={"rating": 2, "body": "Needs polish"},
                expected=200,
            )
            reviews = request_json(
                "GET",
                base_url,
                f"/api/v1/bots/store/{app_id}/reviews?limit=10",
                expected=200,
            )
            if reviews["summary"]["review_count"] != 2:
                raise AssertionError(f"expected two unique reviews: {reviews}")
            if abs(float(reviews["summary"]["average_rating"]) - 3.0) > 0.01:
                raise AssertionError(f"unexpected average rating: {reviews}")
            review_ratings = sorted(item["rating"] for item in reviews["reviews"])
            if review_ratings != [2, 4]:
                raise AssertionError(f"unexpected review ratings after upsert: {reviews}")

            guild = request_json(
                "POST",
                base_url,
                "/api/v1/guilds",
                token=owner_token,
                body={"name": "Bot Store Smoke Guild", "icon": None},
                expected=201,
            )
            guild_id = guild["id"]
            request_json(
                "POST",
                base_url,
                "/api/v1/oauth2/authorize",
                token=owner_token,
                body={"application_id": app_id, "guild_id": guild_id},
                expected=200,
            )
            request_json(
                "GET",
                base_url,
                f"/api/v1/bots/applications/{app_id}/metrics",
                token=reviewer_a_token,
                expected=403,
            )
            metrics = request_json(
                "GET",
                base_url,
                f"/api/v1/bots/applications/{app_id}/metrics",
                token=owner_token,
                expected=200,
            )
            if metrics["install_count"] != 1 or metrics["active_guild_count"] != 1:
                raise AssertionError(f"install metrics mismatch: {metrics}")
            if metrics["review_count"] != 2 or abs(float(metrics["average_rating"]) - 3.0) > 0.01:
                raise AssertionError(f"review metrics mismatch: {metrics}")
            if metric_count(metrics, "guild_install") < 1 or metric_count(metrics, "review_submitted") < 3:
                raise AssertionError(f"metric event buckets missing install/review events: {metrics}")

            request_json(
                "DELETE",
                base_url,
                f"/api/v1/guilds/{guild_id}/bots/{app_id}",
                token=owner_token,
                expected=204,
            )
            post_remove_metrics = request_json(
                "GET",
                base_url,
                f"/api/v1/bots/applications/{app_id}/metrics",
                token=owner_token,
                expected=200,
            )
            if post_remove_metrics["install_count"] != 0 or post_remove_metrics["active_guild_count"] != 0:
                raise AssertionError(f"uninstall metrics mismatch: {post_remove_metrics}")
            if metric_count(post_remove_metrics, "guild_uninstall") < 1:
                raise AssertionError(f"uninstall metric event missing: {post_remove_metrics}")

            print("PASS: bot store search, reviews, review validation, owner-only metrics, install metrics, and uninstall metrics work")
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
    parser.add_argument("--port", type=int, default=18133)
    args = parser.parse_args()
    run_smoke(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
