#!/usr/bin/env bash
# ci_install_smoke.sh — end-to-end smoke test for the Paracord installers.
#
# What it covers (all offline — no GitHub access required):
#   1. bash/sh syntax + shellcheck (when installed) on scripts/install.sh
#   2. scripts/install.ps1 is pure ASCII with no BOM (Windows PowerShell 5.1
#      parse safety and `irm | iex` safety), plus tokenizer and full-grammar
#      parse checks when pwsh is available — preinstalled on GitHub hosted
#      runners, skipped otherwise
#   3. Builds a fake release tarball matching the real layout
#      (paracord-server/{paracord-server,livekit-server,paracord.example.toml,
#      README.txt}), using target/release/paracord-server when it exists and a
#      stub shell-script binary otherwise.
#   4. Local-archive install into a temp prefix (non-root, no systemd) and
#      asserts binary/config/data land where documented, and that the closing
#      instructions are the short plain-language ones (the server's own `init`
#      walkthrough is held back).
#   5. Re-run = upgrade: config preserved byte-for-byte, old binary backed up.
#   6. The one link that finishes setup: built from the token file the server
#      writes beside the config, preferring the link file when one exists,
#      always against the loopback address and the configured port. Checks the
#      closing block for jargon and length, and that PARACORD_NO_BROWSER=1 is
#      honored (nothing here may open a browser).
#   7. HTTP download path: serves the tarball + a SHA256SUMS file from a local
#      web server, asserting checksum verification runs and succeeds.
#   8. Negative test: a wrong checksum aborts before touching the install dir.
#   9. Bare-binary PARACORD_LOCAL_ARCHIVE (a plain executable, not a tarball).
#  10. The router question: a run with no terminal answers no; --allow-internet,
#      --home-network-only and PARACORD_ALLOW_INTERNET decide it up front; a
#      run with a terminal asks and takes the answer (driven through `script`);
#      whatever it decided is what the config says; an upgrade never changes it.
#  11. When passwordless sudo + systemd are available (and PARACORD_SMOKE_SKIP_ROOT
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

# Pure ASCII, no BOM. Windows PowerShell 5.1 reads a BOM-less file in the
# machine's ANSI code page, so any non-ASCII byte either changes meaning or
# needs a BOM - and a BOM is exactly what breaks `irm ... | iex`, which parses
# the bytes it downloads. ASCII sidesteps both. Checked without PowerShell so it
# runs everywhere.
if python3 -c 'import sys; d = open("scripts/install.ps1", "rb").read(); sys.exit(0 if all(b < 128 for b in d) else 1)'; then
    pass 'install.ps1 is pure ASCII with no BOM'
else
    fail 'install.ps1 has non-ASCII bytes (5.1 would need a BOM, and a BOM breaks the iex one-liner)'
fi

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
    # Tokenizing accepts text the grammar rejects, so also run the real parser.
    # The Windows job runs install.ps1 for real (scripts/ci_install_smoke.ps1);
    # this catches a parse error before that job's build finishes.
    # shellcheck disable=SC2016
    if "$PWSH" -NoProfile -Command '
        $errs = $null
        [void][System.Management.Automation.Language.Parser]::ParseFile(
            (Resolve-Path "scripts/install.ps1").Path, [ref]$null, [ref]$errs)
        if ($errs) { $errs | ForEach-Object { Write-Host $_ }; exit 1 }
        exit 0
    '; then
        pass "PowerShell parse check (full grammar) on install.ps1"
    else
        fail "PowerShell parse check (full grammar) on install.ps1"
    fi
else
    note "pwsh not available — skipping install.ps1 syntax checks"
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
[network]
# Ask your router (UPnP / NAT-PMP) to let friends outside your home network in.
auto_port_forward = false
port_forward_lease_seconds = 3600
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
PARACORD_NO_BROWSER=1 \
    sh scripts/install.sh > "$WORK/install1.log" 2>&1 || { cat "$WORK/install1.log"; fail "local-archive install exited non-zero"; }

