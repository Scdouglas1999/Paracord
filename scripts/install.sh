#!/bin/sh
# Paracord server installer — one-command install and upgrade for the release
# binary.
#
#   curl -fsSL https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.sh | sh
#
# What it does:
#   - detects the OS/architecture and picks the matching server archive
#     (Linux x86_64 only — there are no prebuilt ARM/macOS server releases)
#   - resolves the latest release tag from the GitHub API (overridable)
#   - verifies SHA-256 when the release publishes checksums; warns loudly when
#     it does not (releases currently ship no checksum files — see docs)
#   - installs into /opt/paracord as root, or ~/.local/share/paracord otherwise
#   - as root on a systemd host: creates a `paracord` system user and a
#     hardened, auto-restarting systemd unit; as a regular user with a systemd
#     user manager: a per-user unit; otherwise prints the command to run
#   - runs `paracord-server init` to generate config/paracord.toml (fresh JWT
#     secret, self-signed TLS defaults) and prints the URL to open
#   - re-running upgrades the binary in place: config/ and data/ are preserved
#     and the previous binary is kept under backups/
#
# Environment overrides:
#   PARACORD_VERSION            "2.0.0" or "v2.0.0" — skip latest-release lookup
#   PARACORD_RELEASE_BASE_URL   URL base holding <tag>/<asset> (default GitHub)
#   PARACORD_LOCAL_ARCHIVE      path to a local .tar.gz (or bare paracord-server
#                               binary) for offline installs and CI
#   PARACORD_INSTALL_DIR        install destination
#   PARACORD_LINK_DIR           directory for a `paracord-server` PATH symlink
#   PARACORD_NO_SYSTEMD=1       never create or touch systemd units
#   PARACORD_GITHUB_REPO        owner/repo for release lookup
#                               (default Scdouglas1999/Paracord)
#
# POSIX sh — works under dash, bash, ash. `set -eu` everywhere; any failure
# aborts before the install directory is left half-written.
set -eu

PROG="paracord-install"
GITHUB_REPO="${PARACORD_GITHUB_REPO:-Scdouglas1999/Paracord}"
RELEASE_BASE_URL="${PARACORD_RELEASE_BASE_URL:-https://github.com/${GITHUB_REPO}/releases/download}"
API_URL="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
SERVICE_NAME="paracord"
RUN_USER="paracord"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '%s: warning: %s\n' "$PROG" "$*" >&2; }
die()  { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }

usage() {
    cat <<'EOF'
Paracord server installer

Usage:
  sh install.sh [--help]

Common invocations:
  curl -fsSL https://raw.githubusercontent.com/Scdouglas1999/Paracord/main/scripts/install.sh | sh
  curl -fsSL ... | sudo sh                                  # system install to /opt/paracord
  PARACORD_VERSION=2.0.0 sh install.sh                      # pin a release
  PARACORD_LOCAL_ARCHIVE=./paracord-server-linux-x64-2.0.0.tar.gz sh install.sh

Environment overrides: PARACORD_VERSION, PARACORD_RELEASE_BASE_URL,
PARACORD_LOCAL_ARCHIVE, PARACORD_INSTALL_DIR, PARACORD_LINK_DIR,
PARACORD_NO_SYSTEMD=1, PARACORD_GITHUB_REPO.
EOF
}

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
    usage
    exit 0
fi

# ── Tool checks ──────────────────────────────────────────────────────────────

FETCH=""
fetch() {
    # fetch <url> <outfile>
    if [ "$FETCH" = "curl" ]; then
        curl -fsSL --retry 3 --connect-timeout 15 "$1" -o "$2"
    else
        wget -q -O "$2" "$1"
    fi
}

need_cmd() { command -v "$1" >/dev/null 2>&1; }

check_tools() {
    need_cmd uname || die "uname not found; this installer needs a POSIX system"
    need_cmd tar   || die "tar not found; install tar and retry"
    if [ -z "${PARACORD_LOCAL_ARCHIVE:-}" ]; then
        if need_cmd curl; then FETCH=curl
        elif need_cmd wget; then FETCH=wget
        else die "neither curl nor wget found; install one, or set PARACORD_LOCAL_ARCHIVE for an offline install"
        fi
    fi
}

