#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 3 ]; then
  echo "Usage: $0 <original-config.toml> <paracord-backup.tar.gz> <new-recovery-directory> [restore-backup options...]"
  echo "PostgreSQL: add --postgres-url-env PARACORD_RECOVERY_DATABASE_URL (a fresh isolated database)."
  echo "This prepares a verified recovery; it never replaces the running database."
  exit 1
fi

recovery_config="$1"
recovery_archive="$2"
recovery_output="$3"
shift 3
exec "${PARACORD_SERVER_BINARY:-paracord-server}" --config "$recovery_config" restore-backup \
  --archive "$recovery_archive" --output-dir "$recovery_output" "$@"
