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
#   - waits for the running server to mint the one-time owner setup token, turns
#     it into a ready-to-open link (<local-url>/setup-server#claim=<TOKEN> — a
#     fragment, so the token never reaches a server log or proxy log), opens it
#     in the default browser on a desktop session and always prints it
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
#   PARACORD_NO_BROWSER=1       never open a browser; just print the setup link
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
# launchd labels are reverse-DNS by convention and must be unique per machine.
LAUNCHD_LABEL="com.paracord.server"
OS_FAMILY="linux"
RUN_USER="paracord"
DOCS_URL="https://github.com/${GITHUB_REPO}/blob/main/docs/port-forwarding.md"

# State the ending text reads. Set before anything can print.
IS_UPGRADE=0
SERVER_STARTED=0
# Set only when this run handed the server to a service manager that started it.
SERVICE_MANAGED=0
BROWSER_OPENED=0
CLAIM_LINK=""
CLAIM_LINK_SOURCE=""
CLAIM_TOKEN_FILE=""
CLAIM_LINK_FILE=""
LINGER_HINT=""
SERVICE_DESC=""
SERVICE_LOGS=""
VERSION_LABEL=""
LOCAL_URL="https://localhost:8443"
SHARE_URL="$LOCAL_URL"
WEB_PORT="8443"
VOICE_PORT="8443"
WEB_SCHEME="https"

say()  { printf '%s\n' "$*"; }
step() { printf '\n==> %s\n' "$*"; }
warn() { printf '%s: warning: %s\n' "$PROG" "$*" >&2; }
die()  { printf '%s: error: %s\n' "$PROG" "$*" >&2; exit 1; }

# The closing "Details" block is deliberately quieter than the steps above it.
# Only a real terminal gets the escape; a log file or a pipe stays plain text.
dim_start() {
    if [ -t 1 ] && [ -n "${TERM:-}" ] && [ "${TERM:-}" != "dumb" ]; then
        printf '\033[2m'
    fi
}
dim_end() {
    if [ -t 1 ] && [ -n "${TERM:-}" ] && [ "${TERM:-}" != "dumb" ]; then
        printf '\033[0m'
    fi
}

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
PARACORD_NO_SYSTEMD=1, PARACORD_NO_BROWSER=1, PARACORD_GITHUB_REPO.
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
        Linux) OS_FAMILY="linux" ;;
        Darwin) OS_FAMILY="macos" ;;
        MINGW*|MSYS*|CYGWIN*)
            die "on Windows use scripts/install.ps1 instead:
  powershell -ExecutionPolicy Bypass -File install.ps1" ;;
        *) die "unsupported OS '$os' — releases ship Linux, macOS and Windows servers" ;;
    esac
    case "$OS_FAMILY:$arch" in
        linux:x86_64|linux:amd64|linux:AMD64) PLATFORM="linux-x64" ;;
        linux:aarch64|linux:arm64)
            die "no prebuilt Paracord server for Linux ARM64 — build from source or run the Docker stack on this host" ;;
        macos:arm64|macos:aarch64) PLATFORM="macos-arm64" ;;
        macos:x86_64|macos:amd64) PLATFORM="macos-x64" ;;
        *) die "unsupported architecture '$arch' on $os" ;;
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

    # Not a problem: voice and video run on Paracord's own media engine. The
    # optional LiveKit companion is only needed by deployments that opt into it.
    [ -f "$INSTALL_DIR/livekit-server" ] || \
        say "Note: this build ships no optional LiveKit companion — voice and video do not need it."
}

# ── paracord system user (root installs) ─────────────────────────────────────

