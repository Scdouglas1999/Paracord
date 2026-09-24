#!/usr/bin/env python3
"""Let's Encrypt (ACME) first start, end to end, against Pebble.

Pebble is Let's Encrypt's own ACME test server. This smoke runs it (and its DNS
companion, pebble-challtestsrv) in Docker, points a real `paracord-server`
binary at it through `tls.acme.directory_url`, and checks the whole first-start
story that 3.2.0 changed:

1. Before any certificate exists, the server starts and serves a temporary
   self-signed one over HTTPS.
2. A failed ACME attempt does not stop the server: it logs the failure and
   retries after a back-off (the first attempt here is made while Pebble is not
   running yet, so it must fail).
3. Once Pebble is up, the retry gets a real certificate over HTTP-01 — Pebble
   fetches the challenge from the server's plain-HTTP listener — and the server
   swaps it in without restarting (same process, same PID).
4. A TLS client that trusts only Pebble's root then completes a verified
   handshake for the ACME domain against the running server.

Requirements: Docker (with host networking), the `openssl` command, and an
ACME client — certbot, which is what the server runs. Point
`PARACORD_ACME_SMOKE_CERTBOT` at it, or have `certbot` on PATH:

    python3 -m venv /tmp/certbot && /tmp/certbot/bin/pip install certbot
    PARACORD_ACME_SMOKE_CERTBOT=/tmp/certbot/bin/certbot \\
        python3 scripts/release_acme_pebble_smoke.py

The server binary defaults to target/release/paracord-server
(`PARACORD_ACME_SMOKE_BINARY` overrides it). Every port is on 127.0.0.1 and can
be moved with `PARACORD_ACME_SMOKE_PORT_BASE` (default 18510; ten ports up from
it are used).
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Pinned so a new Pebble release cannot change what this smoke proves overnight.
PEBBLE_IMAGE = (
    "ghcr.io/letsencrypt/pebble@sha256:"
    "ddf230642b1a584f519f32e347de1b05a6e4c1f6c35c1863b33effeab5f78199"
)
CHALLTESTSRV_IMAGE = (
    "ghcr.io/letsencrypt/pebble-challtestsrv@sha256:"
    "12ce21884def456bcf9786542113949e1f19dc7738d2c70e156c2d0c38a1405b"
)

DOMAIN = "acme-smoke.paracord.test"
CERT_NAME = "paracord-acme-smoke"

# The server's first attempt runs 5 s after it starts listening; the retry after
# one failure is 60 s later. Allow for a slow runner on top of both.
FIRST_FAILURE_TIMEOUT_S = 60
ISSUANCE_TIMEOUT_S = 180


def log(message: str) -> None:
    print(f"[acme-pebble-smoke] {message}", flush=True)


def fail(message: str) -> None:
    raise SystemExit(f"[acme-pebble-smoke] FAIL: {message}")


class Ports:
    def __init__(self, base: int) -> None:
        self.http = base + 1  # Paracord plain HTTP (redirect + HTTP-01 challenges)
        self.https = base + 2  # Paracord HTTPS
        self.voice = base + 3  # Paracord native media (UDP), kept off the default 8443
        self.acme = base + 4  # Pebble ACME directory
        self.pebble_mgmt = base + 5  # Pebble management API (roots)
        self.dns = base + 6  # challtestsrv DNS
        self.challtestsrv_mgmt = base + 7


def docker(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(["docker", *args], text=True, capture_output=True)
    if check and result.returncode != 0:
        fail(f"docker {' '.join(args[:3])} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result


def resolve_certbot() -> str:
    supplied = os.environ.get("PARACORD_ACME_SMOKE_CERTBOT", "").strip()
    candidate = supplied or shutil.which("certbot")
    if not candidate or not Path(candidate).exists():
        fail(
            "no ACME client: set PARACORD_ACME_SMOKE_CERTBOT to a certbot executable "
            "or put certbot on PATH (python3 -m venv /tmp/certbot && /tmp/certbot/bin/pip install certbot)"
        )
    return str(Path(candidate).resolve())


def resolve_binary() -> Path:
    supplied = os.environ.get("PARACORD_ACME_SMOKE_BINARY", "").strip()
    name = "paracord-server.exe" if os.name == "nt" else "paracord-server"
    binary = Path(supplied) if supplied else ROOT / "target" / "release" / name
    if not binary.exists():
        fail(f"server binary not found at {binary} (cargo build --release --bin paracord-server)")
    return binary


def presented_certificate(port: int) -> dict[str, str]:
    """The certificate the server presents right now, read without trusting it."""
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        with context.wrap_socket(raw, server_hostname=DOMAIN) as tls:
            der = tls.getpeercert(binary_form=True)
    pem = ssl.DER_cert_to_PEM_cert(der)

    def field(*args: str) -> str:
        result = subprocess.run(
            ["openssl", "x509", "-noout", "-nameopt", "RFC2253", *args],
            input=pem, text=True, capture_output=True, check=True,
        )
        return result.stdout.strip()

    san = field("-ext", "subjectAltName")
    return {
        "subject": field("-subject").removeprefix("subject=").strip(),
        "issuer": field("-issuer").removeprefix("issuer=").strip(),
        "san": " ".join(san.splitlines()[1:]).strip(),
        "pem": pem,
    }


def wait_for_tls(port: int, server: subprocess.Popen[bytes], log_path: Path) -> dict[str, str]:
    deadline = time.monotonic() + 60
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        if server.poll() is not None:
            fail(f"server exited early with {server.returncode}:\n{tail(log_path)}")
        try:
            return presented_certificate(port)
        except OSError as error:
            last_error = error
            time.sleep(0.5)
    fail(f"HTTPS never came up on {port}: {last_error}\n{tail(log_path)}")
    raise AssertionError("unreachable")


def wait_for_log(log_path: Path, needle: str, timeout_s: float, server: subprocess.Popen[bytes]) -> str:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        text = log_path.read_text(errors="replace") if log_path.exists() else ""
        for line in text.splitlines():
            if needle in line:
                return line
        if server.poll() is not None:
            fail(f"server exited with {server.returncode} while waiting for {needle!r}:\n{tail(log_path)}")
        time.sleep(1)
    fail(f"timed out after {timeout_s:.0f}s waiting for {needle!r} in the server log:\n{tail(log_path)}")
    raise AssertionError("unreachable")


def tail(path: Path, lines: int = 60) -> str:
    if not path.exists():
        return "(no log)"
    return "\n".join(path.read_text(errors="replace").splitlines()[-lines:])


def write_server_config(path: Path, data: Path, ports: Ports, certbot: str) -> None:
    certbot_dirs = data / "certbot"
    live = certbot_dirs / "config" / "live" / CERT_NAME
    config = f"""