assert_executable "$INST/paracord-server"            "server binary installed + executable"
assert_file        "$INST/livekit-server"          "livekit-server companion installed"
assert_file        "$INST/paracord.example.toml"   "example config installed"
assert_file        "$INST/config/paracord.toml"    "init generated config/paracord.toml"
assert_contains    "$INST/config/paracord.toml" "jwt_secret" "config contains a generated jwt_secret"
assert_contains    "$INST/config/paracord.toml" "$INST/data/" "config data paths pinned to install dir"
assert_not_exists  "$INST/config/paracord.toml.bak" "no stray config backup"
assert_symlink     "$LINKD/paracord-server"        "PATH symlink created"
assert_contains "$WORK/install1.log" "Paracord is installed" "ending says the install is done"
assert_contains "$WORK/install1.log" "open your server in the app and press Invite" "ending says how to invite friends"
assert_contains "$WORK/install1.log" "To update later, run this same command again" "ending says how to update"
assert_contains "$WORK/install1.log" "Address:" "Details block prints the address"
assert_contains "$WORK/install1.log" "$INST/config/paracord.toml" "Details block prints the settings path"
# No terminal and no flag: the router is left alone, and the config says so.
assert_contains "$INST/config/paracord.toml" "^auto_port_forward = false$" "no-terminal install leaves the router alone"
assert_contains "$WORK/install1.log" "Only people on your home network can join for now" "ending says it is home network only"
assert_contains "$WORK/install1.log" "Let friends outside your home network connect" "ending names the setting that changes it"
cfg_mode="$(stat -c %a "$INST/config/paracord.toml" 2>/dev/null || stat -f %Lp "$INST/config/paracord.toml")"
if [ "$cfg_mode" = "600" ]; then
    pass "config keeps its owner-only mode after the router answer is written"
else
    fail "config mode after writing the router answer is $cfg_mode, expected 600"
fi
# `paracord-server init` prints its own operator walkthrough; the installer
# holds it back so there is exactly one set of closing instructions.
if grep -qiE "claim token|Next steps" "$WORK/install1.log"; then
    fail "installer leaked the server's init walkthrough"
else
    pass "server's own init walkthrough held back"
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
PARACORD_NO_BROWSER=1 \
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
echo "== Step 6: the one link that finishes setup"

# The link the owner clicks carries the one-time owner token the server writes
# beside the config. `init` never mints one (only a real server start does), so
# the token is planted here and the installer re-run over the same directory
# with its binary removed - what a fresh install sees once its server is up.
LINK_INST="$WORK/inst_link"
link_install() {
    # link_install <logfile>
    PARACORD_LOCAL_ARCHIVE="$WORK/$ASSET" \
    PARACORD_INSTALL_DIR="$LINK_INST" \
    PARACORD_LINK_DIR=none \
    PARACORD_NO_SYSTEMD=1 \
    PARACORD_NO_BROWSER=1 \
        sh scripts/install.sh > "$1" 2>&1
}

link_install "$WORK/install_link1.log" || { cat "$WORK/install_link1.log"; fail "setup-link install exited non-zero"; }

# Move the server off 8443 before planting anything: the installer asks the
# address in the config whether setup is still needed, and on a developer box
# something else answering there must not be mistaken for this install.
sed -i -e 's/^port = 8443$/port = 18999/' "$LINK_INST/config/paracord.toml"
rm -f "$LINK_INST/paracord-server"
printf 'SMOKETOKEN123456\n' > "$LINK_INST/config/first-owner-claim.txt"
link_install "$WORK/install_link2.log" || { cat "$WORK/install_link2.log"; fail "setup-link re-install exited non-zero"; }

assert_contains "$WORK/install_link2.log" "source: token file" "link was built from the token file"
assert_contains "$WORK/install_link2.log" "https://localhost:18999/setup-server#claim=SMOKETOKEN123456" \
    "link is loopback + configured port + token in the fragment"