sha256_of() {
    if need_cmd sha256sum; then
        sha256sum "$1" | awk '{print $1}'
    elif need_cmd shasum; then
        shasum -a 256 "$1" | awk '{print $1}'
    elif need_cmd openssl; then
        openssl dgst -sha256 "$1" | awk '{print $NF}'
    else
        return 1
    fi
}

# ── Platform detection ───────────────────────────────────────────────────────

detect_platform() {
    os="$(uname -s)"
    arch="$(uname -m)"
    case "$os" in
        Linux) ;;
        Darwin)
            die "no prebuilt Paracord server for macOS — build from source (cargo build --release --bin paracord-server) or use the Docker stack; see docs/getting-started.md" ;;
        MINGW*|MSYS*|CYGWIN*)
            die "on Windows use scripts/install.ps1 instead:
  powershell -ExecutionPolicy Bypass -File install.ps1" ;;
        *) die "unsupported OS '$os' — releases ship Linux x64 and Windows x64 servers only" ;;
    esac
    case "$arch" in
        x86_64|amd64|AMD64) PLATFORM="linux-x64" ;;
        aarch64|arm64)
            die "no prebuilt Paracord server for ARM64 — build from source or run the Docker stack on this host" ;;
        *) die "unsupported architecture '$arch' — releases ship linux-x64 only" ;;
    esac
}

# ── Version / asset resolution ───────────────────────────────────────────────

resolve_release() {
    # Sets TAG, VERSION_NUM, ASSET, DOWNLOAD_URL.
    if [ -n "${PARACORD_VERSION:-}" ]; then
        VERSION_NUM="${PARACORD_VERSION#v}"
        TAG="v${VERSION_NUM}"
    else
        step "Resolving latest Paracord release"
        json="$TMP_DIR/release.json"
        fetch "$API_URL" "$json" 2>/dev/null \
            || die "could not query ${API_URL} — check connectivity, or set PARACORD_VERSION / PARACORD_LOCAL_ARCHIVE"
        if need_cmd jq; then
            TAG="$(jq -r '.tag_name' "$json")"
        else
            TAG="$(sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$json" | head -n 1)"
        fi
        [ -n "$TAG" ] || die "release lookup returned no tag_name — set PARACORD_VERSION explicitly"
        VERSION_NUM="${TAG#v}"
    fi
    ASSET="paracord-server-${PLATFORM}-${VERSION_NUM}.tar.gz"
    DOWNLOAD_URL="${RELEASE_BASE_URL}/${TAG}/${ASSET}"
    say "Release: ${TAG}  asset: ${ASSET}"
}

# ── Download + optional checksum verification ────────────────────────────────

verify_checksum() {
    # verify_checksum <archive> <expected-hex>; dies on mismatch.
    expected="$2"
    actual="$(sha256_of "$1")" || die "no sha256sum/shasum/openssl available to verify the archive"
    if [ "$actual" != "$expected" ]; then
        die "SHA-256 mismatch for $(basename "$1"):
  expected: $expected
  actual:   $actual
The archive is not installed. If this persists, do not retry blindly — the download may be corrupted or tampered with."
    fi
    say "SHA-256 verified: $actual"
}