[server]
bind_address = "127.0.0.1:{ports.http}"

[database]
engine = "sqlite"
url = "sqlite://{(data / 'paracord.db').as_posix()}?mode=rwc"

[auth]
jwt_secret = "acme-pebble-smoke-jwt-secret-0123456789abcdef"

[storage]
path = "{(data / 'uploads').as_posix()}"

[voice]
port = {ports.voice}

[tls]
enabled = true
port = {ports.https}
cert_path = "{(data / 'certs' / 'cert.pem').as_posix()}"
key_path = "{(data / 'certs' / 'key.pem').as_posix()}"
auto_generate = true

[tls.acme]
enabled = true
client_path = "{certbot}"
directory_url = "https://127.0.0.1:{ports.acme}/dir"
domains = ["{DOMAIN}"]
webroot_path = "{(data / 'acme-webroot').as_posix()}"
cert_name = "{CERT_NAME}"
cert_source_path = "{(live / 'fullchain.pem').as_posix()}"
key_source_path = "{(live / 'privkey.pem').as_posix()}"
additional_args = [
    "--config-dir", "{(certbot_dirs / 'config').as_posix()}",
    "--work-dir", "{(certbot_dirs / 'work').as_posix()}",
    "--logs-dir", "{(certbot_dirs / 'logs').as_posix()}",
]
serve_http_challenge = true
auto_renew = true
renew_interval_seconds = 3600
"""
    path.write_text(config)


def start_challtestsrv(name: str, ports: Ports) -> None:
    # DNS only: every name answers 127.0.0.1 (and nothing over IPv6, so Pebble
    # validates against the IPv4 listener the server actually has).
    docker(
        "run", "-d", "--rm", "--network", "host", "--name", name, CHALLTESTSRV_IMAGE,
        "-defaultIPv4", "127.0.0.1",
        "-defaultIPv6", "",
        "-dnsserver", f"127.0.0.1:{ports.dns}",
        "-management", f"127.0.0.1:{ports.challtestsrv_mgmt}",
        "-http01", "", "-https01", "", "-tlsalpn01", "", "-doh", "",
    )


def start_pebble(name: str, ports: Ports, config_dir: Path) -> None:
    config = {
        "pebble": {
            "listenAddress": f"127.0.0.1:{ports.acme}",
            "managementListenAddress": f"127.0.0.1:{ports.pebble_mgmt}",
            "certificate": "test/certs/localhost/cert.pem",
            "privateKey": "test/certs/localhost/key.pem",
            # HTTP-01 is validated against the server's own plain-HTTP port.
            "httpPort": ports.http,
            "tlsPort": ports.https,
            "ocspResponderURL": "",
            "externalAccountBindingRequired": False,
        }
    }
    (config_dir / "pebble.json").write_text(json.dumps(config, indent=2))
    docker(
        "run", "-d", "--rm", "--network", "host", "--name", name,
        "-v", f"{config_dir}:/smoke:ro",
        # No random validation sleeps and no deliberately rejected nonces: this
        # smoke is about the server, not about certbot's retry logic.
        "-e", "PEBBLE_VA_NOSLEEP=1", "-e", "PEBBLE_WFE_NONCEREJECT=0",
        PEBBLE_IMAGE, "-config", "/smoke/pebble.json", "-dnsserver", f"127.0.0.1:{ports.dns}",
    )


def fetch_pebble_minica(target: Path) -> None:
    created = docker("create", PEBBLE_IMAGE).stdout.strip()
    try:
        docker("cp", f"{created}:/test/certs/pebble.minica.pem", str(target))
    finally:
        docker("rm", created, check=False)


def wait_for_pebble(ports: Ports, minica: Path) -> None:
    context = ssl.create_default_context(cafile=str(minica))
    deadline = time.monotonic() + 60
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"https://127.0.0.1:{ports.acme}/dir", context=context, timeout=5) as response:
                if response.status == 200:
                    return
        except OSError as error:
            last_error = error
        time.sleep(0.5)
    fail(f"Pebble never answered on {ports.acme}: {last_error}")


def pebble_root(ports: Ports, minica: Path) -> str:
    context = ssl.create_default_context(cafile=str(minica))
    with urllib.request.urlopen(
        f"https://127.0.0.1:{ports.pebble_mgmt}/roots/0", context=context, timeout=10
    ) as response:
        return response.read().decode()


def verified_handshake(port: int, root_pem: Path) -> dict:
    """A handshake that only succeeds for a Pebble-issued certificate for DOMAIN."""
    context = ssl.create_default_context(cafile=str(root_pem))
    context.check_hostname = True
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        with context.wrap_socket(raw, server_hostname=DOMAIN) as tls:
            return tls.getpeercert()


def verified_health(port: int, root_pem: Path) -> int:
    context = ssl.create_default_context(cafile=str(root_pem))
    context.check_hostname = True
    with socket.create_connection(("127.0.0.1", port), timeout=5) as raw:
        with context.wrap_socket(raw, server_hostname=DOMAIN) as tls:
            tls.sendall(
                f"GET /health HTTP/1.1\r\nHost: {DOMAIN}\r\nConnection: close\r\n\r\n".encode()
            )
            response = b""
            while chunk := tls.recv(4096):
                response += chunk
    status_line = response.split(b"\r\n", 1)[0].decode(errors="replace")
    return int(status_line.split()[1])


def main() -> None:
    for tool in ("docker", "openssl"):
        if shutil.which(tool) is None:
            fail(f"{tool} is required")
    certbot = resolve_certbot()
    binary = resolve_binary()
    ports = Ports(int(os.environ.get("PARACORD_ACME_SMOKE_PORT_BASE", "18510")))
    suffix = f"{os.getpid()}"
    challtestsrv_name = f"paracord-acme-challtestsrv-{suffix}"
    pebble_name = f"paracord-acme-pebble-{suffix}"

    with tempfile.TemporaryDirectory(prefix="paracord-acme-smoke-") as temp:
        data = Path(temp)
        minica = data / "pebble.minica.pem"
        config_path = data / "paracord.toml"
        log_path = data / "server.log"
        server: subprocess.Popen[bytes] | None = None
        try:
            fetch_pebble_minica(minica)
            start_challtestsrv(challtestsrv_name, ports)
            write_server_config(config_path, data, ports, certbot)

            env = {key: value for key, value in os.environ.items() if not key.startswith("PARACORD_")}
            env.update(
                {
                    "PARACORD_LOG_ANSI": "false",
                    "RUST_LOG": "info",
                    # certbot talks to Pebble's directory over HTTPS signed by
                    # Pebble's test CA.
                    "REQUESTS_CA_BUNDLE": str(minica),
                }
            )
            with log_path.open("wb") as log_file:
                server = subprocess.Popen(
                    [str(binary), "-c", str(config_path)],
                    cwd=str(data),
                    env=env,
                    stdout=log_file,
                    stderr=subprocess.STDOUT,
                )
            pid = server.pid

            # 1. First start: a temporary self-signed certificate.
            temporary = wait_for_tls(ports.https, server, log_path)
            if temporary["subject"] != temporary["issuer"] or "Pebble" in temporary["issuer"]:
                fail(f"expected a temporary self-signed certificate first, got {temporary}")
            log(f"first start serves the temporary self-signed certificate (issuer {temporary['issuer']!r})")

            # 2. Pebble is not running, so the first attempt fails and is retried.
            failure = wait_for_log(
                log_path, "ACME certificate request failed (attempt 1); retrying in 60s",
                FIRST_FAILURE_TIMEOUT_S, server,
            )
            log(f"first attempt failed as it must without a CA, and backs off: {failure.strip()[:200]}")
            still = presented_certificate(ports.https)
            if still["pem"] != temporary["pem"]:
                fail("the certificate changed although no ACME request had succeeded")

            # 3. Bring the CA up; the retry must get the real certificate.
            start_pebble(pebble_name, ports, data)
            wait_for_pebble(ports, minica)
            log("Pebble is up; waiting for the server's retry")
            loaded = wait_for_log(log_path, "TLS certificate loaded from ACME", ISSUANCE_TIMEOUT_S, server)
            log(f"server reports: {loaded.strip()[:200]}")
            if server.poll() is not None or server.pid != pid:
                fail("the server restarted to take the new certificate")

            # 4. A client that trusts only Pebble's root now completes a verified
            #    handshake for the ACME domain.
            root = data / "pebble-root.pem"
            root.write_text(pebble_root(ports, minica))
            issued = presented_certificate(ports.https)
            if DOMAIN not in issued["san"]:
                fail(f"the served certificate does not name {DOMAIN}: {issued}")
            peer = verified_handshake(ports.https, root)
            status = verified_health(ports.https, root)
            if status != 200:
                fail(f"/health over the Pebble-verified connection answered {status}")
            log(
                f"hot-swapped without a restart (pid {pid}): subject {issued['subject']!r}, "
                f"issuer {issued['issuer']!r}, SAN {issued['san']!r}, verified against Pebble's root, "
                f"notAfter {peer.get('notAfter')}, /health 200"
            )
            log("OK")
        except SystemExit:
            if server is not None:
                print(f"--- server log ---\n{tail(log_path)}", file=sys.stderr)
            raise
        finally:
            if server is not None and server.poll() is None:
                server.terminate()
                try:
                    server.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    server.kill()
                    server.wait(timeout=10)
            docker("rm", "-f", pebble_name, check=False)
            docker("rm", "-f", challtestsrv_name, check=False)


if __name__ == "__main__":
    main()
