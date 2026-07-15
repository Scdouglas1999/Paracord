# ============================================================================
# Paracord — Multi-stage Docker build
# ============================================================================
# Usage:
#   docker build -t paracord .
#   # Publish the plaintext HTTP port to the host loopback only; front it with a
#   # TLS-terminating reverse proxy (or set PARACORD_TLS_ENABLED=true) before
#   # exposing it to a LAN/WAN, otherwise auth tokens travel in cleartext.
#   docker run -p 127.0.0.1:8090:8090 -v paracord-data:/data paracord
# ============================================================================

# ---------- Stage 1: Build the client web UI ----------
FROM node:22-bookworm-slim AS client-builder
WORKDIR /src/client
COPY client/package.json client/package-lock.json* ./
RUN npm ci
COPY client/ ./
RUN npm run build

# ---------- Stage 2: Build the Rust server ----------
FROM rust:1.91-bookworm AS server-builder
WORKDIR /src

# Copy workspace manifests first for dependency caching
COPY Cargo.toml Cargo.lock* ./
COPY crates/ crates/
COPY client/src-tauri/ client/src-tauri/
COPY third_party/ third_party/

# Copy the built client dist into the expected location
COPY --from=client-builder /src/client/dist/ client/dist/

# Build the server with embedded UI
RUN cargo build --release --bin paracord-server

# ---------- Stage 3: Minimal runtime ----------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libsqlite3-0 \
    wget \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -r paracord && useradd -r -g paracord -m paracord

WORKDIR /app

COPY --from=server-builder /src/target/release/paracord-server /app/paracord-server
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

# Create default data directories
RUN mkdir -p /data/uploads /data/files /data/certs /data/backups \
    && chown -R paracord:paracord /data /app

USER paracord

# Default environment for Docker
ENV PARACORD_BIND_ADDRESS=0.0.0.0:8090
ENV PARACORD_DATABASE_URL=sqlite:///data/paracord.db?mode=rwc
ENV PARACORD_STORAGE_PATH=/data/uploads
ENV PARACORD_MEDIA_STORAGE_PATH=/data/files
ENV PARACORD_BACKUP_DIR=/data/backups
# TLS terminates at a reverse proxy by default, so the container itself serves
# plaintext HTTP on 8090. NEVER publish 8090 beyond the host loopback / a
# trusted proxy in this mode (see the docker run example above and
# docker-compose.yml), or set PARACORD_TLS_ENABLED=true to serve HTTPS directly.
ENV PARACORD_TLS_ENABLED=false
# Native QUIC/WebTransport media is the default voice path (no LiveKit needed).
ENV PARACORD_VOICE_NATIVE_MEDIA=true

# TCP HTTP(S) API/gateway and UDP native media (raw QUIC + browser WebTransport).
EXPOSE 8090
EXPOSE 8443/udp

# Report container health from the HTTP /health endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD wget -qO- http://localhost:8090/health || exit 1

VOLUME ["/data"]

# The entrypoint only ensures /data exists, then execs the CMD. The server owns
# first-run secret generation, so no secret needs to be injected from outside.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["/app/paracord-server", "--config", "/data/paracord.toml"]
