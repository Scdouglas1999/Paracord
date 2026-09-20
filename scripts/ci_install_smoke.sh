#!/usr/bin/env bash
# ci_install_smoke.sh — end-to-end smoke test for the Paracord installers.
#
# What it covers (all offline — no GitHub access required):
#   1. bash/sh syntax + shellcheck (when installed) on scripts/install.sh
#   2. PowerShell syntax check on scripts/install.ps1 via PSParser (when pwsh
#      is available — preinstalled on GitHub hosted runners; skipped otherwise)
#   3. Builds a fake release tarball matching the real layout
#      (paracord-server/{paracord-server,livekit-server,paracord.example.toml,
#      README.txt}), using target/release/paracord-server when it exists and a
#      stub shell-script binary otherwise.
#   4. Local-archive install into a temp prefix (non-root, no systemd) and
#      asserts binary/config/data land where documented.
#   5. Re-run = upgrade: config preserved byte-for-byte, old binary backed up.
#   6. HTTP download path: serves the tarball + a SHA256SUMS file from a local
#      web server, asserting checksum verification runs and succeeds.
#   7. Negative test: a wrong checksum aborts before touching the install dir.
#   8. Bare-binary PARACORD_LOCAL_ARCHIVE (a plain executable, not a tarball).
#   9. When passwordless sudo + systemd are available (and PARACORD_SMOKE_SKIP_ROOT
#      is not 1): the root path creates
#      the `paracord` user and a working system unit (using the stub binary so
#      no real ports are bound), then cleans up everything it created.
#
# Usage: bash scripts/ci_install_smoke.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PASS_COUNT=0
FAILURES=()

pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '  PASS  %s\n' "$1"; }
fail() { FAILURES+=("$1"); printf '  FAIL  %s\n' "$1" >&2; }
note() { printf '  ....  %s\n' "$1"; }

assert_file()       { if [ -f "$1" ]; then pass "$2"; else fail "$2 (missing file: $1)"; fi; }
assert_executable() { if [ -x "$1" ]; then pass "$2"; else fail "$2 (not executable: $1)"; fi; }
assert_symlink()    { if [ -L "$1" ]; then pass "$2"; else fail "$2 (missing symlink: $1)"; fi; }
assert_contains()   { if grep -q "$2" "$1"; then pass "$3"; else fail "$3 ($1 lacks '$2')"; fi; }
assert_not_exists() { if [ ! -e "$1" ]; then pass "$2"; else fail "$2 (unexpected: $1)"; fi; }

WORK="$(mktemp -d)"
ROOT_INST=""   # root-owned install dir, removed with sudo in cleanup
# Invoked via the EXIT trap below.
# shellcheck disable=SC2317,SC2329
cleanup() {
    set +e
    [ -n "${HTTPD_PID:-}" ] && kill "$HTTPD_PID" 2>/dev/null
    rm -rf "$WORK"
    if [ -n "$ROOT_INST" ] && [ -d "$ROOT_INST" ]; then
        sudo -n rm -rf "$ROOT_INST" 2>/dev/null || rm -rf "$ROOT_INST" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 1: shell syntax and lint"

if bash -n scripts/install.sh; then pass "bash -n scripts/install.sh"; else fail "bash -n scripts/install.sh"; fi
if sh -n scripts/install.sh;   then pass "sh -n scripts/install.sh";   else fail "sh -n scripts/install.sh";   fi
if bash -n scripts/ci_install_smoke.sh; then pass "bash -n ci_install_smoke.sh"; else fail "bash -n ci_install_smoke.sh"; fi

if command -v shellcheck >/dev/null 2>&1; then
    if shellcheck scripts/install.sh; then pass "shellcheck install.sh"; else fail "shellcheck install.sh"; fi
    if shellcheck scripts/ci_install_smoke.sh; then pass "shellcheck ci_install_smoke.sh"; else fail "shellcheck ci_install_smoke.sh"; fi
else
    note "shellcheck not installed — skipping lint (CI installs it explicitly)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 2: install.ps1 syntax (PowerShell)"

PWSH="$(command -v pwsh || command -v powershell || true)"
if [ -n "$PWSH" ]; then
    # Intentional single quotes: the whole block is PowerShell, not shell.
    # shellcheck disable=SC2016
    if "$PWSH" -NoProfile -Command '
        $errors = $null
        [void][System.Management.Automation.PSParser]::Tokenize(
            [System.IO.File]::ReadAllText("scripts/install.ps1"), [ref]$errors)
        if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_ }; exit 1 }
        exit 0
    ' >/dev/null 2>&1; then
        pass "PowerShell syntax check on install.ps1"
    else
        fail "PowerShell syntax check on install.ps1"
    fi
else
    note "pwsh not available — skipping install.ps1 syntax check"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 3: build fake release archive"

