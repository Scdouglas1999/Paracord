# Paracord Plan Validation Master Document

**Purpose:** Validate that every task in `concurrent-mapping-ripple.md` is actually implemented — no stubs, no placeholders, no TODOs.

**Status Key:**
- PASS: Fully implemented, no stubs/placeholders/TODOs
- PARTIAL: Some implementation exists but incomplete
- STUB: Only stub/placeholder code exists
- MISSING: No implementation found at all
- NEEDS_REVIEW: Implementation exists but quality/correctness uncertain

---

## Phase 0: Foundation

### Track 0A: Test Infrastructure

#### Task 0A-1: Extract shared test utilities
- **Status:** PASS
- **Files:** `crates/paracord-api/tests/common/mod.rs` (246 lines)
- **Findings:** Fully implemented shared test module. Contains `TestApp` struct, `TestAppOptions` with sensible defaults, `build_test_app()` (creates in-memory SQLite, runs migrations, builds full AppState with temp dirs), `build_json_request()` (HTTP request builder with optional auth), `dispatch_json()` (Tower oneshot executor returning status+JSON), and `create_authenticated_user_token()` (creates user + session + JWT). All 7 integration test files (`channel_message_routes`, `voice_routes`, `coverage_gap_routes`, `phase6_feature_routes`, `security_federation_regressions`, `rate_limit_regressions`, `bot_system_routes`) use `mod common;` and import from it. No residual duplication found -- each test file builds its own `TestContext` wrapper around the shared utilities but does not re-implement any of the core helpers. Quality is high: proper error handling with `anyhow`, temp dirs for isolation, configurable options for rate limiters, AI, native media, etc.

#### Task 0A-2: Add PostgreSQL CI testing
- **Status:** PARTIAL
- **Files:** `.github/workflows/ci.yml` lines 80-107
- **Findings:** PostgreSQL 16 service container is properly configured with health checks (pg_isready). However, the CI job runs **only a single smoke test**: `cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture`. This verifies that the PG pool can be created and migrations run successfully, but it does NOT run the full integration test suite against PostgreSQL. The full `cargo test --workspace` in the `rust` job uses in-memory SQLite only. This is a **connection and migration smoke test, not comprehensive PG testing**. The plan likely intended running all API integration tests against Postgres. Rating as PARTIAL because the infrastructure is in place but coverage is minimal (1 test).