assert_contains "$WORK/install_link2.log" "Finish setting up" "ending leads with finishing setup"
# PARACORD_NO_BROWSER=1: nothing was opened, so the wording must not claim it was.
if grep -q "Finish setting up (opens in your browser)" "$WORK/install_link2.log"; then
    fail "PARACORD_NO_BROWSER=1 still claimed to open a browser"
else
    pass "PARACORD_NO_BROWSER=1 honored (link printed, nothing opened)"
fi

# A link file published by the server wins over the raw token, and the address
# the owner is told to open on this machine stays loopback.
printf 'https://192.168.5.5:18999/setup-server#claim=LINKFILETOKEN\n' \
    > "$LINK_INST/config/first-owner-claim-link.txt"
rm -f "$LINK_INST/paracord-server"
link_install "$WORK/install_link3.log" || { cat "$WORK/install_link3.log"; fail "link-file install exited non-zero"; }
assert_contains "$WORK/install_link3.log" "source: link file" "link file preferred over the token file"
assert_contains "$WORK/install_link3.log" "https://localhost:18999/setup-server#claim=LINKFILETOKEN" \
    "link file's token re-based on the loopback address"
if grep -q "192.168.5.5" "$WORK/install_link3.log"; then
    fail "local setup link should not point at a LAN address"
else
    pass "local setup link does not point at a LAN address"
fi

# What a non-technical owner reads: the block from the headline down to
# "Details". Jargon belongs below that line, not above it.
awk '/^Paracord (is installed|was updated)/ { on = 1 } on && /^Details$/ { exit } on { print }' \
    "$WORK/install_link2.log" > "$WORK/ending.txt"
if [ -s "$WORK/ending.txt" ]; then pass "closing block found"; else fail "closing block found"; fi
# `|| true`: no jargon means grep exits 1, and this script runs under `set -e`.
JARGON="$(grep -Eio 'claim token|instance|self-signed|QUIC|TCP|UDP|systemd|systemctl|operator|space' "$WORK/ending.txt" | sort -u | tr '\n' ' ' || true)"
if [ -z "$JARGON" ]; then
    pass "closing block is free of jargon"
else
    fail "closing block uses jargon: $JARGON"
fi
ENDING_LINES="$(wc -l < "$WORK/ending.txt")"
if [ "$ENDING_LINES" -le 15 ]; then
    pass "closing block is short ($ENDING_LINES lines)"
else
    fail "closing block is $ENDING_LINES lines; it should be at most 15"
fi
# The better path comes first: a domain and real certificates, then clicking
# through the warning for someone only trying it out.
domain_line="$(grep -n "give this server a domain name" "$WORK/ending.txt" | head -n 1 | cut -d: -f1)"
warning_line="$(grep -n "choose Advanced, then Continue" "$WORK/ending.txt" | head -n 1 | cut -d: -f1)"
if [ -n "$domain_line" ] && [ -n "$warning_line" ] && [ "$domain_line" -lt "$warning_line" ]; then
    pass "ending leads with a domain name, and clicking through the warning comes second"
else
    fail "ending should name a domain name before clicking through the certificate warning"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 7: HTTP download path with SHA-256 verification"

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
PARACORD_NO_BROWSER=1 \
    sh scripts/install.sh > "$WORK/install3.log" 2>&1 || { cat "$WORK/install3.log"; fail "HTTP install exited non-zero"; }

assert_executable "$INST2/paracord-server" "HTTP install placed the binary"
assert_file "$INST2/config/paracord.toml" "HTTP install generated config"
if grep -q "SHA-256 verified" "$WORK/install3.log"; then
    pass "SHA-256 verification ran against published SHA256SUMS"
else
    fail "SHA-256 verification ran against published SHA256SUMS"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 8: bad checksum aborts before installing"

# Deliberately wrong digest — constant so the corruption can never be a no-op.
printf '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef  %s\n' "$ASSET" \
    > "$SERVE_DIR/v$FAKE_VERSION/SHA256SUMS"