# Try to locate a published checksum for ASSET and verify; loudly note absence.
maybe_verify_archive() {
    archive="$1"   # path on disk
    csum_found=0
    expected=""

    if [ -n "${PARACORD_LOCAL_ARCHIVE:-}" ] && [ -f "${archive}.sha256" ]; then
        expected="$(awk '{print $1}' "${archive}.sha256" | head -n 1)"
        csum_found=1
    elif [ -z "${PARACORD_LOCAL_ARCHIVE:-}" ]; then
        # Probe the checksum filenames a release might publish. The current
        # release workflow ships none — the first hit wins.
        for name in "${ASSET}.sha256" "SHA256SUMS" "SHA256SUMS.txt" "checksums.txt"; do
            cfile="$TMP_DIR/$name"
            if fetch "${RELEASE_BASE_URL}/${TAG}/${name}" "$cfile" 2>/dev/null; then
                if [ "$name" = "${ASSET}.sha256" ]; then
                    expected="$(awk '{print $1}' "$cfile" | head -n 1)"
                else
                    expected="$(sed -n "s/^\\([0-9a-fA-F]\\{64\\}\\)[[:space:]]*\\*\\?${ASSET}\$/\\1/p" "$cfile" | head -n 1)"
                fi
                csum_found=1
                break
            fi
        done
    fi

    if [ "$csum_found" -eq 1 ] && [ -n "$expected" ]; then
        verify_checksum "$archive" "$expected"
    elif [ "$csum_found" -eq 1 ]; then
        warn "a checksum file was published but has no entry for ${ASSET}; cannot verify — installing anyway"
    else
        warn "this release does not publish SHA-256 checksums — the archive cannot be integrity-verified.
       Downloaded from the official ${GITHUB_REPO} releases over TLS; if you need
       stronger guarantees, download the archive yourself, verify it out-of-band,
       and install with PARACORD_LOCAL_ARCHIVE=<file>."
    fi
}

# ── Archive acquisition + extraction ─────────────────────────────────────────

acquire_archive() {
    # Sets ARCHIVE_PATH.
    if [ -n "${PARACORD_LOCAL_ARCHIVE:-}" ]; then
        [ -f "$PARACORD_LOCAL_ARCHIVE" ] || die "PARACORD_LOCAL_ARCHIVE='$PARACORD_LOCAL_ARCHIVE' does not exist"
        ARCHIVE_PATH="$PARACORD_LOCAL_ARCHIVE"
        step "Using local archive: $ARCHIVE_PATH"
    else
        step "Downloading $DOWNLOAD_URL"
        ARCHIVE_PATH="$TMP_DIR/$ASSET"
        fetch "$DOWNLOAD_URL" "$ARCHIVE_PATH" \
            || die "download failed — check the URL and that release ${TAG} ships ${ASSET}"
    fi
    maybe_verify_archive "$ARCHIVE_PATH"
}

extract_payload() {
    # Fills $TMP_DIR/payload with: paracord-server (+ livekit-server,
    # paracord.example.toml, README.txt when the archive ships them).
    step "Unpacking"
    payload="$TMP_DIR/payload"
    mkdir -p "$payload"

    if tar -tzf "$ARCHIVE_PATH" >/dev/null 2>&1; then
        mkdir -p "$TMP_DIR/x"
        tar -xzf "$ARCHIVE_PATH" -C "$TMP_DIR/x"
        # Current layout: paracord-server/{paracord-server,livekit-server,...}.
        # Older releases: a bare paracord-server file at the archive root.
        if [ -f "$TMP_DIR/x/paracord-server/paracord-server" ]; then
            cp "$TMP_DIR/x/paracord-server/"* "$payload/" 2>/dev/null || true
        elif [ -f "$TMP_DIR/x/paracord-server" ]; then
            cp "$TMP_DIR/x/paracord-server" "$payload/paracord-server"
        else
            # Last resort: search one level deep for an executable by name.
            found="$(find "$TMP_DIR/x" -maxdepth 3 -type f -name 'paracord-server' | head -n 1)"
            [ -n "$found" ] || die "archive does not contain a paracord-server binary — unexpected layout:\n$(tar -tzf "$ARCHIVE_PATH" | head -n 20)"
            dir="$(dirname "$found")"
            cp "$dir/"* "$payload/" 2>/dev/null || true
        fi
    elif [ -x "$ARCHIVE_PATH" ] || head -c 4 "$ARCHIVE_PATH" 2>/dev/null | grep -q 'ELF'; then
        # PARACORD_LOCAL_ARCHIVE pointed at a bare binary.
        cp "$ARCHIVE_PATH" "$payload/paracord-server"
    else
        die "archive is neither a .tar.gz nor an executable binary: $ARCHIVE_PATH"
    fi

    [ -f "$payload/paracord-server" ] || die "no paracord-server binary found in the archive"
    chmod 0755 "$payload/paracord-server"
    [ -f "$payload/livekit-server" ] && chmod 0755 "$payload/livekit-server"
    PAYLOAD_DIR="$payload"
}

# ── Install layout ───────────────────────────────────────────────────────────