ensure_service_user() {
    [ "$(id -u)" = "0" ] || return 0
    # macOS has no useradd/adduser, and creating a hidden service account with
    # `dscl` means picking a free UID by hand — enough moving parts to be its
    # own failure mode. The daemon instead runs as whoever invoked sudo, which
    # keeps a network service off root without inventing an account.
    if [ "$OS_FAMILY" = "macos" ]; then
        RUN_USER="${SUDO_USER:-root}"
        if [ "$RUN_USER" = "root" ]; then
            warn "installing as root with no SUDO_USER — the daemon will run as root; prefer 'sudo sh install.sh' from your own account"
        else
            say "LaunchDaemon will run as '$RUN_USER'"
        fi
        return 0
    fi
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
    # `init` prints its own operator-facing walkthrough. Hold it back: this
    # installer prints one short set of instructions at the end, and two
    # competing sets of "next steps" is how a simple install starts to look
    # complicated. The output is kept and shown in full if `init` fails.
    init_log="$TMP_DIR/init.log"
    init_cmd="\"$INSTALL_DIR/paracord-server\" -c \"$CONFIG_PATH\" init"
    init_rc=0
    if [ "$(id -u)" = "0" ] && id "$RUN_USER" >/dev/null 2>&1; then
        if need_cmd runuser; then
            (cd "$INSTALL_DIR" && runuser -u "$RUN_USER" -- ./paracord-server -c "$CONFIG_PATH" init) \
                >"$init_log" 2>&1 || init_rc=$?
        else
            (cd "$INSTALL_DIR" && su -s /bin/sh "$RUN_USER" -c "$init_cmd") \
                >"$init_log" 2>&1 || init_rc=$?
        fi
    else
        (cd "$INSTALL_DIR" && ./paracord-server -c "$CONFIG_PATH" init) \
            >"$init_log" 2>&1 || init_rc=$?
    fi
    if [ "$init_rc" != "0" ]; then
        cat "$init_log" >&2
        die "paracord-server init failed (exit $init_rc)"
    fi
    [ -f "$CONFIG_PATH" ] || { cat "$init_log" >&2; die "paracord-server init did not create $CONFIG_PATH"; }
    say "Settings written to $CONFIG_PATH"
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

# ── launchd (macOS) ──────────────────────────────────────────────────────────
#
# macOS has no systemd. The equivalent is a launchd job: a LaunchDaemon under
# /Library/LaunchDaemons when installing as root (starts at boot, independent of
# login) or a LaunchAgent under ~/Library/LaunchAgents for a user install
# (starts at login). `KeepAlive` is launchd's `Restart=always`.

launchd_available() {
    [ "${PARACORD_NO_SERVICE:-0}" = "1" ] && return 1
    [ "$OS_FAMILY" = "macos" ] || return 1
    need_cmd launchctl
}

write_launchd_plist() {
    # $1: plist path, $2: the user to run as (empty for a user agent)
    plist="$1"
    run_as="$2"
    mkdir -p "$(dirname "$plist")"
    cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LAUNCHD_LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$INSTALL_DIR/paracord-server</string>
        <string>-c</string>
        <string>$INSTALL_DIR/config/paracord.toml</string>
    </array>
    <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$INSTALL_DIR/logs/paracord.log</string>
    <key>StandardErrorPath</key><string>$INSTALL_DIR/logs/paracord.err.log</string>
EOF
    if [ -n "$run_as" ]; then
        printf '    <key>UserName</key><string>%s</string>\n' "$run_as" >> "$plist"
    fi
    cat >> "$plist" <<EOF
</dict>
</plist>
EOF
    mkdir -p "$INSTALL_DIR/logs"
    chmod 644 "$plist"
}

install_launchd_service() {
    if [ "$(id -u)" = "0" ]; then
        plist="/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist"
        write_launchd_plist "$plist" "$RUN_USER"
        chown root:wheel "$plist" 2>/dev/null || true
        # `bootout` first so an upgrade reloads the new plist rather than
        # leaving the old job definition resident.
        launchctl bootout system "$plist" >/dev/null 2>&1 || true
        SERVICE_DESC="launchd job '$LAUNCHD_LABEL' (starts with the computer)"
        SERVICE_LOGS="$INSTALL_DIR/logs/paracord.log"
        if launchctl bootstrap system "$plist" 2>/dev/null; then
            SERVER_STARTED=1
            SERVICE_MANAGED=1
            say "LaunchDaemon '$LAUNCHD_LABEL' installed and started (starts at boot)"
        else
            warn "could not bootstrap the LaunchDaemon — load it with: sudo launchctl bootstrap system $plist"
            no_service_configured
        fi
    else
        plist="$HOME/Library/LaunchAgents/${LAUNCHD_LABEL}.plist"
        write_launchd_plist "$plist" ""
        launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
        SERVICE_DESC="launchd job '$LAUNCHD_LABEL' (starts when you log in)"
        SERVICE_LOGS="$INSTALL_DIR/logs/paracord.log"
        if launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null; then
            SERVER_STARTED=1
            SERVICE_MANAGED=1
            say "LaunchAgent '$LAUNCHD_LABEL' installed and started (starts at login)"
        else
            warn "could not bootstrap the LaunchAgent — load it with: launchctl bootstrap gui/$(id -u) $plist"
            no_service_configured
        fi
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

# No service manager took charge of the server, so the ending has to tell the
# owner how to start it. Never clears a description an earlier branch set (the
# unit exists and its log command is still the useful thing to print).
no_service_configured() {
    SERVER_STARTED=0
    if [ -z "$SERVICE_DESC" ]; then
        SERVICE_DESC="nothing starts it automatically on this system"
    fi
}

# Keep a per-user server alive after the owner logs out. Normal desktop
# sessions are allowed to do this without a password (polkit's
# set-self-linger); when that is refused there is nothing to do but say so, in
# words, once, at the end.
enable_user_linger() {
    LINGER_HINT=""
    need_cmd loginctl || return 0
    linger_user="$(id -un)"
    if loginctl show-user "$linger_user" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
        return 0
    fi
    if loginctl enable-linger "$linger_user" >/dev/null 2>&1; then
        return 0
    fi
    LINGER_HINT="$linger_user"
    return 0
}

setup_service() {
    if [ "${PARACORD_NO_SYSTEMD:-0}" = "1" ] || [ "${PARACORD_NO_SERVICE:-0}" = "1" ]; then
        say "service setup skipped by request"
        no_service_configured
        return 0
    fi
    # macOS reaches launchd here and returns; the systemd branches below are
    # Linux-only and would otherwise all fall through to "run it by hand".
    if [ "$OS_FAMILY" = "macos" ]; then
        if launchd_available; then
            install_launchd_service
        else
            warn "launchctl not available — no service installed"
            no_service_configured
        fi
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
            SERVICE_DESC="systemd service '$SERVICE_NAME' (starts with the computer)"
            SERVICE_LOGS="journalctl -u $SERVICE_NAME -n 50"
            if systemctl is-active --quiet "$SERVICE_NAME"; then
                SERVER_STARTED=1
                SERVICE_MANAGED=1
                say "Service '$SERVICE_NAME' is enabled and running (systemctl status $SERVICE_NAME)"
            else
                warn "service did not report active — inspect with: journalctl -u $SERVICE_NAME -n 50"
            fi
        else
            warn "running as root but systemd is not present — no service installed"
            no_service_configured
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
        SERVICE_DESC="systemd user service '$SERVICE_NAME' (starts when you log in)"
        SERVICE_LOGS="journalctl --user -u $SERVICE_NAME -n 50"
        if systemctl --user is-active --quiet "$SERVICE_NAME"; then
            SERVER_STARTED=1
            SERVICE_MANAGED=1
            say "User service '$SERVICE_NAME' is enabled and running"
            enable_user_linger
        else
            warn "user service did not report active — inspect with: journalctl --user -u $SERVICE_NAME -n 50"
            no_service_configured
        fi
    else
        no_service_configured
    fi
}

# ── Addresses, setup link, browser ───────────────────────────────────────────

# config_value <section> <key> — first value of a key inside a TOML section,
# unquoted, empty when absent. Commented lines never match: the comment is
# stripped first, which leaves nothing for the key pattern to hit.
config_value() {
    [ -f "$CONFIG_PATH" ] || return 0
    awk -v sect="$1" -v key="$2" '
        /^[[:space:]]*\[/ { in_s = ($0 ~ ("^[[:space:]]*\\[" sect "\\]")); next }
        !in_s { next }
        {
            line = $0
            sub(/#.*/, "", line)
            if (line !~ ("^[[:space:]]*" key "[[:space:]]*=")) next
            sub(/^[^=]*=[[:space:]]*/, "", line)
            gsub(/^"|"$/, "", line)
            sub(/[[:space:]]+$/, "", line)
            print line
            exit
        }' "$CONFIG_PATH"
}

# LOCAL_URL is what the owner opens on this machine — always loopback, so it
# resolves and matches the certificate the server generated for itself.
# SHARE_URL is the address other people use: the configured public URL when
# there is one, otherwise the same loopback address.
compute_urls() {
    tls_on="$(config_value tls enabled)"
    tls_port="$(config_value tls port)"
    bind_addr="$(config_value server bind_address)"
    voice_port="$(config_value voice port)"
    public_url="$(config_value server public_url)"

    bind_port="${bind_addr##*:}"
    case "$bind_port" in ''|*[!0-9]*) bind_port="8090" ;; esac
    case "$tls_port"  in ''|*[!0-9]*) tls_port="8443" ;; esac

    if [ "$tls_on" = "false" ]; then
        WEB_SCHEME="http"
        WEB_PORT="$bind_port"
    else
        WEB_SCHEME="https"
        WEB_PORT="$tls_port"
    fi
    case "$voice_port" in ''|*[!0-9]*) voice_port="$WEB_PORT" ;; esac
    VOICE_PORT="$voice_port"
    LOCAL_URL="${WEB_SCHEME}://localhost:${WEB_PORT}"
    if [ -n "$public_url" ]; then
        SHARE_URL="${public_url%/}"
    else
        SHARE_URL="$LOCAL_URL"
    fi
}

# First non-empty line of a file, stripped of surrounding whitespace and CR.
first_line_of() {
    sed -e 's/\r$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' "$1" 2>/dev/null \
        | grep -v '^$' | head -n 1
}

# The server mints the one-time owner token on its first real start, not during
# `init`, and writes it beside the config (mode 0600). Wait for it — but only
# when this run actually started the server and there is a first owner to
# create; otherwise look once and move on.
resolve_claim_link() {
    cfg_dir="$(dirname "$CONFIG_PATH")"
    CLAIM_TOKEN_FILE="$cfg_dir/first-owner-claim.txt"
    CLAIM_LINK_FILE="$cfg_dir/first-owner-claim-link.txt"

    limit=0
    if [ "$IS_UPGRADE" = "0" ] && [ "$SERVER_STARTED" = "1" ]; then
        limit=20
    fi
    waited=0
    while :; do
        if [ -s "$CLAIM_LINK_FILE" ] || [ -s "$CLAIM_TOKEN_FILE" ]; then
            break
        fi
        if [ "$waited" -ge "$limit" ]; then
            break
        fi
        if [ "$waited" = "0" ]; then
            say "Waiting for the server to finish starting..."
        fi
        sleep 1
        waited=$((waited + 1))
    done

    claim_token=""
    if [ -s "$CLAIM_LINK_FILE" ]; then
        published="$(first_line_of "$CLAIM_LINK_FILE")"
        case "$published" in
            *"#claim="*)
                # Use the server's token, but against the loopback address: the
                # server builds its link from the address it shares with other
                # people, which can be a name only they can resolve.
                claim_token="${published##*#claim=}"
                CLAIM_LINK_SOURCE="link file"
                ;;
            ?*)
                CLAIM_LINK="$published"
                CLAIM_LINK_SOURCE="link file (verbatim)"
                ;;
        esac
    fi
    if [ -z "$CLAIM_LINK" ] && [ -z "$claim_token" ] && [ -s "$CLAIM_TOKEN_FILE" ]; then
        claim_token="$(first_line_of "$CLAIM_TOKEN_FILE")"
        CLAIM_LINK_SOURCE="token file"
    fi
    if [ -z "$CLAIM_LINK" ] && [ -n "$claim_token" ]; then
        CLAIM_LINK="${LOCAL_URL}/setup-server#claim=${claim_token}"
    fi
    [ -n "$CLAIM_LINK" ] || CLAIM_LINK_SOURCE=""

    # A token file outlives the claim that spends it, so on an upgrade the file
    # alone cannot say whether setup is still needed. The running server can.
    if [ -n "$CLAIM_LINK" ]; then
        case "$(setup_state)" in
            done) CLAIM_LINK=""; CLAIM_LINK_SOURCE="" ;;
            pending)
                # A server is answering at this address, it still needs its
                # first owner, and the token beside this config is the one that
                # claims it. Whatever started it, it is running.
                SERVER_STARTED=1
                ;;
            *) [ "$IS_UPGRADE" = "0" ] || { CLAIM_LINK=""; CLAIM_LINK_SOURCE=""; } ;;
        esac
    fi
    if [ -n "$CLAIM_LINK" ]; then
        say "Setup link ready (source: $CLAIM_LINK_SOURCE)."
    fi
}

