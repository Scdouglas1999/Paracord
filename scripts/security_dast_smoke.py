#!/usr/bin/env python3
"""Lightweight DAST smoke checks against a running Paracord API."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Optional

import requests


@dataclass
class CheckResult:
    name: str
    ok: bool
    detail: str


def request(
    base_url: str,
    method: str,
    path: str,
    *,
    headers: Optional[dict[str, str]] = None,
    json_body: Optional[object] = None,
) -> requests.Response:
    return requests.request(
        method=method,
        url=f"{base_url}{path}",
        headers=headers or {},
        json=json_body,
        timeout=8,
    )


def expect_not_5xx(name: str, response: requests.Response) -> CheckResult:
    ok = response.status_code < 500
    detail = f"status={response.status_code}"
    return CheckResult(name, ok, detail)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8080")
    args = parser.parse_args()

    base_url = args.base_url.rstrip("/")
    results: list[CheckResult] = []

    try:
        health = request(base_url, "GET", "/health")
    except requests.RequestException as exc:
        print(f"[FAIL] health request failed: {exc}")
        return 1

    results.append(CheckResult("health-up", health.status_code == 200, f"status={health.status_code}"))

    required_headers = [
        "x-content-type-options",
        "x-frame-options",
        "referrer-policy",
        "permissions-policy",
        "content-security-policy",
    ]
    api_health = request(base_url, "GET", "/api/v1/health")
    missing = [h for h in required_headers if h not in api_health.headers]
    results.append(
        CheckResult(
            "security-headers-api",
            not missing and api_health.status_code == 200,
            f"status={api_health.status_code}, missing={missing}",
        )
    )

    disallowed_livekit = request(
        base_url,
        "POST",
        "/livekit/twirp/livekit.RoomService/DeleteRoom",
        json_body={"room": "x"},
    )
    results.append(
        CheckResult(
            "livekit-disallow",
            disallowed_livekit.status_code == 404,
            f"status={disallowed_livekit.status_code}",
        )
    )

    admin_without_auth = request(base_url, "GET", "/api/v1/admin/stats")
    results.append(
        CheckResult(
            "admin-auth-required",
            admin_without_auth.status_code in (401, 403),
            f"status={admin_without_auth.status_code}",
        )
    )

    traversal = request(base_url, "GET", "/api/v1/attachments/%2e%2e%2f%2e%2e%2fetc%2fpasswd")
    results.append(
        CheckResult(
            "path-traversal-rejected",
            traversal.status_code in (400, 401, 403, 404, 405),
            f"status={traversal.status_code}",
        )
    )

    cors_probe = requests.options(
        f"{base_url}/api/v1/auth/login",
        headers={
            "Origin": "https://evil.example",
            "Access-Control-Request-Method": "POST",
        },
        timeout=8,
    )
    allow_origin = cors_probe.headers.get("access-control-allow-origin")
    results.append(
        CheckResult(
            "cors-not-wildcard",
            allow_origin != "*",
            f"status={cors_probe.status_code}, allow_origin={allow_origin}",
        )
    )
    results.append(expect_not_5xx("cors-preflight-no-5xx", cors_probe))

    challenge = request(base_url, "POST", "/api/v1/auth/challenge")
    results.append(expect_not_5xx("auth-challenge-no-5xx", challenge))
    if challenge.status_code == 200:
        try:
            payload = challenge.json()
            valid_payload = all(k in payload for k in ("nonce", "timestamp", "server_origin"))
        except json.JSONDecodeError:
            valid_payload = False
        results.append(CheckResult("auth-challenge-shape", valid_payload, f"status={challenge.status_code}"))

    failed = [r for r in results if not r.ok]
    for result in results:
        status = "PASS" if result.ok else "FAIL"
        print(f"[{status}] {result.name}: {result.detail}")

    if failed:
        print(f"{len(failed)} security smoke check(s) failed.")
        return 1
    print("All security smoke checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