choose_install_dir() {
    if [ -n "${PARACORD_INSTALL_DIR:-}" ]; then
        INSTALL_DIR="$PARACORD_INSTALL_DIR"
    elif [ "$(id -u)" = "0" ]; then
        INSTALL_DIR="/opt/paracord"
    else
        INSTALL_DIR="${HOME}/.local/share/paracord"
    fi
    CONFIG_PATH="$INSTALL_DIR/config/paracord.toml"
    DATA_DIR="$INSTALL_DIR/data"
}

install_files() {
    step "Installing to $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR" "$INSTALL_DIR/config" "$DATA_DIR" "$INSTALL_DIR/backups" \
        || die "cannot create $INSTALL_DIR — check permissions (run with sudo for a system install)"

    # Stage inside the install dir so the final mv is an atomic rename on the
    # same filesystem. A running server keeps its old inode; no ETXTBSY window.
    stage="$INSTALL_DIR/.install-stage.$$"
    rm -rf "$stage"
    mkdir -p "$stage"
    for f in paracord-server livekit-server paracord.example.toml README.txt; do
        [ -f "$PAYLOAD_DIR/$f" ] && cp "$PAYLOAD_DIR/$f" "$stage/$f"
    done

    if [ -f "$INSTALL_DIR/paracord-server" ]; then
        IS_UPGRADE=1
        backup="$INSTALL_DIR/backups/paracord-server.$(date +%Y%m%d-%H%M%S)"
        mv "$INSTALL_DIR/paracord-server" "$backup"
        say "Previous binary backed up to $backup"
    else
        IS_UPGRADE=0
    fi

    for f in paracord-server livekit-server; do
        [ -f "$stage/$f" ] && chmod 0755 "$stage/$f"
    done
    for f in paracord-server livekit-server paracord.example.toml README.txt; do
        [ -f "$stage/$f" ] && mv "$stage/$f" "$INSTALL_DIR/$f"
    done
    rm -rf "$stage"

    [ -f "$INSTALL_DIR/livekit-server" ] || \
        warn "archive ships no livekit-server — fine for the default native QUIC media; needed only if you later opt into LiveKit"
}

# ── paracord system user (root installs) ─────────────────────────────────────

ensure_service_user() {
    [ "$(id -u)" = "0" ] || return 0
    if id "$RUN_USER" >/dev/null 2>&1; then
        say "System user '$RUN_USER' already exists"
        return 0
    fi
    if need_cmd useradd; then
        useradd --system --home-dir "$INSTALL_DIR" --shell /usr/sbin/nologin "$RUN_USER" \
            || die "useradd failed for '$RUN_USER'"
    elif need_cmd adduser; then
        adduser --system --home "$INSTALL_DIR" --shell /usr/sbin/nologin --group "$RUN_USER" \
            || die "adduser failed for '$RUN_USER'"
    else
        die "no useradd/adduser available to create the '$RUN_USER' service user"
    fi
    say "Created system user '$RUN_USER' (home $INSTALL_DIR, nologin)"
}

# ── First-run config generation ──────────────────────────────────────────────

absolutize_data_paths() {
    # The generated config uses ./data/... relative paths, resolved against the
    # process working directory. Pin them to $INSTALL_DIR/data so the server
    # finds its database/certs/uploads no matter where it is launched from.
    [ -f "$CONFIG_PATH" ] || return 0
    grep -q '\./data/' "$CONFIG_PATH" || return 0
    esc="$(printf '%s' "$INSTALL_DIR" | sed 's:[&|\\/]:\\&:g')"
    sed -i "s|\\./data/|${esc}/data/|g" "$CONFIG_PATH"
    say "Pinned data paths in $CONFIG_PATH to $DATA_DIR"
}

