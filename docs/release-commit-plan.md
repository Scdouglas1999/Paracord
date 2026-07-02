# Release Commit Plan

The current worktree is too large for one public commit. `git status --short` reported hundreds of changed/untracked paths during the May 2026 audit. Split the release candidate into reviewable commits in this order after owner decisions are made.

## Owner Decisions Before Staging

- Decide whether internal audit/design files should be public: `ANALYSIS_REPORT.md`, `VALIDATION_REPORT.md`, `VALIDATION_MASTER.md`, `PLAN_EXECUTION_LEDGER.md`, `RELEASE_READINESS_AUDIT.md`, `RELEASE_WORKTREE_CLASSIFICATION.md`, and design docs.
- Decide whether `AGENTS.md` belongs in the public repository.
- Decide whether `packages/paracord-bot-sdk/package.json` should remain MIT while the root project uses the repository `LICENSE`.
- Decide whether `third_party/scap` should be vendored in full, replaced by a fork/submodule, trimmed to source/license files only, or deferred. The current tree includes local warning-only cleanup in the vendored crate.
- Approve RustSec waiver rationale in `docs/release-risk-waivers.md`.

## Proposed Commit Sequence

1. Security and abuse hardening
   - Auth/session/rate-limit/CORS/security-header changes.
   - Federation SSRF/private-network protection, file-token hardening, replay checks.
   - WebSocket and media token/session validation.
   - Optional S3-compatible storage credential hardening so ambient AWS credential-chain discovery is opt-in.
   - Public `docs/security-release-gate.md` P0 gate so CI does not depend on ignored private security working notes.
   - Related server tests and security smoke scripts.

2. Database schema and migration parity
   - New SQLite migrations under `crates/paracord-db/migrations/`.
   - Matching PostgreSQL migrations under `crates/paracord-db/migrations_pg/`.
   - New database modules, migration sanity tooling, `scripts/release_sqlite_upgrade_from_tag_smoke.py`, and `scripts/release_postgres_upgrade_from_tag_smoke.py` for synthetic SQLite/PostgreSQL upgrade validation from the latest released tag.
   - SQLite/PostgreSQL query-plan smoke coverage for hot-path indexes, including bot reviews, scheduled workers, message pagination/search, slowmode, attachment cleanup, bot installs, and forum thread listing.
   - `.gitattributes` migration/script/workflow line-ending guard plus `scripts/check_migration_line_endings.py` so SQLx checksums, release helper scripts, Linux shell shebangs, and GitHub workflow YAML remain stable across Windows/Linux/macOS checkouts.
   - Dedicated PostgreSQL migration, query-plan, and API route smoke coverage through `PARACORD_TEST_POSTGRES_URL`.

3. Product API features
   - Scheduled messages/events, scheduled-message composer UX, stickers, custom emoji picker and upload-management coverage, composer/shared attachment upload coverage, onboarding settings/gate UI coverage, economy/progression UI coverage, template-gallery and create-server template UI coverage, invite-page coverage, moderation template UI coverage, bot store review/authorization, public card, and developer metrics UI coverage, stage/forum, anonymous/disappearing message UI coverage, slowmode feedback UI coverage, DMs/E2EE, webhooks.
   - API route tests for these features.

4. Native media and codec work
   - `crates/paracord-transport`, `crates/paracord-relay`, `crates/paracord-codec`, `crates/paracord-media`, `crates/paracord-media-dev`.
   - `client/src-tauri/src/native_media/*`, screen/audio capture, VPX/libvpx config.
   - Client media libraries, voice store, screen-share UI, stream viewer.
   - Vendored `third_party/scap` strategy and warning-cleanup patch, if approved for this release.

5. Client UI, accessibility, and responsive behavior
   - Layout/sidebar/channel list/settings/admin/page changes, including the real-browser admin settings, backup create/download/restore/delete, and security-event filter smoke.
   - Accessible names, modal behavior, keyboard and mobile e2e coverage.
   - DM/group-DM user-visible error-state tests, one-to-one DM E2EE send coverage, account recovery phrase flow tests, account unlock cooldown/reconnect tests, moderation-template apply UI coverage, LoginPage password-reset/MFA/public-key token-rotation flow tests, UserPanel admin shortcut coverage, GuildHub scheme-less server URL coverage, UserSettings MFA setup/disable tests, and CommandPalette focus/dialog coverage.
   - Custom CSS sanitizer coverage for UI-hiding/interception and unsafe at-rule/script vectors.
   - CSS token/layout/component split and contrast audit tooling.

