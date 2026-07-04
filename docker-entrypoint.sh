#!/bin/sh
# Paracord container entrypoint.
#
# Zero-config by design: the server itself generates and persists every secret
# (JWT signing key, self-signed media/TLS certs) into /data/paracord.toml on the
# first run, then reuses that file on every subsequent start. This script does
# NOT create or regenerate any secret — doing so would break idempotency across
# restarts. It only makes sure the data directories exist (named volumes inherit
# them from the image, but bind-mounted hosts may start empty) and then hands off
# to the server, which owns first-run config creation.
set -eu

# Ensure the persistent data layout exists before the server starts. Safe to run
# repeatedly; existing directories and the persisted config are left untouched.
for dir in /data /data/uploads /data/files /data/certs /data/backups; do
    [ -d "$dir" ] || mkdir -p "$dir"
done

# Hand off to the CMD (paracord-server --config /data/paracord.toml). The server
# creates /data/paracord.toml with a freshly generated jwt_secret on first run
# and reuses the same file — and therefore the same secret — on later starts.
exec "$@"