INST3="$WORK/inst3"
if PARACORD_VERSION="$FAKE_VERSION" \
   PARACORD_RELEASE_BASE_URL="http://127.0.0.1:$HTTP_PORT" \
   PARACORD_INSTALL_DIR="$INST3" \
   PARACORD_LINK_DIR=none \
   PARACORD_NO_SYSTEMD=1 \
   PARACORD_NO_BROWSER=1 \
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
echo "== Step 9: bare binary as PARACORD_LOCAL_ARCHIVE"

if [ -x "$REAL_BIN" ] && head -c 4 "$REAL_BIN" | grep -q ELF; then
    INST4="$WORK/inst4"
    PARACORD_LOCAL_ARCHIVE="$REAL_BIN" \
    PARACORD_INSTALL_DIR="$INST4" \
    PARACORD_LINK_DIR=none \
    PARACORD_NO_SYSTEMD=1 \
    PARACORD_NO_BROWSER=1 \
        sh scripts/install.sh > "$WORK/install5.log" 2>&1 || { cat "$WORK/install5.log"; fail "bare-binary install exited non-zero"; }
    assert_executable "$INST4/paracord-server" "bare binary installed"
    assert_file "$INST4/config/paracord.toml" "bare binary install ran init"
else
    note "no real binary — bare-binary path covered by the tarball test only"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 10: the router question"

# router_install <dir> <log> [installer args...] — a fresh install with no
# terminal. Extra environment is passed by the caller in front of it.
router_install() {
    rdir="$1"; rlog="$2"; shift 2
    PARACORD_LOCAL_ARCHIVE="$WORK/$ASSET" \
    PARACORD_INSTALL_DIR="$rdir" \
    PARACORD_LINK_DIR=none \
    PARACORD_NO_SYSTEMD=1 \
    PARACORD_NO_BROWSER=1 \
        sh scripts/install.sh "$@" < /dev/null > "$rlog" 2>&1
}

if router_install "$WORK/r_flag_yes" "$WORK/router_flag_yes.log" --allow-internet; then
    assert_contains "$WORK/r_flag_yes/config/paracord.toml" "^auto_port_forward = true$" "--allow-internet writes auto_port_forward = true"
    assert_contains "$WORK/router_flag_yes.log" "Paracord asks your router to let them in" "ending says the router is asked"
    if [ "$(grep -c '^auto_port_forward' "$WORK/r_flag_yes/config/paracord.toml")" = "1" ]; then
        pass "the router answer replaces the line rather than adding a second one"
    else
        fail "the config has more than one auto_port_forward line"
    fi
else
    cat "$WORK/router_flag_yes.log"; fail "--allow-internet install exited non-zero"
fi

if PARACORD_ALLOW_INTERNET=1 router_install "$WORK/r_env_yes" "$WORK/router_env_yes.log"; then
    assert_contains "$WORK/r_env_yes/config/paracord.toml" "^auto_port_forward = true$" "PARACORD_ALLOW_INTERNET=1 writes auto_port_forward = true"
else
    cat "$WORK/router_env_yes.log"; fail "PARACORD_ALLOW_INTERNET=1 install exited non-zero"
fi

if PARACORD_ALLOW_INTERNET=1 router_install "$WORK/r_flag_no" "$WORK/router_flag_no.log" --home-network-only; then
    assert_contains "$WORK/r_flag_no/config/paracord.toml" "^auto_port_forward = false$" "--home-network-only wins over the variable"
else
    cat "$WORK/router_flag_no.log"; fail "--home-network-only install exited non-zero"
fi

if PARACORD_ALLOW_INTERNET=maybe router_install "$WORK/r_env_bad" "$WORK/router_env_bad.log"; then
    fail "PARACORD_ALLOW_INTERNET=maybe should refuse to install"
else
    assert_contains "$WORK/router_env_bad.log" "PARACORD_ALLOW_INTERNET is 'maybe'" "an unclear PARACORD_ALLOW_INTERNET is refused, not guessed"