run_init() {
    if [ -f "$CONFIG_PATH" ]; then
        say "Existing config preserved at $CONFIG_PATH"
        return 0
    fi
    step "Generating configuration"
    init_cmd="\"$INSTALL_DIR/paracord-server\" -c \"$CONFIG_PATH\" init"
    if [ "$(id -u)" = "0" ] && id "$RUN_USER" >/dev/null 2>&1; then
        if need_cmd runuser; then
            (cd "$INSTALL_DIR" && runuser -u "$RUN_USER" -- ./paracord-server -c "$CONFIG_PATH" init)
        else
            (cd "$INSTALL_DIR" && su -s /bin/sh "$RUN_USER" -c "$init_cmd")
        fi
    else
        (cd "$INSTALL_DIR" && ./paracord-server -c "$CONFIG_PATH" init)
    fi
    [ -f "$CONFIG_PATH" ] || die "paracord-server init did not create $CONFIG_PATH"
    absolutize_data_paths
    # sed -i above recreated the config as root; hand it back to the service user.
    [ "$(id -u)" = "0" ] && chown "$RUN_USER:$RUN_USER" "$CONFIG_PATH"
    return 0
}

fix_ownership() {
    [ "$(id -u)" = "0" ] || return 0
    chown -R "$RUN_USER:$RUN_USER" "$INSTALL_DIR"
}

link_binary() {
    case "${PARACORD_LINK_DIR:-}" in
        "" )
            if [ "$(id -u)" = "0" ]; then LINK_DIR=/usr/local/bin; else LINK_DIR="$HOME/.local/bin"; fi ;;
        none|NONE|off)
            return 0 ;;
        *) LINK_DIR="$PARACORD_LINK_DIR" ;;
    esac
    if mkdir -p "$LINK_DIR" 2>/dev/null && [ -w "$LINK_DIR" ]; then
        ln -sfn "$INSTALL_DIR/paracord-server" "$LINK_DIR/paracord-server"
        say "Linked $LINK_DIR/paracord-server -> $INSTALL_DIR/paracord-server"
        case ":$PATH:" in
            *":$LINK_DIR:"*) ;;
            *) warn "$LINK_DIR is not on PATH; run the server as $INSTALL_DIR/paracord-server" ;;
        esac
    else
        warn "could not write $LINK_DIR — no PATH symlink created"
    fi
}

# ── systemd ──────────────────────────────────────────────────────────────────

systemd_available() {
    [ "${PARACORD_NO_SYSTEMD:-0}" = "1" ] && return 1
    need_cmd systemctl || return 1
    [ -d /run/systemd/system ] || return 1
}

user_systemd_available() {
    systemd_available || return 1
    [ "$(id -u)" != "0" ] || return 1
    # A user manager must actually be reachable (not true in cron/CI shells).
    systemctl --user show-environment >/dev/null 2>&1
}

write_system_unit() {
    unit="/etc/systemd/system/${SERVICE_NAME}.service"
    cat > "$unit" <<EOF
[Unit]
Description=Paracord Server
After=network-online.target
Wants=network-online.target
# Generated by scripts/install.sh — config and data live under $INSTALL_DIR.

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_USER
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/paracord-server -c $CONFIG_PATH
Restart=always
RestartSec=5
LimitNOFILE=65535

# Hardening: the server only writes inside its install directory and binds
# unprivileged ports (8090/8443), so it needs no capabilities.
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$INSTALL_DIR
ProtectHome=true
PrivateTmp=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK

[Install]
WantedBy=multi-user.target
EOF
    say "Wrote $unit"
}

write_user_unit() {
    udir="$HOME/.config/systemd/user"
    mkdir -p "$udir"
    unit="$udir/${SERVICE_NAME}.service"
    cat > "$unit" <<EOF
[Unit]
Description=Paracord Server (user)
After=network-online.target
# Generated by scripts/install.sh — config and data live under $INSTALL_DIR.

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$INSTALL_DIR/paracord-server -c $CONFIG_PATH
Restart=always
RestartSec=5
LimitNOFILE=65535
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=default.target
EOF
    say "Wrote $unit"
}

print_manual_run() {
    cat <<EOF

  No service manager was configured. Run the server with:

      cd $INSTALL_DIR && ./paracord-server

  (or in the background:  nohup ./paracord-server > server.log 2>&1 &)
EOF
}