6. Bot SDK
   - `packages/paracord-bot-sdk/**`.
   - SDK tests, examples, and package metadata after the license decision.

7. Packaging, CI, and release automation
   - `.github/workflows/*`, `Dockerfile`, `docker-compose.yml`, installer config, lockfiles.
   - Release validation scripts, embedded UI smoke, checklist-status verifier, and updater/signing gates.

8. Public docs and release notes
   - `README.md`, `RELEASE_NOTES.md`, `SELF_HOSTING_DEPLOYMENT_GUIDE.md`, `docs/api-contracts.md`, `docs/docker-setup.md`, `docs/known-limitations.md`, `docs/release-validation.md`.
   - Screenshot inventory and final screenshot replacements.

9. Internal audit artifacts, if intentionally public
   - Release audit/checklist/classification files and design reports.
   - Otherwise keep them local or move them outside the public release branch before final tagging.

## Final Staging Check

Before the first commit:

```bash
git status --short
git diff --check
git ls-files --others --exclude-standard
```

Before every commit:

```bash
git diff --cached --stat
git diff --cached --check
```

Before the final tag:

```bash
cargo fmt --all -- --check
cargo check --workspace
cargo check --workspace --no-default-features
cargo check -p paracord-media --features s3
cargo check -p paracord-server --features s3
cargo test -p paracord-server config::tests -- --quiet
cargo test -p paracord-media --features s3 -- s3_ --quiet
cargo clippy -p paracord-server --features s3 -- -D warnings
cargo clippy --workspace -- -D warnings
cargo test --workspace --all-targets
cargo test -p paracord-desktop --lib -- --quiet
python scripts/check_release_version.py
python scripts/ci_migration_sanity.py
python scripts/release_sqlite_upgrade_from_tag_smoke.py v0.9.0
python scripts/release_sqlite_query_plan_smoke.py
python scripts/security_gate_check.py
python scripts/validate_release_checklist_status.py
python scripts/check_migration_line_endings.py
python scripts/check_python_syntax.py
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security-audit.yml .github/workflows/security-dast-fuzz.yml
docker run --rm -v "${PWD}:/work" -w /work bash:5 bash -n scripts/setup.sh scripts/backup-db.sh scripts/restore-db.sh
(cd client && npm ci)
(cd client && npm run typecheck)
(cd client && npm audit --audit-level=moderate)
(cd client && npm run test:a11y:static)
(cd client && npm run test:unit)
(cd client && npm run test:e2e)
(cd client && npm run test:contrast)
(cd client && npm run build)
(cd packages/paracord-bot-sdk && npm ci)
(cd packages/paracord-bot-sdk && npm audit --audit-level=moderate)
(cd packages/paracord-bot-sdk && npm run build)
(cd packages/paracord-bot-sdk && npm test)
(cd packages/paracord-bot-sdk && node ./tests-node/sdk.test.mjs)
(cd packages/paracord-bot-sdk && node --check ./tests-node/sdk.test.mjs)
(cd packages/paracord-bot-sdk && npm pack --dry-run)
cargo build --release --bin paracord-server
python scripts/release_embedded_ui_smoke.py --port 18142
node client/scripts/release-real-ui-smoke.mjs --port 18152
python scripts/release_security_smoke.py --port 18109 --fuzz-iterations 120
python scripts/release_log_leak_smoke.py --port 18111
python scripts/release_load_smoke.py --port 18110 --messages 5000 --max-page-seconds 2.0 --voice-participants 4
python scripts/release_restart_smoke.py --port 18116
python scripts/release_graceful_shutdown_smoke.py --port 18126
python scripts/release_gateway_resume_smoke.py --port 18139
python scripts/release_ws_pre_auth_capacity_smoke.py --port 18127 --max-connections 3 --connections 5
node --check client/scripts/a11y-static-audit.mjs
node --check client/scripts/capture-release-screenshots.mjs
node --check client/scripts/contrast-audit.mjs
node --check client/scripts/release-real-ui-smoke.mjs
git diff --check
```

When `PARACORD_TEST_POSTGRES_URL` is available, also run:

```bash
cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture
python scripts/release_postgres_upgrade_from_tag_smoke.py v0.9.0
cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture
cargo test -p paracord-api --test postgres_route_smoke -- --nocapture
```

Do not tag until CI, clean-clone, clean-install, PostgreSQL, and upgrade validation gaps in `RELEASE_CHECKLIST_STATUS.md` are closed or explicitly deferred for a non-public release.
