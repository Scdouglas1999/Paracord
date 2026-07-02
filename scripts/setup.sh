#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Paracord Development Setup ==="
echo

MISSING_REQUIRED=0

check_required_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        local ver
        ver=$("$1" --version 2>/dev/null | head -n1 || echo "found")
        echo "  [OK] $1 ($ver)"
    else
        echo "  [MISSING] $1 - $2"
        MISSING_REQUIRED=1
    fi
}

check_optional_cmd() {
    if command -v "$1" >/dev/null 2>&1; then
        local ver
        ver=$("$1" --version 2>/dev/null | head -n1 || echo "found")
        echo "  [OK] $1 ($ver)"
    else
        echo "  [OPTIONAL] $1 - $2"
    fi
}

echo "Step 1: Prerequisites"
check_required_cmd cargo "Install Rust from https://rustup.rs/"
check_required_cmd node "Install Node.js 22+ from https://nodejs.org/"
check_required_cmd npm "Comes with Node.js"
check_optional_cmd docker "Install Docker if you want the containerized stack"
check_optional_cmd psql "Install PostgreSQL client tools if you use PostgreSQL"
echo

if [ "$MISSING_REQUIRED" -eq 1 ]; then
    echo "ERROR: Missing required tools. Install the missing tools and re-run this script."
    exit 1
fi

echo "Step 2: Configuration"
CONFIG_FILE="$PROJECT_ROOT/config/paracord.toml"
EXAMPLE_FILE="$PROJECT_ROOT/config/paracord.example.toml"

if [ -f "$CONFIG_FILE" ]; then
    echo "  Config already exists at config/paracord.toml"
elif [ -f "$EXAMPLE_FILE" ]; then
    cp "$EXAMPLE_FILE" "$CONFIG_FILE"
    echo "  Copied config/paracord.example.toml -> config/paracord.toml"
    echo "  Edit config/paracord.toml before production use."
else
    echo "  WARNING: config/paracord.example.toml not found; skipping config copy"
fi
echo

echo "Step 3: Data directories"
mkdir -p "$PROJECT_ROOT/data/uploads"
mkdir -p "$PROJECT_ROOT/data/files"
mkdir -p "$PROJECT_ROOT/data/backups"
echo "  Ensured data/uploads, data/files, and data/backups exist"
echo

echo "Step 4: Database"
echo "  Default local development uses SQLite at ./data/paracord.db."
echo "  SQLx applies migrations when the server starts."
echo "  For PostgreSQL, set PARACORD_DATABASE_URL and use the server's migration path."
echo

echo "Step 5: Client dependencies and build"
if [ -f "$PROJECT_ROOT/client/package-lock.json" ]; then
    (cd "$PROJECT_ROOT/client" && npm ci && npm run build)
elif [ -f "$PROJECT_ROOT/client/package.json" ]; then
    (cd "$PROJECT_ROOT/client" && npm install && npm run build)
else
    echo "  ERROR: client/package.json not found"
    exit 1
fi
echo "  Client dependencies installed and production assets built"
echo

echo "Step 6: Rust workspace check"
(cd "$PROJECT_ROOT" && cargo check --workspace)
echo "  Rust workspace checked successfully"
echo

echo "=== Setup Complete ==="
echo
echo "To run the server:"
echo "  cargo run --bin paracord-server"
echo
echo "To run the client dev server in another terminal:"
echo "  cd client && npm run dev"
echo
echo "To run the documented Docker stack:"
echo "  docker compose up -d --build"
echo