setup_service() {
    if [ "${PARACORD_NO_SYSTEMD:-0}" = "1" ]; then
        say "PARACORD_NO_SYSTEMD=1 — skipping service setup"
        print_manual_run
        return 0
    fi
    if [ "$(id -u)" = "0" ]; then
        if systemd_available; then
            write_system_unit
            systemctl daemon-reload
            systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
            if [ "$IS_UPGRADE" = "1" ] && systemctl is-active --quiet "$SERVICE_NAME"; then
                systemctl restart "$SERVICE_NAME"
            else
                systemctl start "$SERVICE_NAME" || true
            fi
            sleep 1
            if systemctl is-active --quiet "$SERVICE_NAME"; then
                say "Service '$SERVICE_NAME' is enabled and running (systemctl status $SERVICE_NAME)"
            else
                warn "service did not report active — inspect with: journalctl -u $SERVICE_NAME -n 50"
            fi
        else
            warn "running as root but systemd is not present — no service installed"
            print_manual_run
        fi
    elif user_systemd_available; then
        write_user_unit
        systemctl --user daemon-reload
        systemctl --user enable "$SERVICE_NAME" >/dev/null 2>&1 || true
        if [ "$IS_UPGRADE" = "1" ] && systemctl --user is-active --quiet "$SERVICE_NAME"; then
            systemctl --user restart "$SERVICE_NAME"
        else
            systemctl --user start "$SERVICE_NAME" || true
        fi
        sleep 1
        if systemctl --user is-active --quiet "$SERVICE_NAME"; then
            say "User service '$SERVICE_NAME' is enabled and running"
            say "To keep it running after logout: loginctl enable-linger $(id -un)"
        else
            warn "user service did not report active — inspect with: journalctl --user -u $SERVICE_NAME -n 50"
            print_manual_run
        fi
    else
        print_manual_run
    fi
}

# ── Summary ──────────────────────────────────────────────────────────────────

print_summary() {
    # Prefer the operator-configured public URL when the config sets one
    # (e.g. on upgrades); otherwise the release default is HTTPS :8443.
    share_url="$(awk '
        /^\[/ { in_server = ($0 ~ /^\[server\]/) }
        in_server && /^[[:space:]]*public_url[[:space:]]*=/ {
            sub(/^[^"]*"/, ""); sub(/".*$/, ""); print; exit
        }' "$CONFIG_PATH" 2>/dev/null)"
    [ -n "$share_url" ] || share_url="https://localhost:8443"
    cat <<EOF

  ┌─ Paracord installed ─────────────────────────────────
  │
  │  Install dir:  $INSTALL_DIR
  │  Config:       $CONFIG_PATH
  │  Data:         $DATA_DIR
  │
  │  Open / share: $share_url   (self-signed cert — accept
  │  the one-time browser warning)
  │
  │  Next steps:
  │   1. Claim the server: a fresh instance has no owner
  │      and refuses registrations until claimed. Open
  │      $share_url/setup-server and paste the
  │      one-time claim token from
  │      $(dirname "$CONFIG_PATH")/first-owner-claim.txt
  │      (also printed in the server log). That creates
  │      your owner account, names the server and opens
  │      its first space. Do this before sharing the URL.
  │   2. Invite others: share the URL, or create an
  │      invite link from any channel once you're in.
  │   3. Remote access + voice/video: forward port 8443
  │      (TCP + UDP) to this machine. TCP carries HTTPS,
  │      UDP carries native QUIC media.
  │
  │  Upgrade: re-run this installer any time — config and
  │  data are preserved and the old binary is backed up
  │  under $INSTALL_DIR/backups/.
  │
  └──────────────────────────────────────────────────────
EOF
    if [ "$(id -u)" != "0" ]; then
        say "  Tip: for a system-wide install under /opt with a systemd service:"
        say "       curl -fsSL https://raw.githubusercontent.com/${GITHUB_REPO}/main/scripts/install.sh | sudo sh"
        say ""
    fi
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t paracord-install)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    say "Paracord server installer"
    check_tools
    detect_platform
    if [ -z "${PARACORD_LOCAL_ARCHIVE:-}" ]; then
        resolve_release
    fi
    acquire_archive
    extract_payload
    choose_install_dir
    install_files
    ensure_service_user
    # chown before `init` so the config it writes (as the paracord user) lands
    # in directories it can actually write into.
    fix_ownership
    run_init
    link_binary
    setup_service
    print_summary
}

main "$@"
