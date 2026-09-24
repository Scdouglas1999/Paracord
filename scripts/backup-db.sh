#!/usr/bin/env bash
# Point-in-time copy of the Paracord DATABASE ONLY.
#
# This is the small, scriptable half of backup. It does not capture uploads,
# media, TLS material or the federation signing key — for a complete archive
# use the Backups panel in the admin area (or the server's scheduled backups),
# and recover it with `paracord-server restore-backup` / scripts/restore-db.sh.
#
# Usage:  scripts/backup-db.sh [output-dir]
# Reads the database URL from PARACORD_DATABASE_URL and picks the right tool
# from its scheme. Paracord's default deployment is SQLite, so a Postgres-only
# script here would fail on most installs.
set -euo pipefail

OUTPUT_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

DB_URL="${PARACORD_DATABASE_URL:-}"
if [ -z "$DB_URL" ]; then
  echo "PARACORD_DATABASE_URL is not set." >&2
  echo "Set it to the url from [database] in your paracord.toml, for example:" >&2
  echo "  PARACORD_DATABASE_URL='sqlite:///var/lib/paracord/paracord.db' $0 $OUTPUT_DIR" >&2
  exit 2
fi

redact_db_url() {
  local url="$1"
  if [[ "$url" =~ ^([^:/?#]+://[^:/?#@]+):([^@]*)@(.*)$ ]]; then
    printf '%s:***@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
  else
    printf '%s\n' "$url"
  fi
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 && return 0
  echo "$1 is not installed, so this $2 database cannot be dumped." >&2
  echo "Install it, or take a full archive from the admin area's Backups panel instead." >&2
  exit 3
}

case "$DB_URL" in
  sqlite://*|sqlite:*|file:*)
    # Strip the scheme and any ?mode=rwc style query string to get the path.
    db_path="${DB_URL#sqlite://}"
    db_path="${db_path#sqlite:}"
    db_path="${db_path#file:}"
    db_path="${db_path%%\?*}"
    if [ ! -f "$db_path" ]; then
      echo "No SQLite database at '$db_path' (from $(redact_db_url "$DB_URL"))." >&2
      exit 4
    fi
    require_tool sqlite3 SQLite
    OUT_FILE="$OUTPUT_DIR/paracord-${TIMESTAMP}.sqlite"
    echo "Creating backup at $OUT_FILE"
    echo "Database: $(redact_db_url "$DB_URL")"
    # `.backup` is the online backup API: consistent against a running server,
    # unlike copying the file out from under an open WAL.
    sqlite3 "$db_path" ".backup '$OUT_FILE'"
    ;;
  postgres://*|postgresql://*)
    require_tool pg_dump PostgreSQL
    OUT_FILE="$OUTPUT_DIR/paracord-${TIMESTAMP}.dump"
    echo "Creating backup at $OUT_FILE"
    echo "Database: $(redact_db_url "$DB_URL")"
    pg_dump --format=custom --no-owner --no-privileges --dbname="$DB_URL" --file="$OUT_FILE"
    ;;
  *)
    echo "Unrecognized database url scheme in $(redact_db_url "$DB_URL")." >&2
    echo "Paracord supports sqlite:// and postgres:// urls." >&2
    exit 5
    ;;
esac

echo "Backup complete"