PKG="$WORK/pkg/paracord-server"
mkdir -p "$PKG"

REAL_BIN="target/release/paracord-server"
if [ -x "$REAL_BIN" ] && head -c 4 "$REAL_BIN" | grep -q ELF; then
    cp "$REAL_BIN" "$PKG/paracord-server"
    note "using real binary: $REAL_BIN"
else
    note "no target/release/paracord-server — packaging a stub binary"
    cat > "$PKG/paracord-server" <<'STUB'
#!/bin/sh
# Test stub: emulates `paracord-server -c <path> init` — writes a config file
# with the same ./data/ relative layout the real generator produces.
cfg="config/paracord.toml"; do_init=0
while [ $# -gt 0 ]; do
    case "$1" in
        -c|--config) shift; cfg="${1:-}";;
        init) do_init=1;;
    esac
    shift || break
done
if [ "$do_init" = "1" ]; then
    if [ -f "$cfg" ]; then echo "  Config already exists at: $cfg"; exit 0; fi
    mkdir -p "$(dirname "$cfg")"
    secret="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
    cat > "$cfg" <<EOF
[server]
bind_address = "0.0.0.0:8090"
[database]
url = "sqlite://./data/paracord.db?mode=rwc"
[auth]
jwt_secret = "$secret"
[storage]
path = "./data/uploads"
[tls]
enabled = true
port = 8443
cert_path = "./data/certs/cert.pem"
key_path = "./data/certs/key.pem"
[backup]
backup_dir = "./data/backups"
EOF
    chmod 0600 "$cfg"
    echo "  Generated a new Paracord config at: $cfg"
    echo "  Open / share:  https://127.0.0.1:8443"
    exit 0
fi
echo "stub paracord-server: no real service" >&2
exit 0
STUB
    chmod +x "$PKG/paracord-server"
fi

# Companion files matching the real release tarball layout.
printf '#!/bin/sh\necho stub-livekit\n' > "$PKG/livekit-server"; chmod +x "$PKG/livekit-server"
cp config/paracord.example.toml "$PKG/paracord.example.toml" 2>/dev/null || echo "# example" > "$PKG/paracord.example.toml"
printf 'Paracord Server (smoke package)\n' > "$PKG/README.txt"

FAKE_VERSION="9.9.9-smoke"
ASSET="paracord-server-linux-x64-${FAKE_VERSION}.tar.gz"
tar -czf "$WORK/$ASSET" -C "$WORK/pkg" paracord-server
if [ -f "$WORK/$ASSET" ]; then pass "built $ASSET"; else fail "failed to build fake tarball"; fi

# A second, stub-only package for the root/systemd test (never binds ports).
STUB_PKG="$WORK/stubpkg/paracord-server"
mkdir -p "$STUB_PKG"
cat > "$STUB_PKG/paracord-server" <<'STUB'
#!/bin/sh
cfg="config/paracord.toml"; do_init=0
while [ $# -gt 0 ]; do
    case "$1" in
        -c|--config) shift; cfg="${1:-}";;
        init) do_init=1;;
    esac
    shift || break
done
if [ "$do_init" = "1" ]; then
    if [ -f "$cfg" ]; then echo "exists"; exit 0; fi
    mkdir -p "$(dirname "$cfg")"
    printf '[server]\nbind_address = "0.0.0.0:8090"\n[database]\nurl = "sqlite://./data/paracord.db?mode=rwc"\n[auth]\njwt_secret = "%s"\n' \
        "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')" > "$cfg"
    echo "  Generated a new Paracord config at: $cfg"; exit 0
fi
# "server run" — exit immediately; only used to prove systemd wiring.
exit 0
STUB
chmod +x "$STUB_PKG/paracord-server"
STUB_ASSET="paracord-server-linux-x64-8.8.8-stub.tar.gz"
tar -czf "$WORK/$STUB_ASSET" -C "$WORK/stubpkg" paracord-server

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 4: local-archive install (non-root, no systemd)"

INST="$WORK/inst"
LINKD="$WORK/bin"
PARACORD_LOCAL_ARCHIVE="$WORK/$ASSET" \
PARACORD_INSTALL_DIR="$INST" \
PARACORD_LINK_DIR="$LINKD" \
PARACORD_NO_SYSTEMD=1 \
    sh scripts/install.sh > "$WORK/install1.log" 2>&1 || { cat "$WORK/install1.log"; fail "local-archive install exited non-zero"; }