# pending | done | unknown — from the server's own public setup status.
setup_state() {
    body="$TMP_DIR/setup-status.json"
    got=0
    if need_cmd curl; then
        # -k: the first-run certificate is the server's own, and this request
        # never leaves the machine.
        if curl -fsS -k --max-time 4 "$LOCAL_URL/api/v1/setup/status" -o "$body" 2>/dev/null; then
            got=1
        fi
    elif need_cmd wget; then
        if wget -q --no-check-certificate -T 4 -O "$body" "$LOCAL_URL/api/v1/setup/status" 2>/dev/null; then
            got=1
        fi
    fi
    if [ "$got" = "0" ]; then
        say "unknown"
        return 0
    fi
    if grep -q '"setup_required"[[:space:]]*:[[:space:]]*true' "$body"; then
        say "pending"
    elif grep -q '"setup_required"[[:space:]]*:[[:space:]]*false' "$body"; then
        say "done"
    else
        say "unknown"
    fi
}

# Opening a browser is a convenience, never a requirement: every failure path
# falls through to printing the link.
maybe_open_browser() {
    BROWSER_OPENED=0
    [ -n "$CLAIM_LINK" ] || return 0
    [ "${PARACORD_NO_BROWSER:-0}" = "1" ] && return 0

    if [ "$OS_FAMILY" = "macos" ]; then
        need_cmd open || return 0
        if open "$CLAIM_LINK" >/dev/null 2>&1; then
            BROWSER_OPENED=1
        fi
        return 0
    fi

    # Linux: a graphical session has to exist to open into.
    if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
        return 0
    fi
    need_cmd xdg-open || return 0

    if [ "$(id -u)" = "0" ]; then
        # root has no desktop of its own. Hand the link to the account that ran
        # sudo when that is unambiguous; otherwise print it and let them click.
        [ -n "${SUDO_USER:-}" ] || return 0
        [ "$SUDO_USER" != "root" ] || return 0
        need_cmd runuser || return 0
        sudo_uid="$(id -u "$SUDO_USER" 2>/dev/null || true)"
        [ -n "$sudo_uid" ] || return 0
        runuser -u "$SUDO_USER" -- env \
            DISPLAY="${DISPLAY:-}" \
            WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-}" \
            XDG_RUNTIME_DIR="/run/user/$sudo_uid" \
            xdg-open "$CLAIM_LINK" >/dev/null 2>&1 &
        BROWSER_OPENED=1
        return 0
    fi

    # Backgrounded: some desktop handlers do not return until the browser does,
    # and an install must not hang waiting for a window to be closed.
    xdg-open "$CLAIM_LINK" >/dev/null 2>&1 &
    BROWSER_OPENED=1
    return 0
}

