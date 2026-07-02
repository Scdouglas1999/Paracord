#!/usr/bin/env bash
set -euo pipefail

OUTPUT_DIR="${1:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$OUTPUT_DIR"

DB_URL="${PARACORD_DATABASE_URL:-postgres://paracord:paracord@localhost:5432/paracord}"
OUT_FILE="$OUTPUT_DIR/paracord-${TIMESTAMP}.dump"

redact_db_url() {
  local url="$1"
  if [[ "$url" =~ ^([^:/?#]+://[^:/?#@]+):([^@]*)@(.*)$ ]]; then
    printf '%s:***@%s\n' "${BASH_REMATCH[1]}" "${BASH_REMATCH[3]}"
  else
    printf '%s\n' "$url"
  fi
}

echo "Creating backup at $OUT_FILE"
echo "Database: $(redact_db_url "$DB_URL")"
pg_dump --format=custom --no-owner --no-privileges --dbname="$DB_URL" --file="$OUT_FILE"
echo "Backup complete"