assert_executable "$INST/paracord-server"            "server binary installed + executable"
assert_file        "$INST/livekit-server"          "livekit-server companion installed"
assert_file        "$INST/paracord.example.toml"   "example config installed"
assert_file        "$INST/config/paracord.toml"    "init generated config/paracord.toml"
assert_contains    "$INST/config/paracord.toml" "jwt_secret" "config contains a generated jwt_secret"
assert_contains    "$INST/config/paracord.toml" "$INST/data/" "config data paths pinned to install dir"
assert_not_exists  "$INST/config/paracord.toml.bak" "no stray config backup"
assert_symlink     "$LINKD/paracord-server"        "PATH symlink created"
if grep -q "Open / share" "$WORK/install1.log"; then
    pass "installer prints the share URL"
else
    fail "installer prints the share URL"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 5: re-run = upgrade preserves config and data"

MARKER="# smoke-marker-$$"
printf '%s\n' "$MARKER" >> "$INST/config/paracord.toml"
mkdir -p "$INST/data/uploads" && echo sentinel > "$INST/data/uploads/keep.me"
cp "$INST/config/paracord.toml" "$WORK/config.before"

PARACORD_LOCAL_ARCHIVE="$WORK/$ASSET" \
PARACORD_INSTALL_DIR="$INST" \
PARACORD_LINK_DIR="$LINKD" \
PARACORD_NO_SYSTEMD=1 \
    sh scripts/install.sh > "$WORK/install2.log" 2>&1 || { cat "$WORK/install2.log"; fail "upgrade run exited non-zero"; }

if cmp -s "$WORK/config.before" "$INST/config/paracord.toml"; then
    pass "upgrade preserved config/paracord.toml byte-for-byte"
else
    fail "upgrade preserved config/paracord.toml"
fi
assert_contains "$INST/config/paracord.toml" "$MARKER" "config marker survived upgrade"
assert_file "$INST/data/uploads/keep.me" "data/ contents preserved on upgrade"
if ls "$INST"/backups/paracord-server.* >/dev/null 2>&1; then
    pass "previous binary backed up under backups/"
else
    fail "previous binary backed up under backups/"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 6: HTTP download path with SHA-256 verification"

SERVE_DIR="$WORK/serve"
mkdir -p "$SERVE_DIR/v$FAKE_VERSION"
cp "$WORK/$ASSET" "$SERVE_DIR/v$FAKE_VERSION/$ASSET"
( cd "$SERVE_DIR/v$FAKE_VERSION" && sha256sum "$ASSET" > SHA256SUMS )

HTTPD_LOG="$WORK/httpd.log"
python3 - "$SERVE_DIR" > "$HTTPD_LOG" 2>&1 <<'PY' &
import functools, http.server, socketserver, sys
handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=sys.argv[1])
with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
    print(httpd.server_address[1], flush=True)
    httpd.serve_forever()
PY
HTTPD_PID=$!
# First line of the log is the bound port.
for _ in $(seq 1 50); do [ -s "$HTTPD_LOG" ] && break; sleep 0.1; done
HTTP_PORT="$(head -n1 "$HTTPD_LOG")"
case "$HTTP_PORT" in ''|*[!0-9]*) fail "local http server did not report a port" ;; esac

INST2="$WORK/inst2"
PARACORD_VERSION="$FAKE_VERSION" \
PARACORD_RELEASE_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
PARACORD_INSTALL_DIR="$INST2" \
PARACORD_LINK_DIR=none \
PARACORD_NO_SYSTEMD=1 \
    sh scripts/install.sh > "$WORK/install3.log" 2>&1 || { cat "$WORK/install3.log"; fail "HTTP install exited non-zero"; }

assert_executable "$INST2/paracord-server" "HTTP install placed the binary"
assert_file "$INST2/config/paracord.toml" "HTTP install generated config"
if grep -q "SHA-256 verified" "$WORK/install3.log"; then
    pass "SHA-256 verification ran against published SHA256SUMS"
else
    fail "SHA-256 verification ran against published SHA256SUMS"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 7: bad checksum aborts before installing"

# Deliberately wrong digest — constant so the corruption can never be a no-op.
printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  %s\n' "$ASSET" \
    > "$SERVE_DIR/v$FAKE_VERSION/SHA256SUMS"
INST3="$WORK/inst3"
if PARACORD_VERSION="$FAKE_VERSION" \
   PARACORD_RELEASE_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
   PARACORD_INSTALL_DIR="$INST3" \
   PARACORD_LINK_DIR=none \
   PARACORD_NO_SYSTEMD=1 \
       sh scripts/install.sh > "$WORK/install4.log" 2>&1; then
    fail "corrupt checksum install should have failed"
else
    pass "corrupt checksum install failed loudly"
fi
assert_not_exists "$INST3/paracord-server" "no partial install after checksum failure"
if grep -q "SHA-256 mismatch" "$WORK/install4.log"; then
    pass "mismatch error names the problem"
else
    fail "mismatch error names the problem"
fi

kill "$HTTPD_PID" 2>/dev/null || true
unset HTTPD_PID

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 8: bare binary as PARACORD_LOCAL_ARCHIVE"