# ── Ending ───────────────────────────────────────────────────────────────────

resolve_version_label() {
    if [ -n "${VERSION_NUM:-}" ]; then
        VERSION_LABEL="$VERSION_NUM"
        return 0
    fi
    # Offline installs have no release tag; the archive name usually carries one.
    base="$(basename "${ARCHIVE_PATH:-}")"
    case "$base" in
        "paracord-server-${PLATFORM}-"*.tar.gz)
            base="${base%.tar.gz}"
            VERSION_LABEL="${base#paracord-server-"${PLATFORM}"-}"
            ;;
        *) VERSION_LABEL="" ;;
    esac
}

print_details() {
    dim_start
    say ""
    say "Details"
    if [ -n "$VERSION_LABEL" ]; then
        say "  Version:   $VERSION_LABEL"
    fi
    say "  Installed: $INSTALL_DIR"
    say "  Settings:  $CONFIG_PATH"
    say "  Your data: $DATA_DIR"
    if [ -n "$SERVICE_LOGS" ]; then
        say "  Service:   $SERVICE_DESC"
        say "  Logs:      $SERVICE_LOGS"
    else
        say "  Service:   ${SERVICE_DESC:-nothing starts it automatically}; start it with"
        say "             cd \"$INSTALL_DIR\" && ./paracord-server"
    fi
    if [ "$WEB_PORT" = "$VOICE_PORT" ]; then
        say "  Ports:     $WEB_PORT (TCP for the app, UDP for voice and video)"
    else
        say "  Ports:     $WEB_PORT TCP (app), $VOICE_PORT UDP (voice and video)"
    fi
    say "  Address:   $SHARE_URL"
    if [ "$(id -u)" != "0" ] && [ -z "${PARACORD_INSTALL_DIR:-}" ]; then
        say "  Installed for you only. For every account on this computer, run the"
        say "  same command with sudo."
    fi
    dim_end
}