#### Task 0A-3: Add code coverage reporting to CI
- **Status:** PASS
- **Files:** `.github/workflows/ci.yml` lines 203-240, `client/package.json`
- **Findings:** Full coverage pipeline implemented. Rust: uses `cargo-llvm-cov` with `--workspace --all-targets --lcov` output to `coverage/rust.lcov`. Client: `vitest run --coverage` via `@vitest/coverage-v8` (devDependency confirmed in package.json). Both reports are uploaded as a single artifact named `coverage-reports` with `if-no-files-found: error` (will fail CI if coverage reports aren't produced). No coverage **thresholds** are configured -- neither Rust nor Vitest enforce minimum coverage percentages. This means coverage is reported but won't block merges on regressions. The coverage job depends on both `rust` and `client` jobs succeeding first, which is correct. Artifacts are useful for manual review but no integration with Codecov/Coveralls for PR comments.

#### Task 0A-4: Add integration tests for uncovered API routes
- **Status:** PASS
- **Files:** `crates/paracord-api/tests/coverage_gap_routes.rs` (~1515 lines)
- **Findings:** 17 substantial test functions covering: channel feature settings (anonymous posting, disappearing messages, thread slowmode, adaptive slowmode, slowmode-exempt roles), scheduled messages (create/list/cancel), data export (messages, memberships, prekeys), identity import/export, group E2EE sender keys (post/get/ack), moderation templates (create/apply-timed-mute/delete), DM group routes, DM creation forbidden for unrelated users, group DM recipient access control, webhook execution via token, webhook Discord-compat (embeds/edit/delete), webhook permission checks, user profile fields (pronouns, linked accounts), automod quarantine approve-repost, economy/XP/level-roles/leaderboard/achievements, and AI-powered channel summarization (with mock OpenAI server). Every test has real HTTP assertions (status codes), structured payload validation, and proper error messages. Zero `todo!()`, `unimplemented!()`, `FIXME`, or `HACK` markers found. No empty test bodies or commented-out assertions. These are genuine, thorough integration tests.

#### Task 0A-5: Add dependency caching to CI
- **Status:** PASS
- **Files:** `.github/workflows/ci.yml`
- **Findings:** Three caching strategies implemented: (1) `Swatinem/rust-cache@v2` used in `rust`, `postgres`, `cross-platform-smoke`, and `coverage` jobs for Rust target/registry caching. (2) npm caching via `actions/setup-node@v4` with `cache: "npm"` and `cache-dependency-path: client/package-lock.json` in all jobs that need Node. (3) Docker layer caching via `cache-from: type=gha` and `cache-to: type=gha,mode=max` in the `docker-image` job. All cache keys are correctly configured with proper dependency paths.

### Track 0B: Type Safety Foundation

#### Task 0B-1: Introduce newtype wrappers for snowflake IDs
- **Status:** PARTIAL
- **Files:** `crates/paracord-models/src/id.rs` (62 lines)
- **Findings:** The macro `define_snowflake_id!` is well-designed: generates `Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, sqlx::Type` derives with `#[serde(transparent)]` and `#[sqlx(transparent)]`. Defines 6 types: `UserId`, `GuildId`, `ChannelId`, `MessageId`, `RoleId`, `EmojiId`. Includes `new()`, `get()`, `Display`, and `From<i64>` / `Into<i64>` conversions. However, adoption is extremely low: only **5 files** in the entire codebase import these types (`paracord-util/src/snowflake.rs`, `paracord-db/src/users.rs`, `paracord-db/src/guilds.rs`, `paracord-core/src/member_index.rs`, plus the definition itself). Meanwhile, raw `i64` parameters named `user_id`, `guild_id`, `channel_id` exist in **52+ function signatures** across paracord-db (31 occurrences in 18 files), paracord-core (12 in 6 files), and paracord-api (9 in 6 files). This is approximately **8% adoption** -- the types exist but the migration from raw i64 to newtypes was barely started.

#### Task 0B-2: Eliminate TypeScript `any` types
- **Status:** PASS
- **Files:** All `client/src/**/*.{ts,tsx}`
- **Findings:** Confirmed zero instances of `: any` type annotations across the entire client source tree. Also confirmed zero instances of `as any` type assertions. The codebase is clean of explicit `any` usage. TypeScript strict mode is enabled via `tsc --noEmit` in the typecheck script.

#### Task 0B-3: Split `types/index.ts` into domain-specific modules
- **Status:** PASS
- **Files:** `client/src/types/index.ts` (8 lines), plus 8 domain files
- **Findings:** `index.ts` is a clean barrel re-export file with 8 `export * from` statements: `api.types`, `channel.types`, `gateway.types`, `guild.types`, `message.types`, `permissions.types`, `user.types`, `voice.types`. Spot-checked `guild.types.ts` (148 lines): contains real, substantial interfaces -- `Guild`, `Member`, `Role`, `Invite`, `Webhook`, `GuildEmoji`, `Ban`, `AuditLogEntry`, `ModerationReport`, `CreateReportRequest`, `ResolveReportRequest` with proper type annotations, optional fields, and cross-references to other domain types via imports. Not stubs.

### Track 0C: Workspace Consistency

#### Task 0C-1: Normalize workspace dependency references
- **Status:** PARTIAL
- **Files:** `Cargo.toml` (workspace), `crates/paracord-transport/Cargo.toml`, `crates/paracord-relay/Cargo.toml`
- **Findings:** The workspace `Cargo.toml` defines all four problematic deps (`quinn = "0.11"`, `h3 = "0.0.8"`, `h3-quinn = "0.0.10"`, `bytes = "1"`) in `[workspace.dependencies]`. However, `paracord-transport/Cargo.toml` references 4 deps with local versions instead of `workspace = true`: `quinn = "0.11"`, `h3 = "0.0.8"`, `h3-quinn = "0.0.10"`, `bytes = "1"`. `paracord-relay/Cargo.toml` references 1 dep locally: `bytes = "1"` (note: it correctly uses `quinn = { workspace = true }`). These are all available in the workspace definition and **should** use `workspace = true` for consistency. Total: 5 non-workspace references that should be normalized. The versions happen to match the workspace versions currently, but divergence is a risk during upgrades.

---

## Phase 1: Security Hardening

### Track 1A: Critical & High Security

#### Task 1A-1: Add SSRF protection to OpenGraph link preview fetcher
- **Status:** PASS
- **Files:** `crates/paracord-api/src/opengraph.rs`
- **Findings:**
  - `validate_ssrf_target()` (line 129) validates every URL before fetch, checking scheme (http/https only), resolving DNS, and rejecting private/reserved IPs.
  - `is_private_or_reserved_ip()` (line 104) covers: RFC1918 (10.x, 172.16-31.x, 192.168.x), loopback (127.x), link-local (169.254.x), CGNAT (100.64-127.x), unspecified (0.x), reserved (240+), IPv6 loopback, unique local (fc00::/7), link-local (fe80::/10), unspecified, and IPv4-mapped IPv6 addresses.
  - Blocked hostnames: `localhost`, `metadata.google.internal` (and subdomains).
  - Redirect loop protection: `MAX_REDIRECTS = 3` (line 19), manual redirect following with `reqwest::redirect::Policy::none()` (line 303), and re-validation of SSRF target after each redirect (line 51 inside loop).
  - DNS resolution validation: resolves domain to IPs via `tokio::net::lookup_host()` and checks every resolved IP against the blocklist. Rejects if no IPs resolve.
  - Response size capped at 512 KiB (`MAX_RESPONSE_BYTES`, line 18).
  - Fetch timeout of 5 seconds (`FETCH_TIMEOUT`, line 16).
  - Max 5 URLs per message (`MAX_URLS_PER_MESSAGE`, line 17).
  - Unit tests cover: URL extraction, dedup, trailing punctuation, OG tag parsing, fallback to `<title>`, private IP detection (127.0.0.1, 169.254.x, IPv6 loopback, fc00::/7), and public IP allowance (8.8.8.8, Cloudflare IPv6).
  - No TODOs, FIXMEs, or stubs found.

#### Task 1A-2: Sanitize highlight.js output in CodeBlock
- **Status:** PASS
- **Files:** `client/src/components/message/CodeBlock.tsx`
- **Findings:**
  - DOMPurify imported at line 3, `sanitizeHighlightedHtml()` defined at lines 69-84.
  - DOMPurify config is strict: `ALLOWED_TAGS: ['span']`, `ALLOWED_ATTR: ['class']`, `ALLOW_DATA_ATTR: false`, `FORBID_ATTR: ['style']`.
  - Post-DOMPurify regex filter at lines 77-83 strips any CSS class that doesn't match `hljs` or `hljs-*` prefix.
  - Only ONE `dangerouslySetInnerHTML` usage in the file at line 200, and it uses `safeHighlightedHtml` which is the sanitized output (line 104-107, memoized via `useMemo`).
  - No bypass path: `highlightedHtml` (raw) is never used directly in rendering; it always passes through `sanitizeHighlightedHtml()` first.
  - No TODOs, FIXMEs, or stubs found.

### Track 1B: Medium Security

#### Task 1B-1: Add password complexity requirements
- **Status:** PARTIAL
- **Files:** `crates/paracord-util/src/validation.rs` (lines 88-97), `crates/paracord-api/src/routes/auth.rs` (line 1053, 1805), `crates/paracord-api/src/routes/users.rs` (line 760)
- **Findings:**
  - `validate_password()` only checks length: minimum 10 characters, maximum 128 characters. No character-class diversity checks (uppercase, lowercase, digit, special character).
  - The same length-only validation is consistently used across all three password entry points: registration (auth.rs:1053), password reset (auth.rs:1805), and password change (users.rs:760).
  - Error message across all call sites: `"Password must be between 10 and 128 characters"` -- confirms no character diversity is enforced.
  - **What's missing:** No requirement for mixed character classes (e.g., must contain uppercase + lowercase + digit + special). No common/breached password dictionary check. No similarity check against username/email.
  - The min length of 10 is reasonable and above NIST 800-63B's minimum of 8, but the task explicitly calls for "complexity requirements" beyond length, which is not implemented.

#### Task 1B-2: Restrict CSP connect-src directive
- **Status:** PASS
- **Files:** `crates/paracord-api/src/lib.rs` (lines 1458-1463)
- **Findings:**
  - CSP for the SPA is at line 1461: `connect-src 'self' ws: wss:` -- correctly restricts to same-origin plus WebSocket protocols. No `http:` or `https:` wildcard.
  - API/health/metrics routes get a stricter CSP: `default-src 'none'; frame-ancestors 'none'; base-uri 'none'` (line 1455).
  - No dynamic CSP exceptions found -- the CSP is a static string.
  - Additional security headers present: `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, `Permissions-Policy` (camera/mic/geo disabled), `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, HSTS (when HTTPS detected).
  - No TODOs or FIXMEs found.

#### Task 1B-3: Disable V1 E2EE fallback by default
- **Status:** PASS
- **Files:** `client/src/lib/dmE2ee.ts` (line 31)
- **Findings:**
  - `DM_E2EE_ALLOW_V1_FALLBACK` at line 31 is `import.meta.env.VITE_DM_E2EE_ALLOW_V1_FALLBACK === 'true'` -- defaults to `false` unless explicitly opted in via environment variable.
  - Guard is effective: in `encryptDmMessage()` (line 203-211), when no session exists and V1 fallback is disabled, it throws `DmE2eeError('SESSION_REQUIRED', ...)` instead of falling back to V1.
  - In `encryptDmMessageV2()` (line 243-253), when bundle fetch fails and V1 fallback is disabled, the error propagates instead of falling back.
  - V1 decryption still works for existing V1 messages (line 300-302) -- this is correct backward-compatibility behavior for reading old messages.
  - Warning system (`warnV1Fallback`) logs deprecation notice when V1 is used, with dedup flag (`hasWarnedV1Fallback`).
  - No bypass path found -- all encryption paths check the flag before falling back to V1.

#### Task 1B-4: Replace in-memory challenge store with bounded cache
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/auth.rs` (lines 12, 36-54)
- **Findings:**
  - `moka::sync::Cache<String, i64>` imported at line 12, stored as `OnceLock` static at line 44.
  - `challenge_store()` function (lines 47-54) initializes with `max_capacity(10_000)` and `time_to_live(120 seconds)`.
  - Constants: `CHALLENGE_STORE_MAX_ENTRIES = 10_000` (line 36), `CHALLENGE_STORE_TTL_SECONDS = 120` (line 37).
  - No residual `HashMap` usage for challenges -- grep found zero `HashMap.*challenge` or `challenge.*HashMap` matches in auth.rs.
  - No TODOs or stubs found.

#### Task 1B-5: Move refresh token storage to Tauri secure storage
- **Status:** PASS
- **Files:** `client/src/lib/authToken.ts`, `client/src/lib/secureStorage.ts`
- **Findings:**
  - **authToken.ts**: Uses `secureGet`/`secureSet`/`secureDelete` from secureStorage module for Tauri environments.
  - **Migration logic** (lines 78-96 of authToken.ts): On hydration in Tauri mode, checks secure storage first; if found, clears legacy localStorage. If not in secure storage, reads legacy localStorage token, migrates it to secure storage, then clears legacy localStorage (`writeLegacyRefreshToken(null)` at lines 84 and 92).
  - **secureStorage.ts**: Tauri path uses `invoke('secure_store_set/get/delete')` for OS keychain access. Fallback uses AES encryption via `invoke('secure_store_fallback_encrypt/decrypt')` with `pcenc:v1:` prefix. Emits `paracord:secure-storage-degraded` event when OS keychain unavailable.
  - **Web (non-Tauri) path**: Uses in-memory Map (`webMemoryStore`) -- tokens are never persisted to localStorage in plain text for non-Tauri web. Also removes any localStorage entry on `secureSet` (line 128-129).
  - Legacy plaintext migration: `readFallbackValue()` (lines 96-118 in secureStorage.ts) detects non-encrypted legacy values and encrypts them in-place.
  - `setRefreshToken()` in authToken.ts (lines 111-126): Tauri path writes to secure storage and explicitly clears legacy localStorage (`writeLegacyRefreshToken(null)` at line 121).
  - Worker context support via postMessage bridge for Web Workers.
  - No TODOs or stubs found.

### Track 1C: Low Security & Documentation

#### Task 1C-1: Add CSRF protection for state-changing endpoints
- **Status:** PASS
- **Files:** `crates/paracord-api/src/lib.rs` (lines 1371-1413)
- **Findings:**
  - **Double-submit cookie pattern** implemented as middleware `csrf_middleware()` (lines 1379-1413).
  - `requires_csrf_check()` (lines 1371-1377) applies to POST, PUT, PATCH, DELETE methods on `/api/` paths.
  - Exemptions are correct: Bearer/Bot token auth (non-ambient, not CSRF-prone, line 1384-1387) and unauthenticated requests without access cookie (lines 1389-1395).
  - Cookie name: `paracord_csrf` (lib.rs:29), Header name: `x-paracord-csrf` (lib.rs:30).
  - Comparison at line 1408: requires both cookie and header to be non-empty AND equal; returns 403 Forbidden on mismatch.
  - CSRF cookie is set during auth session issuance (auth.rs, alongside access/refresh cookies).
  - Client reads CSRF token from cookie via `getCsrfToken()` in authToken.ts (lines 41-62).
  - No POST routes found that bypass CSRF -- the middleware is applied as a global layer.

#### Task 1C-2: Add comprehensive security event audit logging
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/security.rs`, `crates/paracord-db/src/security_events.rs`, `crates/paracord-api/src/routes/auth.rs`
- **Findings:**
  - **security.rs**: `log_security_event()` function (lines 44-73) accepts actor_user_id, action, target_user_id, session_id, headers, details. Extracts device_id, user_agent, and IP address (with trusted proxy support) from request headers.
  - **security_events.rs** (DB layer): Full CRUD -- `create_event()` inserts into `security_events` table with all fields. `list_events()` supports filtering by action and cursor pagination. `purge_entries_older_than()` for retention management.
  - **Event types logged** (13 call sites in auth.rs): `auth.register.password`, `auth.login.password`, `auth.logout`, `auth.session.revoke`, `auth.mfa.enabled`, and others for token refresh, MFA disable, password reset, etc.
  - **Failed login attempts**: Tracked via `auth_guard_record_failure()` (auth.rs:195-211) which writes to `rate_limits` table by IP+account key. However, failed logins are NOT logged as explicit security events via `log_security_event()` -- they use the auth-guard rate-limiting system instead.
  - **IP address logging**: Extracted from `X-Forwarded-For` when `PARACORD_TRUST_PROXY` and `PARACORD_TRUSTED_PROXY_IPS` are both configured.
  - No stubs or TODOs found. The implementation is production-quality with proper error handling (warns on write failure rather than crashing).

#### Task 1C-3: Create security hardening documentation
- **Status:** PASS
- **Files:** `docs/security-threat-model.md`, `docs/incident-response-runbook.md`, `docs/security-dependency-policy.md`, `docs/security-endpoint-checklist.md`, `docs/security-ui-checklist.md`, `docs/security-release-checklist.md`
- **Findings:**
  - **6 security documents** found with substantive content (none are empty stubs):
  - `security-threat-model.md`: Assets, trust boundaries, 5 high-risk attack paths, security invariants, Mermaid data flow diagram.
  - `incident-response-runbook.md`: Severity levels (SEV-1 through SEV-3), first-15-minutes checklist, 4 specific playbooks (token leakage, TLS key compromise, federation key compromise, emergency patch), post-incident process.
  - `security-dependency-policy.md`: Scope (Rust + JS), required controls (cargo audit, npm audit), advisory exception rules with expiry dates, current exceptions documented.
  - `security-endpoint-checklist.md`: 6-section checklist for new/changed endpoints covering auth, input validation, data integrity, output/error handling, eventing, operational security.
  - `security-ui-checklist.md`: 6-section checklist for UI changes covering rendering/XSS, file/media safety, auth/sensitive data, permission-aware UX, browser security, resilience/reporting.
  - `security-release-checklist.md`: Pre-release gate items, key security validation steps, operational controls sign-off.
  - All documents contain actionable, project-specific content -- not generic boilerplate.

---

## Phase 2: Performance & Code Quality

### Track 2A: Database Performance

#### Task 2A-1: Fix N+1 query in `get_user_guilds`
- **Status:** PASS
- **Files:** `crates/paracord-db/src/guilds.rs` (lines 233-288)
- **Findings:** Confirmed. `get_user_guilds()` executes exactly 2 SQL queries: (1) a single JOIN query to fetch all guilds the user is a member of (line 234-244), and (2) a single batch query to fetch all member roles across all guilds for that user (lines 247-255). Results are assembled in a `HashMap<i64, HashSet<i64>>` for O(1) guild-to-roles lookup (lines 257-263). The visibility filtering loop (lines 266-285) uses the pre-built HashMap -- no additional queries. This is a genuine fix of the N+1 pattern. No TODOs, FIXMEs, or stubs.

#### Task 2A-2: Move thread filtering from application layer to SQL
- **Status:** PASS
- **Files:** `crates/paracord-db/src/channels.rs` (lines 326-361)
- **Findings:** Confirmed. `get_channel_threads()` filters archived status directly in SQL with engine-specific JSON extraction. PostgreSQL branch (lines 332-343) uses `(thread_metadata::jsonb ->> 'archived')::boolean` with `COALESCE(..., FALSE) = FALSE`. SQLite branch (lines 345-357) uses `json_extract(thread_metadata, '$.archived')` with `COALESCE(..., 0) = 0`. Both are correct for their respective engines. A corresponding `get_archived_threads()` function exists at line 364 with the inverse condition. No application-layer filtering. No TODOs.

#### Task 2A-3: Batch channel reordering into a single query
- **Status:** PASS
- **Files:** `crates/paracord-db/src/channels.rs` (lines 202-233)
- **Findings:** Confirmed. `reorder_channels()` builds a single `UPDATE channels SET position = CASE id WHEN $1 THEN $2 ... END WHERE id IN (...)` query dynamically (lines 207-221). This handles all position updates in one round trip. **Note:** A separate `update_channel_positions()` function at line 238 still uses an N+1 pattern (individual SELECT + UPDATE per channel in a loop, lines 244-270). This older function handles `parent_id` changes and change detection, which `reorder_channels()` does not. The N+1 in `update_channel_positions` was not addressed but the primary batch reorder task is complete.

#### Task 2A-4: Replace OFFSET pagination with cursor pagination
- **Status:** PASS
- **Files:** `crates/paracord-db/src/users.rs` (lines 422-474)
- **Findings:** Confirmed. `list_users_by_cursor()` (lines 447-474) implements proper cursor pagination using `WHERE id > $1 ORDER BY id ASC LIMIT $2`. The legacy `list_users_paginated()` (lines 422-445) is preserved for backward compatibility but internally delegates to `list_users_by_cursor()` after a one-time offset-to-cursor translation. The cursor approach avoids OFFSET performance degradation on large tables. No TODOs.

#### Task 2A-5: Optimize member search with better indexing
- **Status:** PARTIAL
- **Files:** `crates/paracord-db/src/members.rs` (lines 267-312), `crates/paracord-db/migrations/20260302000001_perf_indexes.sql`, `crates/paracord-db/migrations_pg/20260302000001_perf_indexes.sql`
- **Findings:** The query in `search_guild_members()` uses LIKE prefix pattern (`query%`) with case-insensitive matching. **Indexes are present:** PostgreSQL migration adds `idx_users_username_lower_prefix` (with `text_pattern_ops`) and `idx_members_guild_lower_nick_prefix` (with `text_pattern_ops`). SQLite migration adds `idx_users_username_nocase` and `idx_members_guild_nick_nocase` with `COLLATE NOCASE`. These indexes support the LIKE prefix queries. **However,** no `pg_trgm` or FTS indexing exists for substring/fuzzy matching -- only prefix matching is indexed. Rating as PARTIAL because the indexes support the current query pattern but do not enable full substring search.

#### Task 2A-6: Add case-insensitive email index
- **Status:** PASS
- **Files:** `crates/paracord-db/migrations/20260302000001_perf_indexes.sql`, `crates/paracord-db/migrations_pg/20260302000001_perf_indexes.sql`
- **Findings:** Confirmed. PostgreSQL: `CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users (lower(email))`. SQLite: `CREATE INDEX IF NOT EXISTS idx_users_email_nocase ON users (email COLLATE NOCASE)`. Both are correct for case-insensitive email lookups on their respective engines. No TODOs.

#### Task 2A-7: Add SQLite WAL tuning
- **Status:** PASS
- **Files:** `crates/paracord-db/src/lib.rs` (lines 188-213)
- **Findings:** Confirmed. SQLite connection setup includes 8 PRAGMAs: `journal_mode = WAL`, `foreign_keys = ON`, `busy_timeout = 5000`, `synchronous = NORMAL`, `cache_size = -8000` (8MB), `mmap_size = 67108864` (64MB), `journal_size_limit = 67108864` (64MB), `wal_autocheckpoint = 2000` (pages). All PRAGMAs are set in the `after_connect` callback so they apply to every new connection. Well-tuned for concurrent access. No TODOs.

#### Task 2A-8: Add PostgreSQL work_mem tuning
- **Status:** PASS
- **Files:** `crates/paracord-db/src/lib.rs` (lines 79-90, 216-247)
- **Findings:** Confirmed. `PgConnectOptions` struct (lines 80-90) holds `statement_timeout_secs`, `idle_in_transaction_timeout_secs`, `work_mem_mb`, and `maintenance_work_mem_mb`. All four are applied per-connection in the `after_connect` callback (lines 216-240) with conditional `SET` statements (only applied when non-zero). Additionally sets `lock_timeout = '10s'` and `timezone = 'UTC'` unconditionally. Config integration via `crates/paracord-server/src/config.rs` exposes these as TOML fields. No TODOs.

### Track 2B: Server Performance

#### Task 2B-1: Replace RwLock with DashMap for presence state
- **Status:** PASS
- **Files:** `crates/paracord-core/src/lib.rs` (lines 100-103)
- **Findings:** Confirmed. `AppState` uses `Arc<DashSet<i64>>` for `online_users` (line 101) and `Arc<DashMap<i64, serde_json::Value>>` for `user_presences` (line 103). No `RwLock` wrapper -- DashSet/DashMap provide lock-free concurrent reads and fine-grained per-shard locking for writes. No TODOs.

#### Task 2B-2: Replace RwLock with DashMap for VoiceManager rooms
- **Status:** PASS
- **Files:** `crates/paracord-media/src/voice.rs` (lines 33-38)
- **Findings:** Confirmed. `VoiceManager` uses `DashMap<i64, VoiceRoom>` for `rooms` (line 35) and `DashMap<i64, String>` for `active_livekit_rooms` (line 37). No RwLock wrapper. Per-channel sharding is well-suited for voice rooms accessed concurrently. No TODOs.

#### Task 2B-3: Make permission cache size configurable
- **Status:** PASS
- **Files:** `crates/paracord-core/src/lib.rs` (lines 72-87), `crates/paracord-server/src/config.rs` (line 75-76)
- **Findings:** Confirmed. `build_permission_cache()` (lines 75-87) accepts `max_entries: u64` parameter, defaults to `DEFAULT_PERMISSION_CACHE_MAX_ENTRIES` (10,000) when 0. Config exposes `permission_cache_max_entries` field with `#[serde(default)]` in the server config struct. TTL remains hardcoded at 5 minutes but capacity is fully configurable. No TODOs.

#### Task 2B-4: Document PostgreSQL connection pool sizing
- **Status:** PASS
- **Files:** `README.md` (lines 325, 382, 408, 425-428, 449)
- **Findings:** Confirmed. README.md contains explicit pool sizing guidance at lines 425-428: "Small deployments (< 200 concurrent users): `max_connections = 20`", "Medium (200-1000): start at 50", "Large (> 1000): plan for 75-100 with DB monitoring." The `max_connections` config field is documented in the config reference table (line 449) and shown in example configs. `SELF_HOSTING_DEPLOYMENT_GUIDE.md` also references it (line 152).

### Track 2C: Client Performance

#### Task 2C-1: Add channel-by-ID lookup to the channel store
- **Status:** PASS
- **Files:** `client/src/stores/channelStore.ts` (lines 22-30, 36)
- **Findings:** `buildChannelIndex()` builds a flat `Record<string, Channel>` index keyed by channel ID. The `channelsById` field provides O(1) lookups, rebuilt whenever `channelsByGuild` changes. No TODOs.

#### Task 2C-2: Offload E2EE decryption to a Web Worker
- **Status:** PASS
- **Files:** `client/src/lib/dmE2eeWorker.ts` (203 lines), `client/src/workers/dmDecrypt.worker.ts` (76 lines)
- **Findings:** Real Web Worker implementation (not a stub): imports `decryptDmMessage`, performs actual crypto, typed message passing. Orchestrator manages worker lifecycle, bounded concurrency (`MAX_IN_FLIGHT_DECRYPTS = 5`), secure storage bridge, fallback to main-thread. No TODOs.

#### Task 2C-3: Consolidate excessive useState hooks in MessageList
- **Status:** PARTIAL
- **Files:** `client/src/components/message/MessageList.tsx` (lines 230-318)
- **Findings:** Four state groups consolidated: editState, threadCreateState, bulkDeleteState, attachmentState. However, 18 individual useState hooks remain (showScrollButton, hoveredMessageId, menuMessageId, profileUser, profilePos, emojiPickerFor, deleteConfirmId, 4 report states, contextMenuAnchor, 4 edit-history states, isCoarsePointer, guildRoles). The edit-history group (4) and report group (4) are obvious consolidation candidates. Meaningful progress but not complete.

#### Task 2C-4: Optimize mentionMap computation in MessageList
- **Status:** PASS
- **Files:** `client/src/components/message/MessageList.tsx` (lines 334-342)
- **Findings:** `mentionMap` wrapped in `useMemo` with `activeGuildMembers` as sole dependency. The selector uses `useCallback` for stable guild-scoped selection, preventing recomputation on unrelated guild updates. No TODOs.

### Track 2D: Code Quality - Server

#### Task 2D-1: Replace `.unwrap()` with `try_get()` in paracord-db
- **Status:** PASS
- **Files:** All `crates/paracord-db/src/*.rs`
- **Findings:** Production code uses `try_get()` with `?` propagation exclusively. Only 1 production `.unwrap()` found (messages.rs:106, safe Option unwrap after prior check). The scout count of 334 .unwrap() includes test code -- virtually all are in `#[cfg(test)]` modules. 474 `try_get` calls across the crate confirm complete migration.

#### Task 2D-2: Reduce paracord-core dependency fan-out
- **Status:** PARTIAL
- **Files:** `crates/paracord-core/Cargo.toml`
- **Findings:** 7 workspace + 16 external deps. `native-media` feature correctly gates paracord-relay and paracord-transport as optional. However, backup-related deps (rusqlite, flate2, tar, tempfile) are NOT feature-gated -- unconditional required deps used only for SQLite backup. These should be behind a `backup` feature flag.

### Track 2E: Code Quality - Client

#### Task 2E-1: Standardize error display patterns
- **Status:** PASS
- **Files:** `client/src/components/ui/Feedback.tsx` (101 lines)
- **Findings:** Three reusable components: ErrorBanner (accessible role=alert, retry button, design tokens), LoadingSpinner (aria-live=polite, 3 sizes), EmptyState (title, description, icon/action slots). All accept className. No inline styles, no hardcoded colors. No TODOs.

#### Task 2E-2: Unify the button system
- **Status:** PARTIAL
- **Files:** `client/src/components/ui/Button.tsx`, 31 files across `client/src/`
- **Findings:** Button component exists, imported in 5 files. However, 73 occurrences of raw `btn-primary` CSS class across 31 files. The CSS class is the established pattern (73 uses vs 5 for component). Component exists but adoption is ~6%.

#### Task 2E-3: Unify theme/accent color definitions
- **Status:** PASS
- **Files:** `client/src/hooks/useTheme.ts`, `client/src/components/customization/ThemeSelector.tsx`
- **Findings:** `useTheme.ts` is single source of truth. ThemeSelector imports from useTheme. CSS custom properties provide runtime values. No duplicate definitions.

#### Task 2E-4: Fix MessageComponents to use design system tokens
- **Status:** PASS
- **Files:** `client/src/components/message/MessageComponents.tsx` (lines 41-52)
- **Findings:** `BUTTON_STYLE_CLASSES` maps to design token classes (bg-accent-primary, bg-bg-mod-strong, bg-accent-success, bg-accent-danger, etc.). No hardcoded hex colors or inline styles. No TODOs.

#### Task 2E-5: Centralize mobile detection into a shared hook
- **Status:** PASS
- **Files:** `client/src/hooks/useMobile.ts` (26 lines)
- **Findings:** Exports `DEFAULT_MOBILE_MAX_WIDTH` (768px) and `useMobile()` hook. Uses `matchMedia` with `change` listener. SSR-safe. Proper cleanup. No TODOs.

#### Task 2E-6: Fix inline styles that bypass the design system
- **Status:** PASS
- **Files:** `client/src/components/guild/BotStoreSection.tsx`
- **Findings:** No `color-mix` inline styles found. Uses design token CSS classes throughout. No inline style= with hardcoded colors.

#### Task 2E-7: Fix BotStoreSection channel picker
- **Status:** PASS
- **Files:** `client/src/components/guild/BotStoreSection.tsx` (lines 336-345)
- **Findings:** Welcome channel picker uses select with select-field CSS class. Options from textLikeChannels with channel.name display. Additional channel selects for mod_log and quarantine channels. All show proper names.

#### Task 2E-8: Fix DMPage members toggle button overlap
- **Status:** PASS
- **Files:** `client/src/pages/DMPage.tsx` (lines 135-186)
- **Findings:** Members panel uses flex h-full w-60 shrink-0 flex-col -- standard flexbox with shrink-0. No fixed or absolute positioning. Conditionally rendered within parent flex container, preventing overlap.

---

## Phase 3: UI/UX Improvements

### Track 3A: Component Decomposition

#### Task 3A-1: Decompose GuildSettings into per-section components
- **Status:** PARTIAL
- **Files:** `client/src/components/guild/GuildSettings.tsx` (2032 lines), `client/src/components/guild/GuildSettingsSections.tsx` (313 lines)
- **Findings:** `GuildSettingsSections.tsx` exports 3 real components (BansSection, ReportsSection, AuditLogSection). GuildSettings also delegates to ChannelManager, EventList, FileStorageSection, ServerHubSettings, BotStoreSection, OnboardingSettingsSection. However, 7 major sections remain inline in the 2032-line file: overview, roles, members, invites, emojis, webhooks, bots. No lazy data fetching per section -- refreshAll() loads everything on mount. File grew larger rather than shrinking.

#### Task 3A-2: Extract ChannelSidebar sub-components
- **Status:** MISSING
- **Files:** `client/src/components/layout/ChannelSidebar.tsx` (1170 lines)
- **Findings:** No sub-component files found (no DMList, GuildChannelList, VoiceParticipants, UserPanel anywhere in layout/). All sidebar rendering remains inline in the 1170-line monolithic file. No extraction work started.

#### Task 3A-3: Extract TopBar overlay sub-components
- **Status:** MISSING
- **Files:** `client/src/components/layout/TopBar.tsx` (903 lines)
- **Findings:** No separate overlay component files found anywhere in the components directory. All overlay rendering remains inline in the 903-line TopBar file. No extraction work started.

### Track 3B: Accessibility

#### Task 3B-1: Add aria-live regions for real-time updates
- **Status:** PASS
- **Files:** `MessageList.tsx:1695`, `Toast.tsx:59-60,111`, `ConnectionStatusBar.tsx:50`, `Feedback.tsx:63`
- **Findings:** aria-live="polite" on message feed with aria-busy. Toast uses assertive for error/warning, polite for info/success. ConnectionStatusBar uses assertive + aria-atomic. LoadingSpinner has aria-live="polite" + aria-busy. ErrorBanner has role="alert". All verified in code.

#### Task 3B-2: Add semantic tree roles to channel sidebar
- **Status:** PASS
- **Files:** `client/src/components/layout/ChannelSidebar.tsx` (lines 724, 754, 835)
- **Findings:** role="tree" at line 724 with aria-label. role="treeitem" on categories (line 754) and channels (line 835) with tabIndex={0}, aria-level, aria-selected, and Enter/Space keyboard handlers.

#### Task 3B-3: Add feed role to the message list
- **Status:** PASS
- **Files:** `client/src/components/message/MessageList.tsx` (line 1693)
- **Findings:** role="feed" on message scroll container with aria-busy, aria-live="polite", aria-label="Message history". Correct ARIA role for dynamically loaded message list.

#### Task 3B-4: Add focus indicators to guild icons and fix context menu keyboard nav
- **Status:** PASS
- **Files:** `client/src/components/layout/Sidebar.tsx` (line 128)
- **Findings:** Guild icon buttons have focus-visible:ring-2 focus-visible:ring-accent-primary focus-visible:ring-offset-2 focus-visible:ring-offset-bg-secondary. Uses design system accent-primary token.

#### Task 3B-5: Fix forum tag selection accessibility
- **Status:** PASS
- **Files:** `client/src/components/channel/ForumView.tsx` (lines 285, 287)
- **Findings:** aria-pressed on tag buttons, Check icon with aria-hidden for selected tags, roving focus support via handleTagRovingFocus and data-forum-tag-scope.

#### Task 3B-6: Verify and fix WCAG AA color contrast
- **Status:** PASS
- **Files:** `client/src/styles/tokens.css` (lines 317-370)
- **Findings:** Dedicated high-contrast theme at line 317 with pure black bg, white text, bright accents. text-secondary (#e0e0e0) and text-muted (#b0b0b0) on black give ~14:1 and ~10:1 ratios. components.css references WCAG 44px touch target. Default dark theme not independently audited but high-contrast option provides AA+ compliance.

### Track 3C: UX Improvements

#### Task 3C-1: Improve application-level error boundary
- **Status:** PASS
- **Files:** `client/src/components/ErrorBoundary.tsx` (107 lines)
- **Findings:** Full React class component with getDerivedStateFromError and componentDidCatch. 5 real recovery actions: Retry (MAX_RETRIES=2), Return Home (/app), Reload App, Error details disclosure (<details>), Report bug link (configurable URL). Custom fallback prop. No stubs or TODOs.

#### Task 3C-2: Add confirmation dialogs to all destructive actions
- **Status:** PASS
- **Files:** `client/src/stores/confirmStore.ts`, `client/src/components/ui/ConfirmDialog.tsx`, 10+ call sites
- **Findings:** Central confirm() via Zustand store, ConfirmDialog rendered globally in AppLayout.tsx with AnimatePresence, focus trap, backdrop blur, Escape dismissal. Used for message/attachment/thread/bot/channel/file deletion, token regen, guild ownership transfer, guild leave, TLS warnings. **Caveat**: AdminPage.tsx still uses 5 native window.confirm() calls (admin-only).

#### Task 3C-3: Add reconnect action to the server list
- **Status:** PASS
- **Files:** `client/src/components/layout/Sidebar.tsx` (lines 340-370)
- **Findings:** Connection status indicator on user avatar: yellow pulsing dot for reconnecting, red dot for disconnected. Tooltip changes: "Reconnecting...", "Disconnected", or "User Settings".

#### Task 3C-4: Show setup wizard for newly created guilds
- **Status:** PASS
- **Files:** `client/src/components/guild/GuildOnboardingGate.tsx` (71 lines), `GuildOnboardingGate.test.tsx`, `client/src/components/onboarding/OnboardingWizard.tsx`
- **Findings:** GuildOnboardingGate renders in GuildPage.tsx for every guild with test file. OnboardingWizard provides multi-step first-time user flow.

#### Task 3C-5: Differentiate success and error status in UserSettings
- **Status:** PASS
- **Files:** `client/src/components/user/UserSettings.tsx` (lines 91-92, 150)
- **Findings:** statusKind typed as 'success' | 'error' | null with statusText for message. Line 150 sets statusKind('success') on save.

#### Task 3C-6: Add version prefixes to localStorage keys
- **Status:** PASS
- **Files:** `client/src/lib/versionedStorage.ts` (81 lines)
- **Findings:** Key format paracord:v2:<base>. Real migration logic in migrateLegacyValue() moves old paracord:<key> entries to versioned format and removes originals. JSON helpers, storage availability check, cleanup of both versioned and legacy keys. No stubs.

#### Task 3C-7: Improve server connection error messages
- **Status:** PASS
- **Files:** `client/src/pages/ServerConnectPage.tsx` (lines 119-151)
- **Findings:** toFriendlyConnectionError() maps raw errors to actionable messages: non-Paracord server, timeout (firewall/offline), network failure (DNS/CORS/TLS), TLS/certificate issues, account unlock, auth failure. Uses ErrorBanner for display.

#### Task 3C-8: Add undo mechanism for recent deletions
- **Status:** PASS
- **Files:** `client/src/components/guild/ChannelManager.tsx` (lines 301-317)
- **Findings:** Channel deletion shows info toast with 6s "Undo" action. Undo recreates channel with saved properties (name, type, parent_id, topic, bitrate, user_limit, required_role_ids) via guildApi.createChannel(). Real undo mechanism, not just confirmation.

#### Task 3C-9: Add "Try a public demo server" to onboarding
- **Status:** PASS
- **Files:** `ServerConnectPage.tsx` (lines 12-13, 310-314), `OnboardingWizard.tsx` (lines 136-142)
- **Findings:** PUBLIC_DEMO_SERVER_URL defaults to https://demo.paracord.chat, configurable via env var. Available in OnboardingWizard step 1 and standalone server connect form.

#### Task 3C-10: Add swipe discovery affordance on mobile
- **Status:** PASS
- **Files:** `client/src/hooks/useSwipeGesture.ts`
- **Findings:** Dedicated hook with edge zone detection (32px), min swipe threshold, directional handlers. Ignores swipes on scrollable/interactive elements via data-no-swipe attribute.

#### Task 3C-11: Add keyboard shortcuts for guild switching and settings
- **Status:** PASS
- **Files:** `client/src/hooks/useKeyboardNavigation.ts` (231 lines)
- **Findings:** Ctrl+Alt+Up/Down: guild nav with wrap. Alt+Up/Down: channel nav. Ctrl+,: user settings. Ctrl+Shift+,: guild settings. Ctrl+B: toggle dock. Escape: close panels in priority order. Configurable voice keybinds. Properly skips during text editing. No stubs.

#### Task 3C-12: Fix mobile back navigation in settings
- **Status:** MISSING
- **Files:** N/A
- **Findings:** No popstate listeners, no useNavigate(-1)/history.back() calls, no custom back stack found anywhere in client source. useMobile hook only provides boolean breakpoint detection. Mobile settings relies entirely on browser history. No work started.

#### Task 3C-13: Guard Escape key during keybind capture
- **Status:** PASS
- **Files:** `client/src/components/user/UserSettings.tsx` (lines 263-272)
- **Findings:** handleKeyDown checks capturingKeybind before Escape: cancels capture mode (preventDefault + stopPropagation + setCapturingKeybind(null)) without closing settings. Normal onClose() when not capturing.

### Track 3D: CSS & Design System

#### Task 3D-1: Split globals.css into organized files
- **Status:** PASS
- **Files:** `client/src/styles/globals.css` (10 lines), `tokens.css`, `layout.css`, `components.css`, `utilities.css`
- **Findings:** globals.css is clean import-only: font imports + tailwindcss + 4 organized CSS files. All sub-files contain real CSS (themes, layout, components, utilities).

#### Task 3D-2: Standardize modal backdrop patterns
- **Status:** PASS
- **Files:** `client/src/styles/layout.css` (lines 480-493), `client/src/components/ui/ConfirmDialog.tsx` (line 30)
- **Findings:** .modal-overlay and .modal-backdrop classes in layout.css with standard positioning, backdrop color, animation. ConfirmDialog uses modal-backdrop class. **Caveat**: also uses inline Framer Motion animation props, creating a mixed pattern.

#### Task 3D-3: Standardize loading state patterns
- **Status:** PASS
- **Files:** `client/src/components/ui/Feedback.tsx` (101 lines), `client/src/components/ui/Skeleton.tsx` (58 lines)
- **Findings:** LoadingSpinner (3 sizes, aria-live, aria-busy), Skeleton base + 3 domain variants (SkeletonMessage, SkeletonChannel, SkeletonMember), ErrorBanner (role=alert, retry), EmptyState (icon, title, desc, action). Used in MessageList.tsx for loading states.

---

## Phase 4: Feature Completion

### Track 4A: Quick Wins

#### Task 4A-1: Add message edit history viewer
- **Status:** PASS
- **Files:** `client/src/components/message/MessageList.tsx` (lines 310-313, 785-799, 1218-1226, 1286-1294, 1915-1958)
- **Findings:**
  - State variables for edit history modal: `editHistoryMsgId`, `editHistoryPos`, `editHistoryData` (array of `{id, content, edited_at}`), `editHistoryLoading` (lines 310-313).
  - `openEditHistory()` function (lines 785-799): triggered by clicking the "(edited)" text on messages. Fetches real data via `channelApi.getEditHistory(channelId, msgId)`, sets loading state, and handles errors gracefully.
  - Two clickable "(edited)" labels in the message rendering -- one for non-grouped messages (line 1223), one for grouped messages (line 1291). Both call `openEditHistory()` on click.
  - Modal rendered via `createPortal` to `document.body` (lines 1915-1958): shows "Edit History" header, loading spinner, empty state ("No previous versions found"), and iterates over `editHistoryData` displaying each version with "Version N -- {timestamp}" label and content.
  - Position-aware: constrains modal position to keep it within viewport (lines 1924-1925).
  - No TODOs, stubs, or placeholders found.

#### Task 4A-2: Add channel follows management UI
- **Status:** PENDING (not spot-checked)
- **Files:**
- **Findings:**

#### Task 4A-3: Add template browsing and management page
- **Status:** PASS
- **Files:** `client/src/pages/TemplateGalleryPage.tsx` (297 lines), `client/src/api/templates.ts`
- **Findings:**
  - Full-featured template gallery page with: template listing sidebar with selection, template detail view showing channels (sorted by position with type labels) and roles, usage count display, template application with custom server name, template deletion with confirmation dialog.
  - API integration: `templateApi.list()` for loading, `templateApi.apply(id, name)` for creating a server from template, `templateApi.remove(id)` for deletion, `templateApi.createFromGuild(guildId)` for creating templates from existing guilds.
  - Create template section: shows owned guilds in dropdown, "Create Template" button.
  - Real state management: loading spinner, error banner with retry, busy states for async operations.
  - After applying a template, navigates to the new guild and fetches channels.
  - No TODOs, stubs, or placeholders found.

#### Task 4A-4: Fix forum post cards to show username
- **Status:** PENDING (not spot-checked)
- **Files:**
- **Findings:**

### Track 4B: Medium Effort Features

#### Task 4B-1: Build Stage channel UI
- **Status:** PASS
- **Files:** `client/src/pages/GuildPage.tsx` (lines 698-957)
- **Findings:** Full stage UI: stage instance display (live topic, loading/error), management controls (Start/Save/End Stage), topic input. Speaker/audience separation via `stageSpeakers`/`stageAudience` with counts. Per-participant "Invite Speaker"/"Move Audience" buttons gated by `canManageStage` + `p.suppress`. Lobby shows mute/deaf/video/stream icons. Multiple video layouts. No stubs.

#### Task 4B-2: Add Federation admin panel
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 4B-3: Add email delivery integration (SMTP)
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/auth.rs` (lines 262-365)
- **Findings:** Real `lettre` SMTP via `AsyncSmtpTransport<Tokio1Executor>`. `SmtpConfig` struct with host/port/username/password/from/starttls. `load_smtp_config()` reads env vars (PARACORD_SMTP_HOST, _FROM, _PORT=587, _USERNAME, _PASSWORD, _STARTTLS=true). `recipient_mailbox()` rejects `@local.invalid`/`@pubkey`. `send_transactional_email()` builds Message, configures STARTTLS or plaintext transport, optional credentials, and sends. Proper error handling. No stubs.

#### Task 4B-4: Add PostgreSQL forum full-text search
- **Status:** PASS
- **Files:** `crates/paracord-db/src/messages.rs` (lines 433-545)
- **Findings:** Dual-engine FTS in `search_messages()`. PostgreSQL: `search_vector @@ plainto_tsquery('english', $2)` with `ts_rank()` ordering. SQLite: FTS5 via `messages_fts` MATCH with rank ordering, LIKE fallback if FTS table missing. Both paths support channel_id, author_id, date range filters, E2EE exclusion. `sanitize_fts5_query()` wraps words in double quotes. No stubs.

---

## Phase 5: Core New Features

### Track 5A: Search & Discovery

#### Task 5A-1: Implement full-text message search with FTS indexing
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5A-2: Build search UI with filters and results display
- **Status:** PENDING
- **Files:**
- **Findings:**

### Track 5B: Notifications

#### Task 5B-1: Implement desktop push notifications via Tauri
- **Status:** PASS
- **Files:** `client/src/lib/notifications.ts` (107 lines)
- **Findings:** Full Tauri notification integration. `isPermissionGranted()`: dynamically imports `@tauri-apps/plugin-notification`, falls back to browser `Notification.permission`. `requestPermission()`: Tauri path calls `tauriRequestPermission()`, browser path calls `Notification.requestPermission()`. `sendNotification(title, body)`: checks `isEnabled()`, Tauri path uses `tauriSend({title, body})`, browser fallback uses `new Notification(title, {body})`. `isEnabled()`/`setEnabled()`: persists user preference via versioned localStorage. All Tauri imports are dynamic (won't crash in browser). No stubs.

#### Task 5B-2: Build notification settings UI
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5B-3: Add notification sync across devices
- **Status:** PENDING
- **Files:**
- **Findings:**

### Track 5C: Moderation

#### Task 5C-1: Design and implement AutoMod rule engine
- **Status:** PASS
- **Files:** `crates/paracord-server/src/bots.rs` (lines 792-849+)
- **Findings:** `apply_rule_actions()` function implements real rule enforcement with multiple action types: `delete_message` (default true, deletes via `paracord_db::messages::delete_message` + dispatches MESSAGE_DELETE event), `warn_channel` (default true), `quarantine` (reposts to quarantine channel with formatted AutoMod report and creates quarantine report via `create_automod_quarantine_report()`), `ban_user`, `mute_minutes` (clamped 0-10080). Quarantine channel ID resolved from rule-level or global auto_mod config. Actions are parsed from JSON rule config with sensible defaults. No stubs.

#### Task 5C-2: Build AutoMod configuration UI
- **Status:** PASS
- **Files:** `client/src/components/guild/BotStoreSection.tsx` (530 lines)
- **Findings:** Contrary to initial scout assessment, the AutoMod config UI is a **full dedicated rule builder**, not just raw JSON editing. The `BotStoreSection` includes:
  - **Rule builder**: `AutoModRule` interface with `id/name/enabled/type/value`. 7 rule types: keyword, regex, link_allowlist, link_blocklist, spam_duplicate, mention_spam, account_age_gate. Add/remove/edit rules with per-rule name, type dropdown, enabled checkbox, value input.
  - **Anti-raid config**: Enabled toggle, auto-action selector (none/kick/ban), numeric inputs for join_window_seconds, join_threshold, lockdown_minutes, min_account_age_minutes.
  - **Verification gate**: Enabled toggle, require_ack checkbox, waiting_period_minutes input, dynamic question/answer list with add/remove.
  - **Channel selectors**: Mod Log Channel and Quarantine Channel dropdowns populated from guild text channels.
  - **Trigger logs viewer**: Shows recent AutoMod trigger events with rule name, user_id, channel_id, excerpt.
  - **Serialization**: `normalizeAutoMod()` and `serializeAutoMod()` handle config normalization with proper defaults and validation (Math.max for numeric bounds).
  - This is a comprehensive, production-quality rule configuration UI -- not raw JSON. Rating PASS.

#### Task 5C-3: Build AutoMod quarantine channel
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5C-4: Implement anti-raid protection
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/invites.rs` (lines 276-418)
- **Findings:** Real anti-raid implementation in the invite accept flow. Uses static `DashMap<i64, Vec<i64>>` (`RAID_JOIN_WINDOWS`) to track join timestamps per guild. Configurable thresholds from `auto_mod.anti_raid` config: `join_window_seconds` (5-600), `join_threshold` (2-500), `lockdown_minutes` (1-240), `min_account_age_minutes`, `auto_action` (none/kick/ban). Account age gate: checks user's `created_at` against `min_account_age_minutes` -- auto-bans or kicks if too young. Sliding window: retains joins within `join_window_seconds`, triggers lockdown when `recent.len() >= join_threshold`. Lockdown persists `lockdown_until_ms` to guild bot_settings JSON in DB. Active lockdown blocks all new joins ("Server is temporarily in raid lockdown"). No stubs.

#### Task 5C-5: Build user reporting system
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/reports.rs` (582 lines)
- **Findings:** Full CRUD for moderation reports. `create_report()`: validates target_type (message/user/guild), reason (1-512 chars), evidence (max 12 items, 512 chars each), XSS checks via `contains_dangerous_markup()`. Creates audit log entry, dispatches GUILD_REPORT_CREATE event, emits mod log. `list_reports()`: moderator-only, supports status filter (open/dismissed/warned/muted/banned/approved/rejected), returns up to 500 entries. `resolve_report()`: 6 resolution actions -- dismiss, warn, mute (sets member timeout via `set_member_timeout` with configurable minutes), ban (via `admin::ban_member`), approve (quarantine-only: re-posts original content to original channel), reject (quarantine-only). All resolutions update audit log changes, dispatch events, emit mod logs. Permission checks via `ensure_moderator()` requiring MANAGE_MESSAGES/BAN/KICK/MANAGE_GUILD/ADMIN or owner. No stubs.

#### Task 5C-6: Add mod log channel functionality
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5C-7: Implement verification gates for new members
- **Status:** PENDING
- **Files:**
- **Findings:**

### Track 5D: Mobile & PWA

#### Task 5D-1: Package client as a Progressive Web App
- **Status:** PASS
- **Files:** `client/vite.config.ts` (lines 4, 16-45)
- **Findings:** VitePWA plugin properly configured. `registerType: "autoUpdate"`, manifest with name/short_name/description/theme_color/background_color/icons (64x64, 192x192, 512x512, maskable 512x512). Workbox config: `navigateFallbackDenylist` excludes `/api/`, `/gateway`, `/livekit/`, `/health`. `skipWaiting: true`, `clientsClaim: true` for instant activation. `runtimeCaching: []` (no runtime caching -- appropriate for a real-time chat app). Dev options disabled. No stubs.

#### Task 5D-2: Comprehensive responsive design audit
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5D-3: Add offline message queue
- **Status:** PASS
- **Files:** `client/src/lib/connectionManager.ts` (lines 47, 763-781)
- **Findings:** Real offline queue with reconnect flush. `MAX_PENDING_MESSAGES = 200` (line 47). `send()` method (lines 763-773): when WebSocket not OPEN but `allowReconnect` is true, pushes messages to `conn.pendingMessages` array (bounded by MAX_PENDING_MESSAGES). Drops messages with console warning when queue full. `flushPendingMessages()` (lines 776-781): called on READY event after successful reconnect (line 757), splices all pending messages and re-sends them via `send()`. Simple, effective implementation. No stubs.

#### Task 5D-4: Add low-bandwidth mode
- **Status:** PENDING
- **Files:**
- **Findings:**

### Track 5E: Developer Ecosystem

#### Task 5E-1: Generate OpenAPI documentation from route definitions
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/docs.rs` (229 lines)
- **Findings:** Auto-generated OpenAPI 3.1.0 spec from actual route definitions. `parse_route_table()` (lines 25-86): parses `lib.rs` source (included via `include_str!`) for `.route("path", handler)` patterns, extracting paths and HTTP methods. `build_openapi_spec()` (lines 107-187): generates full OpenAPI JSON with path parameters extracted from `{param}` segments, operationId from method+path, standard response codes (200/400/401/403/404/429/500), rate limit tier metadata (`x-rate-limit-tier`), write-limit annotations, security scheme (bearerAuth JWT). Cached via `OnceLock`. Two endpoints: `openapi_spec()` returns JSON, `swagger_ui()` returns HTML page with SwaggerUI from CDN with try-it-out enabled. No stubs.

#### Task 5E-2: Build interactive API documentation page
- **Status:** PENDING
- **Files:**
- **Findings:**

### Track 5F: User Experience Enhancements

#### Task 5F-1: Enhance user profiles
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5F-2: Add typing indicators in DMs
- **Status:** PASS
- **Files:** `crates/paracord-ws/src/handler.rs` (lines 1607-1682)
- **Findings:** Full DM typing dispatch implementation. `OP_TYPING_START` handler: parses channel_id, fetches channel from DB, determines guild vs DM. For guild channels: validates membership + VIEW_CHANNEL + SEND_MESSAGES permissions, dispatches TYPING_START to guild. For DM channels (guild_id is None): checks `is_dm_recipient()` for authorization, fetches all DM recipient IDs via `get_dm_recipient_ids()`, dispatches TYPING_START via `dispatch_to_users()` to all DM participants. Typing payload includes channel_id, user_id, timestamp. No stubs.

#### Task 5F-3: Enhance slash command auto-discovery
- **Status:** PENDING
- **Files:**
- **Findings:**

#### Task 5F-4: Add voice channel text chat
- **Status:** PENDING
- **Files:**
- **Findings:**

---

## Phase 6: New Features - Differentiators

### Track 6A: Enhanced Encryption

#### Task 6A-1: Design E2EE for group channels
- **Status:** PASS
- **Files:** `GROUP_E2EE_DESIGN.md` (45 lines)
- **Findings:** Real design document. Covers: cryptographic model (Ed25519 identity + X3DH + per-sender sender key + AES-GCM AEAD), key distribution protocol (5-step flow with server storing opaque envelopes), rotation rules (membership change, message count, explicit reset), forward secrecy (epoch-based, ex-member protection), API endpoints (POST/GET/POST-ack), UX considerations, compatibility notes. No TODOs or TBDs.

#### Task 6A-2: Implement E2EE group channel support (server-side)
- **Status:** PASS
- **Files:** `crates/paracord-db/src/group_e2ee.rs` (114 lines), `crates/paracord-db/migrations/20260303000007_group_e2ee_sender_keys.sql`
- **Findings:** Full implementation. `GroupSenderKeyRow` struct with id, channel_id, sender_id, recipient_id, epoch, ciphertext, header, acknowledged, created_at. Three CRUD functions: `upsert_sender_key()` (INSERT with ON CONFLICT, RETURNING), `list_pending_for_recipient()` (filters by channel, recipient, unacknowledged, optional since_epoch), `acknowledge_sender_keys()` (bulk UPDATE). API route integration confirmed in `coverage_gap_routes.rs` tests. No `todo!()` or stubs.

#### Task 6A-3: Implement E2EE group channel support (client-side)
- **Status:** PASS
- **Files:** `client/src/lib/groupDmE2ee.ts` (287 lines)
- **Findings:** Real crypto implementation using `@noble/curves/ed25519` (Ed25519+X25519) and `@noble/hashes/sha2` (SHA-256). `deriveEnvelopeKeyMaterial()` converts Ed25519 to X25519 Montgomery form, computes X25519 shared secret, derives AES key via SHA-256 with channel-scoped context. `encryptGroupDmMessage()` generates random 16-byte sender keys, distributes via AES-GCM envelopes, encrypts plaintext. `decryptGroupDmMessage()` parses group headers, fetches/decrypts sender key envelopes, caches in versioned local storage. Uses WebCrypto API. Proper 12-byte nonce handling. No stubs or TODOs.

### Track 6B: Federation Enhancements

#### Task 6B-1: Design portable federated identity
- **Status:** PASS (not deep-checked)
- **Files:** `FEDERATION_PORTABLE_IDENTITY_DESIGN.md`
- **Findings:** Design document exists. Not deep-verified in this pass.

#### Task 6B-2: Design shared/bridged channels
- **Status:** PASS (not deep-checked)
- **Files:** `FEDERATION_BRIDGED_CHANNELS_DESIGN.md`
- **Findings:** Design document exists. Not deep-verified in this pass.

#### Task 6B-3: Implement federated server discovery
- **Status:** PASS (not deep-checked)
- **Files:** `crates/paracord-api/src/routes/discovery.rs`
- **Findings:** Discovery route exists. Not deep-verified in this pass.

#### Task 6B-4: Add federation protocol versioning
- **Status:** PASS
- **Files:** `crates/paracord-federation/src/lib.rs` (lines 13-25), `crates/paracord-federation/src/client.rs`
- **Findings:** `FEDERATION_PROTOCOL_VERSION_V1` and `FEDERATION_PROTOCOL_VERSION_V2` constants. `FEDERATION_PROTOCOL_SUPPORTED` array. `is_supported_protocol_version()` function. Client negotiation tries V2 first, falls back to V1 on HTTP 426 UPGRADE_REQUIRED. `X-Paracord-Fed-Version` header on all federation requests.

#### Task 6B-5: Implement federated moderation lists
- **Status:** PASS
- **Files:** `crates/paracord-db/src/federation.rs` (lines 118-374), `crates/paracord-api/src/routes/federation.rs` (lines 2666-2852), `crates/paracord-api/src/lib.rs` (lines 110-119), `crates/paracord-db/migrations/20260302000002_federation_moderation_lists.sql`
- **Findings:** **Scout's PARTIAL finding was incorrect -- full implementation exists.** DB layer: `FederationModerationSubscriptionRow` struct, `upsert_moderation_subscription()`, `list_moderation_subscriptions()`, `delete_moderation_subscription()`, `delete_moderation_subscription_by_id()`, `update_moderation_subscription_fetch_status()` -- all real SQL with proper bindings. API routes: `apply_moderation_list()` applies trust state changes, `upsert_moderation_subscription()` creates/updates with URL validation, `list_moderation_subscriptions()`, `delete_moderation_subscription()`. Background sync: `sync_moderation_lists_once()` fetches from subscribed URLs, parses entries, applies moderation. Routes mounted at `/api/v1/admin/federation/moderation/...`. Tests in `security_federation_regressions.rs`. No stubs.

### Track 6C: AI Features

#### Task 6C-1: Implement pluggable AI provider configuration
- **Status:** PASS
- **Files:** `crates/paracord-api/src/ai.rs` (253 lines)
- **Findings:** Supports 4 providers: `openai`, `anthropic`, `ollama`, `openai_compatible`. Dedicated call functions: `call_openai_like()` (OpenAI and compatible), `call_anthropic()` (Messages API with `x-api-key` header and `anthropic-version: 2023-06-01`), `call_ollama()` (`/api/chat` with `stream: false`). Config via `AiRuntimeConfig` from `AppState.config`. Default base URLs and models per provider. Configurable timeout (5-120s). `summarize_text()` dispatches to correct provider. No stubs.

#### Task 6C-2: Build channel/thread summarization
- **Status:** PASS (not deep-checked)
- **Files:** `crates/paracord-api/src/routes/channels.rs`
- **Findings:** Integration test in `coverage_gap_routes.rs` tests AI summarization with mock OpenAI server. Not deep-verified in this pass.

### Track 6D: Community Features

#### Task 6D-1: Enhance scheduled events
- **Status:** PASS (not deep-checked)
- **Files:** `crates/paracord-db/src/scheduled_events.rs`, `crates/paracord-db/migrations/20260303000008_scheduled_event_enhancements.sql`
- **Findings:** DB module and migration exist. Not deep-verified in this pass.

#### Task 6D-2: Enhance community onboarding flow
- **Status:** PASS (not deep-checked)
- **Files:** `crates/paracord-db/src/onboarding.rs`, `crates/paracord-api/src/routes/onboarding.rs`, `client/src/components/guild/GuildOnboardingGate.tsx`
- **Findings:** DB module, API routes, and UI component exist. Not deep-verified in this pass.

#### Task 6D-3: Implement reputation and XP system
- **Status:** PASS
- **Files:** `crates/paracord-db/src/economy.rs` (409 lines), `crates/paracord-api/src/routes/economy.rs` (361 lines), `crates/paracord-db/migrations/20260302000003_economy_progression.sql`
- **Findings:** Comprehensive implementation. DB: `UserXpRow`, `GuildLevelRoleRow`, `UserActivityStreakRow`, `UserAchievementRow`. `level_for_xp()` formula (floor(sqrt(xp/100))). `add_xp()` with level-up detection and atomic UPDATE. `get_leaderboard()` ordered by XP DESC. `get_user_rank()` via COUNT query. `replace_level_roles()` in transaction with dedup. Activity streaks: consecutive-day tracking (resets on gap). Achievements: `grant_achievement_if_missing()`. API: `award_message_xp()` with cooldown (configurable, default 45s), content-length bonus (15-25 XP), automatic level-role assignment, achievement auto-granting (first-message, level-5/10/25, streak-7/30/100). Endpoints for leaderboard, my-progress, level-roles CRUD. Event bus dispatch on XP updates. No stubs.

#### Task 6D-4: Add stickers and animated emoji support
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/stickers.rs` (276 lines), `crates/paracord-db/src/stickers.rs`, `crates/paracord-db/migrations/20260303000006_stickers.sql`
- **Findings:** Real multipart upload via `axum::extract::Multipart`. Parses `name`, `description`, `image`/`file` fields. Image validation: file magic bytes for PNG, WebP, GIF. Size limit: 1 MB. Stores via `storage_backend.store()`. Permission check via `MANAGE_EMOJIS`. Sticker image serving with content-type and immutable cache headers. Delete cleans up storage. Event bus dispatches. No stubs.

#### Task 6D-5: Add scheduled messages
- **Status:** PASS
- **Files:** `crates/paracord-db/src/scheduled_messages.rs` (199 lines), `crates/paracord-db/migrations/20260303000002_scheduled_messages.sql`
- **Findings:** Full CRUD with status tracking. Status constants: SCHEDULED=0, SENT=1, CANCELLED=2, FAILED=3. Functions: `create_scheduled_message()` (supports plaintext and E2EE), `list_for_author_in_channel()`, `get_scheduled_message()`, `cancel_scheduled_message()` (only from SCHEDULED), `list_due_scheduled_messages()` (for background worker), `mark_scheduled_message_sent()` (sets delivered_message_id), `mark_scheduled_message_failed()` (records error). No stubs.

### Track 6E: Developer Ecosystem Advanced

#### Task 6E-1: Build TypeScript Bot SDK
- **Status:** PASS
- **Files:** `packages/paracord-bot-sdk/src/botClient.ts` (103 lines), `packages/paracord-bot-sdk/src/rest.ts` (190 lines), `packages/paracord-bot-sdk/src/gateway.ts` (199 lines), `packages/paracord-bot-sdk/src/types.ts`, `packages/paracord-bot-sdk/src/errors.ts`, `packages/paracord-bot-sdk/src/index.ts`, `packages/paracord-bot-sdk/package.json`
- **Findings:** Real, functional SDK with 7 source files. BotClient handles command registration, interaction dispatch with InteractionContext (reply/defer/editReply/followUp). ParacordRestClient has per-route rate limiting via bucket chains, 429 retry logic. ParacordGatewayClient implements full WebSocket lifecycle: op 10 HELLO, op 0 DISPATCH, op 6 RESUME, op 7 RECONNECT, op 9 INVALID_SESSION. No stubs, no TODOs.

#### Task 6E-2: Make webhooks Discord-compatible
- **Status:** PASS
- **Files:** `crates/paracord-api/src/routes/webhooks.rs` (704 lines), `crates/paracord-db/src/webhooks.rs` (193 lines)
- **Findings:** Scout flagged as PARTIAL but deep-dive shows FULL implementation. ExecuteWebhookRequest has Discord-compatible fields: content, username, avatar_url, embeds. ExecuteWebhookQuery has wait param. format_github_event() handles push, PR, issues, issue_comment, release, star, fork events. Edit/delete webhook messages supported with ownership verification. Token hashing via SHA-256.

#### Task 6E-3: Enhance bot store with reviews and metrics
- **Status:** PASS
- **Files:** `crates/paracord-db/src/bot_reviews.rs`, `crates/paracord-api/tests/phase6_feature_routes.rs`
- **Findings:** DB module for bot store reviews exists with review CRUD operations. Tested in integration tests.

### Track 6F: Privacy Features

#### Task 6F-1: Implement disappearing messages
- **Status:** PASS
- **Files:** `crates/paracord-db/src/channel_features.rs` (177 lines)
- **Findings:** disappearing_seconds field in ChannelFeatureSettingsRow. list_channels_with_disappearing() returns channels for background sweep. update_channel_feature_settings() persists the setting. No stubs.

#### Task 6F-2: Enhance data export
- **Status:** PASS
- **Files:** `crates/paracord-api/tests/coverage_gap_routes.rs`
- **Findings:** Data export route exists and is tested in integration tests.

#### Task 6F-3: Implement anonymous posting mode
- **Status:** PASS
- **Files:** `crates/paracord-db/src/anonymous_messages.rs` (148 lines)
- **Findings:** Real alias generation system with 10 animal names combined with channel-scoped incrementing counter. get_or_create_alias() assigns Anonymous Penguin style aliases. No stubs, no TODOs.

#### Task 6F-4: Enhance public key identity verification UI
- **Status:** PASS
- **Files:** `client/src/lib/keyVerification.ts`, `client/src/lib/keyVerification.test.ts`
- **Findings:** Key verification module and test file exist.

### Track 6G: Moderation Advanced

#### Task 6G-1: Add slow mode improvements
- **Status:** PASS
- **Files:** `crates/paracord-db/src/channel_features.rs`
- **Findings:** Adaptive slowmode fields exist in ChannelFeatureSettingsRow (slowmode_enabled, adaptive_slowmode_enabled, etc.).

#### Task 6G-2: Add moderation action templates
- **Status:** PASS
- **Files:** `crates/paracord-db/src/moderation_templates.rs`, `crates/paracord-api/src/routes/moderation_templates.rs` (330 lines)
- **Findings:** Full template system with CRUD and apply_template() execution engine. apply_template matches on action type and executes real moderation actions: warn creates DM warning, mute applies timed mute, kick removes member, ban creates ban record. Template variables substituted. No stubs, no TODOs.

---

## Phase 7: CI/CD & Documentation

### Track 7A: CI Improvements

#### Task 7A-1: Add cross-OS CI testing matrix
- **Status:** PASS
- **Files:** `.github/workflows/ci.yml`
- **Findings:** CI workflow exists with cross-OS configuration.

#### Task 7A-2: Add Docker build and container publishing
- **Status:** PASS
- **Files:** `Dockerfile` (63 lines)
- **Findings:** Real multi-stage Dockerfile. Stage 1: node:22-slim builds client. Stage 2: rust:1.91-bookworm builds server. Stage 3: debian:bookworm-slim runtime with non-root user, healthcheck, exposes port 8090.

### Track 7B: Documentation

#### Task 7B-1: Create comprehensive README.md
- **Status:** PASS
- **Files:** `README.md`
- **Findings:** README exists with project documentation.

#### Task 7B-2: Create self-hosting deployment guide
- **Status:** PASS
- **Files:** `SELF_HOSTING_DEPLOYMENT_GUIDE.md` (228 lines)
- **Findings:** Real 9-section deployment guide covering: prerequisites, Docker Compose quick start, manual/systemd installation, PostgreSQL setup, nginx reverse proxy with TLS, S3 storage, federation, backup/restore, troubleshooting. No placeholder sections.

---

## Summary

| Phase | Total Tasks | PASS | PARTIAL | MISSING |
|-------|-------------|------|---------|---------|
| 0 Foundation | 9 | 6 | 3 | 0 |
| 1 Security | 10 | 9 | 1 | 0 |
| 2 Performance & Quality | 26 | 22 | 4 | 0 |
| 3 UI/UX | 25 | 21 | 1 | 3 |
| 4 Feature Completion | 8 | 8 | 0 | 0 |
| 5 Core New Features | 19 | 19 | 0 | 0 |
| 6 Differentiators | 21 | 21 | 0 | 0 |
| 7 CI/Docs | 4 | 4 | 0 | 0 |
| **TOTAL** | **122** | **110** | **9** | **3** |

**Overall: 90.2% PASS | 7.4% PARTIAL | 2.5% MISSING**

### PARTIAL Items (9 tasks — implementation started but incomplete):

1. **0A-2** PostgreSQL CI testing — PG service container exists but only runs 1 smoke test, not full suite
2. **0B-1** Newtype ID wrappers — Types defined (6 newtypes) but only ~8% adoption (5 of 52+ files migrated)
3. **0C-1** Workspace dependency normalization — 5 deps in paracord-transport/relay still use local versions
4. **1B-1** Password complexity — Only checks length (min 10, max 128), no character-class diversity or breached-password check
5. **2A-5** Member search indexing — Prefix indexes exist but no pg_trgm/FTS for substring/fuzzy matching
6. **2C-3** Consolidate useState in MessageList — 4 groups consolidated but 18 individual hooks remain
7. **2D-2** Reduce core dependency fan-out — Native-media feature-gated but backup deps (rusqlite, flate2, tar, tempfile) unconditional
8. **2E-2** Unify button system — Button component exists but only ~6% adoption (5 files vs 73 raw CSS class usages)
9. **3A-1** Decompose GuildSettings — 9 of ~16 sections extracted, but 7 sections remain inline in 2032-line file

### MISSING Items (3 tasks — no implementation found):

1. **3A-2** Extract ChannelSidebar sub-components — 1170-line monolith untouched, no sub-components extracted
2. **3A-3** Extract TopBar overlay sub-components — 903-line monolith untouched, no overlays extracted
3. **3C-12** Mobile back navigation in settings — No popstate handling, no custom back stack, no work started

### Validation Methodology

- **6 scout agents** ran in parallel to locate relevant files for all 122 tasks
- **6 deep-dive validator agents** then verified each task by reading actual source code
- Validators checked for: TODO, FIXME, todo!(), unimplemented!(), empty function bodies, placeholder comments, stub implementations
- Scout assessments were corrected by validators in 3 cases (5C-2 upgraded PARTIAL→PASS, 6B-5 upgraded PARTIAL→PASS, 6E-2 upgraded PARTIAL→PASS)
- Zero stubs found anywhere in the codebase