if [ -x "$REAL_BIN" ] && head -c 4 "$REAL_BIN" | grep -q ELF; then
    INST4="$WORK/inst4"
    PARACORD_LOCAL_ARCHIVE="$REAL_BIN" \
    PARACORD_INSTALL_DIR="$INST4" \
    PARACORD_LINK_DIR=none \
    PARACORD_NO_SYSTEMD=1 \
        sh scripts/install.sh > "$WORK/install5.log" 2>&1 || { cat "$WORK/install5.log"; fail "bare-binary install exited non-zero"; }
    assert_executable "$INST4/paracord-server" "bare binary installed"
    assert_file "$INST4/config/paracord.toml" "bare binary install ran init"
else
    note "no real binary — bare-binary path covered by the tarball test only"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 9: root + systemd path (only when safely testable)"

ROOT_OK=0
ROOT_NOTED=0   # set when a specific skip reason was already printed
if [ "${PARACORD_SMOKE_SKIP_ROOT:-0}" = "1" ]; then
    note "PARACORD_SMOKE_SKIP_ROOT=1 — root path skipped on request"
    ROOT_NOTED=1
else
    if [ "$(id -u)" = "0" ]; then
        note "already root — testing root path directly"
        ROOT_OK=1
    elif sudo -n true 2>/dev/null; then
        ROOT_OK=1
    fi
    [ -d /run/systemd/system ] || ROOT_OK=0
    id paracord >/dev/null 2>&1 && { note "a 'paracord' user already exists — skipping root test rather than touching it"; ROOT_OK=0; ROOT_NOTED=1; }
    [ -e /etc/systemd/system/paracord.service ] && { note "paracord.service already exists — skipping root test"; ROOT_OK=0; ROOT_NOTED=1; }
fi

if [ "$ROOT_OK" = "1" ]; then
    # Directly under /tmp (world-traversable) so the paracord service user can
    # reach the install dir — a mode-700 mktemp dir would block traversal.
    RINST="/tmp/paracord-smoke-root.$$"
    ROOT_INST="$RINST"
    rm -rf "$RINST" 2>/dev/null || true
    SUDO=""; [ "$(id -u)" != "0" ] && SUDO="sudo"
    if $SUDO env \
        PARACORD_LOCAL_ARCHIVE="$WORK/$STUB_ASSET" \
        PARACORD_INSTALL_DIR="$RINST" \
        PARACORD_LINK_DIR=none \
            sh scripts/install.sh > "$WORK/install_root.log" 2>&1; then

        assert_executable "$RINST/paracord-server" "root install placed binary"
        assert_file "$RINST/config/paracord.toml" "root install generated config"
        if id paracord >/dev/null 2>&1; then pass "paracord system user created"; else fail "paracord system user created"; fi
        assert_file /etc/systemd/system/paracord.service "systemd unit written"
        assert_contains /etc/systemd/system/paracord.service "Restart=always" "unit restarts always"
        assert_contains /etc/systemd/system/paracord.service "User=paracord" "unit runs as paracord user"
        assert_contains /etc/systemd/system/paracord.service "NoNewPrivileges=true" "unit hardened (NoNewPrivileges)"
        if systemctl is-enabled paracord.service >/dev/null 2>&1; then pass "service enabled"; else fail "service enabled"; fi
        owner="$(stat -c %U "$RINST/paracord-server" 2>/dev/null || stat -f %Su "$RINST/paracord-server")"
        if [ "$owner" = "paracord" ]; then
            pass "install dir owned by paracord"
        else
            fail "install dir owned by paracord (got $owner)"
        fi
    else
        cat "$WORK/install_root.log"; fail "root install exited non-zero"
    fi

    # Cleanup of everything this test created.
    $SUDO systemctl stop paracord.service 2>/dev/null || true
    $SUDO systemctl disable paracord.service 2>/dev/null || true
    $SUDO rm -f /etc/systemd/system/paracord.service
    $SUDO systemctl daemon-reload 2>/dev/null || true
    $SUDO userdel paracord 2>/dev/null || true
    note "root-test artifacts cleaned up (user, unit, service)"
else
    # Only report the environment limitation when no specific skip reason was
    # already given (explicit skip request, existing user, existing unit).
    [ "$ROOT_NOTED" = "1" ] || note "no passwordless sudo/systemd — root path not exercised here (CI covers it)"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${#FAILURES[@]}" -eq 0 ]; then
    echo "ci_install_smoke: ALL CHECKS PASSED ($PASS_COUNT assertions)"
    exit 0
else
    echo "ci_install_smoke: ${#FAILURES[@]} FAILURE(S):" >&2
    printf '  - %s\n' "${FAILURES[@]}" >&2
    exit 1
fi