print_summary() {
    say ""
    if [ "$IS_UPGRADE" = "1" ]; then
        # "and restarted" only when something actually restarted it.
        upgrade_tail=" and restarted."
        if [ "$SERVICE_MANAGED" = "0" ]; then
            upgrade_tail="."
        fi
        if [ -n "$VERSION_LABEL" ]; then
            say "Paracord was updated to ${VERSION_LABEL}${upgrade_tail}"
        else
            say "Paracord was updated${upgrade_tail}"
        fi
        say "Your accounts, messages and settings are kept."
        if [ "$SERVER_STARTED" = "0" ]; then
            say "Start it again with:  cd \"$INSTALL_DIR\" && ./paracord-server"
        fi
        if [ -n "$CLAIM_LINK" ]; then
            say ""
            say "This server still has no owner. Finish setting it up:"
            say "     $CLAIM_LINK"
        fi
        print_details
        return 0
    fi

    if [ "$SERVER_STARTED" = "1" ]; then
        say "Paracord is installed and running."
    else
        say "Paracord is installed."
    fi
    say ""

    if [ -n "$CLAIM_LINK" ]; then
        if [ "$BROWSER_OPENED" = "1" ]; then
            say "1. Finish setting up (opens in your browser):"
        else
            say "1. Finish setting up - open this link in your browser:"
        fi
        say "     $CLAIM_LINK"
        say "   Your browser may show a one-time security warning because the server made its own"
        say "   certificate - choose Advanced, then Continue. (The desktop app never shows this.)"
    elif [ "$SERVER_STARTED" = "1" ]; then
        say "1. Finish setting up - open this link in your browser:"
        say "     $LOCAL_URL/setup-server"
        say "   It asks for the one-time setup code your server printed when it started."
        if [ -f "$CLAIM_TOKEN_FILE" ]; then
            say "   The code is also saved here:"
            say "     $CLAIM_TOKEN_FILE"
        fi
    else
        say "1. Start the server:"
        say "     cd \"$INSTALL_DIR\" && ./paracord-server"
        say "   It prints a link that finishes setting up - open that link in your browser."
    fi
    say "2. Then invite friends from inside the app - every channel has an Invite button."
    say ""
    say "Friends outside your home network: the server tries to open the door on your"
    say "router by itself. If someone can't connect, see $DOCS_URL"
    if [ -n "$LINGER_HINT" ]; then
        say ""
        say "One thing this computer would not let the installer do: keep the server running"
        say "while you are logged out. To allow it, run: loginctl enable-linger $LINGER_HINT"
    fi
    say ""
    say "To update later, run this same command again. Your data is kept."
    print_details
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
    TMP_DIR="$(mktemp -d 2>/dev/null || mktemp -d -t paracord-install)"
    trap 'rm -rf "$TMP_DIR"' EXIT

    say "Paracord server installer"
    # Said once, up front, in the words that matter to whoever is watching: what
    # this install covers and when the server will be running.
    if [ "$(id -u)" = "0" ]; then
        say "Installing for everyone on this computer. The server will start with the computer."
    else
        say "Installing just for you (no administrator password needed)."
        say "The server will start when you log in."
    fi
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
    resolve_version_label
    compute_urls
    resolve_claim_link
    maybe_open_browser
    print_summary
}

main "$@"
