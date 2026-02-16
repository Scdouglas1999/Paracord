# ============================================================================
# Paracord — Multi-stage Docker build
# ============================================================================
# Usage:
#   docker build -t paracord .
#   docker run -p 8090:8090 -v paracord-data:/data paracord
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

# Copy the built client dist into the expected location
COPY --from=client-builder /src/client/dist/ client/dist/

# Build the server with embedded UI
RUN cargo build --release --bin paracord-server

# ---------- Stage 3: Minimal runtime ----------
FROM debian:bookworm-slim AS runtime

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libsqlite3-0 \
    && rm -rf /var/lib/apt/lists/*

# Create a non-root user
RUN groupadd -r paracord && useradd -r -g paracord -m paracord

WORKDIR /app

COPY --from=server-builder /src/target/release/paracord-server /app/paracord-server

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

EXPOSE 8090

VOLUME ["/data"]

CMD ["/app/paracord-server", "--config", "/data/paracord.toml"]