fi

if router_install "$WORK/r_bad_flag" "$WORK/router_bad_flag.log" --open-everything; then
    fail "an unknown option should be refused"
else
    assert_contains "$WORK/router_bad_flag.log" "unknown option --open-everything" "an unknown option is refused by name"
fi

# CI=true with no flag: decided without asking, and the answer is no.
if CI=true router_install "$WORK/r_ci" "$WORK/router_ci.log"; then
    assert_contains "$WORK/r_ci/config/paracord.toml" "^auto_port_forward = false$" "a CI run with no flag answers no"
else
    cat "$WORK/router_ci.log"; fail "CI install exited non-zero"
fi

# An upgrade never changes a running install's answer, flag or no flag.
cp "$WORK/r_flag_yes/config/paracord.toml" "$WORK/r_flag_yes.before"
if router_install "$WORK/r_flag_yes" "$WORK/router_upgrade.log" --home-network-only; then
    if cmp -s "$WORK/r_flag_yes.before" "$WORK/r_flag_yes/config/paracord.toml"; then
        pass "an upgrade keeps the existing router answer"
    else
        fail "an upgrade changed the existing config"
    fi
    assert_contains "$WORK/router_upgrade.log" "only apply to a fresh install" "an upgrade says the flag did not apply"
else
    cat "$WORK/router_upgrade.log"; fail "upgrade with --home-network-only exited non-zero"
fi

# With a terminal the installer asks. `script` gives it one; what is typed is
# the answer, and pressing Enter is no.
if command -v script >/dev/null 2>&1 && script -qec true /dev/null >/dev/null 2>&1; then
    for answer in y n ""; do
        tdir="$WORK/r_tty_${answer:-enter}"
        printf '%s\n' "$answer" | env -u CI \
            PARACORD_LOCAL_ARCHIVE="$WORK/$ASSET" \
            PARACORD_INSTALL_DIR="$tdir" \
            PARACORD_LINK_DIR=none \
            PARACORD_NO_SYSTEMD=1 \
            PARACORD_NO_BROWSER=1 \
            script -qec "sh scripts/install.sh" /dev/null > "$WORK/router_tty_${answer:-enter}.log" 2>&1 || true
        expected=false
        [ "$answer" = "y" ] && expected=true
        if grep -q "Let friends outside your home network connect? Paracord can ask your router" "$WORK/router_tty_${answer:-enter}.log"; then
            pass "with a terminal the installer asks the router question (answer '${answer:-Enter}')"
        else
            fail "with a terminal the installer did not ask (answer '${answer:-Enter}')"
        fi
        assert_contains "$tdir/config/paracord.toml" "^auto_port_forward = $expected$" "answer '${answer:-Enter}' writes auto_port_forward = $expected"
    done
else
    note "no working \`script\` command — the interactive question is not exercised here"
fi

# The root-path stub writes a config with no [network] section at all; the
# answer is still written, as a section of its own.
STUB_CFG="$WORK/stubcfg"
mkdir -p "$STUB_CFG"
if PARACORD_LOCAL_ARCHIVE="$WORK/$STUB_ASSET" PARACORD_INSTALL_DIR="$STUB_CFG" PARACORD_LINK_DIR=none \
    PARACORD_NO_SYSTEMD=1 PARACORD_NO_BROWSER=1 sh scripts/install.sh --allow-internet < /dev/null > "$WORK/router_stub.log" 2>&1; then
    assert_contains "$STUB_CFG/config/paracord.toml" "^\[network\]$" "a config without [network] gets the section"
    assert_contains "$STUB_CFG/config/paracord.toml" "^auto_port_forward = true$" "...with the answer in it"
else
    cat "$WORK/router_stub.log"; fail "install over a config without [network] exited non-zero"
fi

# ─────────────────────────────────────────────────────────────────────────────
echo "== Step 11: root + systemd path (only when safely testable)"

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
        PARACORD_NO_BROWSER=1 \
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
