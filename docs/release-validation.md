# Release Validation Runbook

Date: 2026-05-18

This runbook lists the checks that should be green before tagging a public
GitHub release. It does not replace `RELEASE_CHECKLIST_STATUS.md`; it is the
repeatable command set for collecting evidence.

## Local Gates

Run from the repository root unless a command changes directories.

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
cargo test --workspace
cargo test --workspace --all-targets
cargo test -p paracord-desktop --lib -- --quiet
cargo test -p paracord-federation ssrf -- --quiet
cargo audit
python scripts/check_release_version.py
python scripts/ci_migration_sanity.py
python scripts/release_sqlite_upgrade_from_tag_smoke.py v0.9.0
python scripts/release_sqlite_query_plan_smoke.py
python scripts/security_gate_check.py
python scripts/validate_release_checklist_status.py
cargo test -p paracord-api --test security_federation_regressions password_reset_completion_updates_password_revokes_sessions_and_consumes_token -- --quiet
# Verifies current SQLite/PostgreSQL migrations, release Python/shell scripts,
# public release docs, and workflow YAML resolve to
# text eol=lf and contain no CR bytes in the working tree.
python scripts/check_migration_line_endings.py
python scripts/check_python_syntax.py
actionlint .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security-audit.yml .github/workflows/security-dast-fuzz.yml
docker run --rm -v "${PWD}:/work" -w /work bash:5 bash -n scripts/setup.sh scripts/backup-db.sh scripts/restore-db.sh
git diff --check
```

If `actionlint` is not installed on the host, use the pinned Docker image:

```bash
docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security-audit.yml .github/workflows/security-dast-fuzz.yml
```

The `--features s3` checks are compatibility coverage for the optional
S3-compatible object-storage backend. The default release path remains local
filesystem storage and does not require AWS credentials or AWS infrastructure.
The focused server config test verifies that S3 environment variables do not
select S3 storage unless `PARACORD_STORAGE_TYPE=s3` is explicitly set.

`scripts/security_gate_check.py` must pass from the public
`docs/security-release-gate.md` file in a fresh checkout. The ignored local
`SECURITY_REMEDIATION_TRACKER.md` is only a developer fallback and must not be
required for CI.

`cargo test -p paracord-desktop --lib -- --quiet` must remain green when
editing Tauri desktop networking, server connection, or trusted-origin logic. It
guards the scoped self-signed TLS exception used for self-hosted servers.

When a PostgreSQL test database is available, set `PARACORD_TEST_POSTGRES_URL`
and also run:

```bash
cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture
python scripts/release_postgres_upgrade_from_tag_smoke.py v0.9.0
cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture
cargo test -p paracord-api --test postgres_route_smoke -- --nocapture
```

The PostgreSQL route smoke must continue covering more than basic CRUD. It
currently exercises scheduled-message create/list/cancel, group DM create/list,
webhook token execution, economy XP/streak/leaderboard reads, invite
exhaustion, reactions, roles, members, messages, and attachments.

`cargo audit -D warnings` is intentionally not listed as a pass/fail gate while
`docs/release-risk-waivers.md` contains known RustSec warning waivers; it
currently fails on 23 documented warnings.

```bash
cd client
npm ci
npm audit --audit-level=moderate
npm run typecheck
npm run test:a11y:static
npm run test:unit
npm run test:e2e
npm run test:contrast
npm run build
```

`npm run test:a11y:static` must remain part of the client gate. It verifies
icon-only, title-only icon, and Tooltip-wrapped interactive controls have
explicit accessible names, menus and modal dialogs expose role/name/focus
metadata, non-interactive elements do not carry primary click handlers, and
literal `aria-labelledby` references point to real IDs.

The shared client `Button` component must continue defaulting to `type="button"`;
only real form submits should pass `type="submit"`. Keep
`npm run test:unit -- Button.test.tsx --reporter=dot` green when editing shared
controls.

The CommandPalette must keep dialog semantics and focus containment. Keep
`npm run test:unit -- CommandPalette.test.tsx --reporter=dot` green when
editing global navigation, modal, or focus-trap behavior.

DM and group-DM empty/error feedback must remain user-visible. Keep
`npm run test:unit -- DMList.test.tsx DMPage.test.tsx --reporter=dot` green
when editing DM picker creation, group-member management, or friend-list
filtering behavior.

Dashboard online-friend DM actions must keep visible failure feedback and
successful navigation. Keep
`npm run test:unit -- HomePage.test.tsx --reporter=dot` green when editing the
home dashboard or quick DM paths.

Friends list actions must keep labeled search, inline DM-open failure feedback,
trimmed add-friend submission, and duplicate-send prevention. Keep
`npm run test:unit -- FriendsPage.test.tsx --reporter=dot` green when editing
friend-list actions or relationship-store wiring.

Message search must keep labeled query/author filter controls, a named close
action, and announced failure feedback when server search and fallback recent
message filtering are unavailable. Keep
`npm run test:unit -- SearchPanel.test.tsx --reporter=dot` green when editing
message search surfaces.

The global top-bar search overlay must keep a named dialog, labeled search
field, named close action, progress status, and announced failure feedback.
Keep `npm run test:unit -- SearchOverlay.test.tsx --reporter=dot` green when
editing top-bar overlays or global message search.

Channel summary failures must remain announced inline and preserve the API error
detail. Keep `npm run test:unit -- TopBar.summary.test.tsx --reporter=dot`
green when editing top-bar overlays or channel-summary API handling.

Admin backup download/delete/restore filenames must remain path-safe and
header-safe. Keep
`cargo test -p paracord-api --test coverage_gap_routes admin_backup_routes_reject_header_unsafe_filenames -- --quiet`
green when editing backup routes, response headers, or backup filename
validation.

Direct-message voice calls must surface join failures to the user instead of
only writing diagnostics. Keep
`npm run test:unit -- TopBar.dm.test.tsx --reporter=dot` green when editing the
top bar, direct-message call button, or voice join error handling.

Guild upload policy checks must use the final stored content type after active
content is downgraded to `application/octet-stream`, not just the claimed
multipart `Content-Type`. Keep
`cargo test -p paracord-api --test coverage_gap_routes upload_policy_uses_active_content_downgraded_type -- --quiet`
green when editing upload policy enforcement, attachment MIME normalization, or
active-content handling.

Guild custom emoji image assets must require guild membership, support scoped
query-token fallback for cross-origin browser image loads, and send `nosniff`.

Federation and OpenGraph outbound fetchers must keep private-network/DNS
validation and safe redirect behavior. Keep
`cargo test -p paracord-federation ssrf -- --quiet` green when editing
federation RPC clients, federated file downloads, discovery fan-out,
moderation-list sync, or shared federation URL validators. Federation RPC,
federated discovery, and moderation-list sync should fail closed on redirects;
federated file downloads and OpenGraph previews may follow redirects only when
each hop is revalidated before the next request.
Keep
`cargo test -p paracord-api --test coverage_gap_routes custom_emoji_images_require_membership_and_support_query_tokens -- --quiet`
green when editing emoji image routes, custom emoji storage, or browser-rendered
emoji URLs. Keep `cargo test -p paracord-api middleware::tests -- --quiet`
green when editing query-token fallback routing for guild emoji/sticker image
assets.

Message component button/select interactions must surface failures to the user,
entity-select option loads must show an inline alert when unavailable, and
unsafe link-button URLs must be blocked before `window.open`. Keep
`npm run test:unit -- MessageComponents.test.tsx --reporter=dot` green when
editing bot message buttons, link buttons, select menus, or component
interaction dispatch.

Bot interaction-response, original-response edit, and followup components must
persist through channel message history reloads. Keep
`cargo test -p paracord-api --test bot_system_routes -- --quiet` and
`cargo test -p paracord-db -- --quiet` green when editing message persistence,
interaction callbacks, followups, or component serialization.

Pinned-message overlays must distinguish failed loads from genuinely empty
channels and must surface failed unpin requests inline. Keep
`npm run test:unit -- TopBar.pins.test.tsx --reporter=dot` green when editing
top-bar overlays, pinned-message API calls, or pin/unpin flows.

Inbox overlays must distinguish failed unread-state loads from a genuinely
caught-up inbox. Keep
`npm run test:unit -- TopBar.inbox.test.tsx --reporter=dot` green when editing
top-bar overlays, read-state loading, or inbox behavior.

Announcement-channel follow manager actions must keep inline failure feedback
for both follow and unfollow requests. Keep
`npm run test:unit -- TopBar.follows.test.tsx --reporter=dot` green when
editing top-bar overlays, announcement channels, or channel-follow APIs.

Scheduled-event calendar export URLs must encode dynamic path segments before
opening same-origin downloads. Keep
`npm run test:unit -- EventList.test.tsx --reporter=dot` green when editing
event calendar export, iCal links, or event chat navigation.

Stored image fields must render only safe raster data URLs and must not request
unimplemented legacy image-hash endpoints. Keep
`npm run test:unit -- security.test.ts BotStoreCard.test.tsx MessageComponents.test.tsx GuildWelcomeScreen.test.tsx GuildHub.test.tsx Sidebar.test.tsx DiscoveryPage.test.tsx HomePage.test.tsx --reporter=dot`
green when editing guild image rendering, guild settings icon uploads, server
hub banner uploads, bot-store icons, profile banners, or entity-select avatars.

The guild welcome screen must render only safe stored guild icon data URLs and
must not request unresolved legacy icon endpoints. Keep
`npm run test:unit -- GuildWelcomeScreen.test.tsx security.test.ts --reporter=dot`
green when editing the welcome screen or guild icon rendering.

Inline channel creation, copy-ID, and leave-server actions must keep labeled
controls, immediate channel-store insertion after a successful create, and
user-visible failure feedback. Keep
`npm run test:unit -- GuildChannelList.test.tsx --reporter=dot` green when
editing channel grouping, category actions, guild-channel create flows, or
server/channel context-menu behavior.

Clipboard copy actions must use `writeClipboardText` instead of direct
`navigator.clipboard` access so unavailable/blocked clipboard APIs surface
user-visible errors. Keep
`npm run test:unit -- GuildChannelList.test.tsx Sidebar.test.tsx MemberList.test.ts UserPanel.test.tsx InviteModal.test.tsx --reporter=dot`
green when editing copy-ID, username-copy, message-copy, invite-copy, token-copy,
or webhook-copy behavior.

Developer bot token copy failures must preserve the concrete clipboard error
detail in the visible error banner. Keep
`npm run test:unit -- DeveloperPage.metrics.test.tsx --reporter=dot` green when
editing bot token reveal/regeneration/copy flows.

Developer bot app actions must preserve API error details in visible feedback,
especially create/update/delete/regenerate-token/settings failures. Keep
`npm run test:unit -- DeveloperPage.metrics.test.tsx --reporter=dot` green when
editing developer portal app forms or bot API wiring.

Invite generation must never place error text into copyable invite fields.
Keep `npm run test:unit -- InviteModal.test.tsx --reporter=dot` green when
editing invite creation, portable link generation, expiration/max-use controls,
or invite copy controls. The "Never" and "No limit" controls must send explicit
`0` values because the API treats omitted fields as defaults.

Invite creation must reject nonsensical bounds. Keep `cargo test -p
paracord-api --test coverage_gap_routes invite_create_rejects_out_of_range_limits
-- --quiet` green when editing invite creation validation or API contracts.

Login password-reset and MFA challenge flows must remain user-visible and
submittable. Keep `npm run test:unit -- LoginPage.flow.test.tsx --reporter=dot`
green when editing LoginPage auth flows or auth API wiring.

Registration must keep password-confirmation blocking, trimmed account payloads,
connected-server persistence, app navigation, and unlocked local public-key
attachment working. Keep
`npm run test:unit -- RegisterPage.test.tsx --reporter=dot` green when editing
registration or first-run auth flows.

Account-settings MFA setup and disable flows must remain reachable and labeled.
Keep `npm run test:unit -- UserSettings.mfa.test.tsx --reporter=dot` green
when editing user settings account security controls.

Economy/progression UI must keep leaderboard/progress rendering, achievement
badges, load-error feedback, level-role mapping add/remove/save, assignable-role
filtering, and save feedback working. Keep
`npm run test:unit -- GuildEconomyPanel.test.tsx EconomySettingsSection.test.tsx --reporter=dot`
green when editing economy panels or guild economy settings.

Onboarding UI must tolerate malformed member payloads, render configured member
gates, and keep admin settings load/edit/save, role option filtering/selection,
progressive threshold clamping, save feedback, and load-error feedback working.
Keep `npm run test:unit -- OnboardingSettingsSection.test.tsx GuildOnboardingGate.test.tsx --reporter=dot`
green when editing onboarding settings or member gate flows.

Anonymous/disappearing-message UI must keep the composer anonymous-posting
warning, anonymous message badge, expiry label rendering, slowmode/rate-limit
send-error feedback, message reaction/pin failure toasts, and selected-file
attachment upload wiring working. Keep
`npm run test:unit -- MessageList.anonymous.test.tsx MessageInput.test.tsx --reporter=dot`
green when editing channel feature display, message history, or composer feature
warnings, send-failure handling, or composer attachments.

Standalone upload controls must remain keyboard-reachable and named while
forwarding selected files from the hidden input. Keep
`npm run test:unit -- FileUpload.test.tsx --reporter=dot` green when editing
shared upload controls.

One-to-one DM send paths must keep locked-account rejection and encrypted
payload wiring intact: plaintext content must be cleared before API send when
the account key is unlocked, and locked keys must block encrypted sends before
any API call. Keep
`npm run test:unit -- messageStore.test.ts --reporter=dot` green when editing
DM send/edit encryption, channel recipient metadata, or account unlock handling.

Account setup and recovery pages must keep recovery phrase display,
acknowledgement-gated continuation, trimmed username/display-name submission,
exact 24-word validation, and successful recovery navigation working. Keep
`npm run test:unit -- AccountRecovery.flow.test.tsx --reporter=dot` green when
editing local identity setup, recovery phrase handling, or account recovery
forms.

Locked-account unlock must keep missing-account redirect, recovery/import
navigation, failed-attempt cooldown, stored-server restoration, and reconnect
behavior working. Keep
`npm run test:unit -- AccountUnlockPage.test.tsx --reporter=dot` green when
editing locked account unlock flows or post-unlock server restoration.

Sticker and custom server-emoji picker flows must remain reachable and
submittable. Keep
`npm run test:unit -- StickerPicker.test.tsx EmojiPicker.serverEmoji.test.tsx MessageInput.sticker.test.tsx --reporter=dot`
green when editing message composer pickers, sticker API wiring, sticker-only
message send, custom emoji tokens, or gateway emoji refresh behavior. Sticker
image URLs must keep falling back to text when the resource URL is unsafe.
Keep `npm run test:unit -- customEmoji.test.ts --reporter=dot` green when
editing custom emoji token parsing or custom emoji image URL construction.

Guild emoji upload-management controls must keep client-side type/size
validation, permission-aware read-only behavior, rename keyboard handling, and
empty-state rendering. Keep
`npm run test:unit -- EmojisSection.test.tsx --reporter=dot` green when editing
guild settings emoji management.

Guild moderation-template controls must keep accessible form labels, disabled
create behavior, timed-mute duration submission, target-user apply submission
with optional reason/DM overrides, named delete actions, success feedback, and
empty-state rendering. Keep
`npm run test:unit -- ModerationTemplatesSection.test.tsx --reporter=dot` green
when editing guild settings moderation-template management.

Bot review and authorization UI must keep accessible review/server controls,
review summary/list rendering, review submission refresh behavior, user-visible
review failures, and guild authorization wiring. Keep
`npm run test:unit -- BotAuthorizePage.reviews.test.tsx --reporter=dot` green
when editing OAuth bot authorization or bot-store review surfaces.

Template-gallery UI must keep accessible source-guild and new-server-name
controls, template detail rendering, create-from-guild, apply-to-new-server,
delete confirmation, and load-error feedback working. Keep
`npm run test:unit -- TemplateGalleryPage.test.tsx --reporter=dot` green when
editing template-gallery flows.

Create-server modal flows must keep create, join, and template tabs working,
including template loading/preview, accessible template selection,
apply-to-new-server navigation, invite-code parsing, channel selection, and load
errors. Keep
`npm run test:unit -- CreateGuildModal.template.test.tsx --reporter=dot` green
when editing the create-server modal.

Forum surfaces must preserve API error details in user-visible feedback for
search and post creation. Keep
`npm run test:unit -- ForumView.test.tsx --reporter=dot` green when editing
forum post listing, search, tag management, or new-post creation.

Invite links must keep preview failure feedback, unauthenticated login routing,
verification acknowledgement/answers, guild insertion, channel fetch/selection,
and post-accept navigation working. Keep
`npm run test:unit -- InvitePage.test.tsx --reporter=dot` green when editing
invite preview or accept flows.

Public discovery must keep retryable load-error feedback, public-invite join
navigation, no-public-invite feedback, and the accessible back action working.
Keep `npm run test:unit -- DiscoveryPage.test.tsx --reporter=dot` green when
editing public discovery.

Scheduled-message composer behavior must keep schedule-mode action labeling,
in-flight disabling, future-time validation before API calls, ISO payload
wiring, success reset/toast, and failure feedback without losing content/date.
Keep
`npm run test:unit -- MessageInput.test.tsx --reporter=dot` green when editing
message scheduling or composer submit behavior.

Public bot-store cards must render bot metadata, verification/category/tags,
rating/install counts, install action state, disabled state, and image fallback.
Keep `npm run test:unit -- BotStoreCard.test.tsx --reporter=dot` green when
editing public bot-store browsing cards.

Developer bot-store metrics and app creation must keep labeled/trimming create
controls, API error details, refresh, install counts, active guilds, review
summary, event buckets, and metrics-failure fallback rendering working. Keep
`npm run test:unit -- DeveloperPage.metrics.test.tsx --reporter=dot` green when
editing developer portal app creation or metrics.

Custom CSS must not be able to hide, intercept, move, mask, or script app
controls. Keep `npm run test:unit -- security.test.ts --reporter=dot` green
when editing `sanitizeCustomCss` or custom-theme settings.

External links and resource URLs rendered from bot, embed, GIF/sticker,
custom emoji, GitHub webhook, updater, attachment, screen-share thumbnail,
Markdown, ErrorBoundary, or profile data must pass `safeExternalUrl` or
`safeClientResourceUrl` before becoming clickable or loadable. Keep
`npm run test:unit -- security.test.ts markdown.test.ts ErrorBoundary.test.tsx FilePreview.test.tsx ImageLightbox.test.tsx TopBar.pins.test.tsx MessageComponents.test.tsx MessageEmbed.test.tsx GitHubEventEmbed.test.tsx GifPicker.test.tsx StickerPicker.test.tsx customEmoji.test.ts MessageList.anonymous.test.tsx ScreenSharePickerModal.test.tsx BotAuthorizePage.reviews.test.tsx --reporter=dot`
green when editing link buttons, OAuth redirects, Markdown autolinks, embeds,
GIF/sticker pickers, GitHub webhook cards, attachment previews/downloads, image
lightboxes, pinned-message avatars, custom emoji images, message sticker/attachment rendering,
screen-share previews, profile linked accounts, bug-report links, or shared URL
sanitization. `safeClientResourceUrl` should not accept `blob:` strings from
server-controlled fields; local object URLs should stay in local preview code.
Keep
`cargo test -p paracord-api --test coverage_gap_routes
profile_fields_include_pronouns_and_linked_accounts -- --quiet` green when
editing profile linked-account response filtering.

Selected-file image previews and inline attachment previews must use the shared
safe raster-image MIME allowlist rather than broad `image/*`. Keep
`npm run test:unit -- FileUpload.test.tsx FilePreview.test.tsx MessageInput.test.tsx security.test.ts --reporter=dot`
green when editing composer attachments, drag/drop file upload, or attachment
preview rendering.

React UI must use the app confirmation dialog for destructive confirmations,
not native browser `confirm("...")` prompts. Keep
`npm run test:a11y:static` green when editing dialogs or confirmation flows.

The channel rail uses ARIA tree semantics. Keep the Playwright smoke's
ArrowUp/ArrowDown channel-tree checks green when editing channel grouping,
category collapse, or channel navigation behavior.

Keep `docs/release-empty-loading-error-inventory.md` current when adding or
changing a route-level page. Before release, run a manual visual pass against
the inventory with empty datasets, failed network calls, and long names.

```bash
cd packages/paracord-bot-sdk
npm ci
npm audit --audit-level=moderate
npm run build
npm test
node ./tests-node/sdk.test.mjs
node --check ./tests-node/sdk.test.mjs
npm pack --dry-run
```

## Release Binary Smoke

Build the production client first so the server embeds current UI assets:

```bash
cd client
npm run build
cd ..
cargo build --release --bin paracord-server
python scripts/release_embedded_ui_smoke.py --port 18142
```

Then run the release-binary smoke scripts:

```bash
python scripts/release_product_smoke.py --port 18124
node client/scripts/release-real-ui-smoke.mjs --port 18152
python scripts/release_security_smoke.py --port 18109 --fuzz-iterations 120
python scripts/release_log_leak_smoke.py --port 18111
python scripts/release_load_smoke.py --port 18110 --messages 5000 --max-page-seconds 2.0 --voice-participants 4
python scripts/release_restart_smoke.py --port 18116
python scripts/release_graceful_shutdown_smoke.py --port 18126
python scripts/release_ws_pre_auth_capacity_smoke.py --port 18127 --max-connections 3 --connections 5
python scripts/release_gateway_resume_smoke.py --port 18139
python scripts/release_invite_abuse_smoke.py --port 18128
python scripts/release_poll_emoji_smoke.py --port 18129
python scripts/release_discovery_smoke.py --port 18130
python scripts/release_onboarding_smoke.py --port 18131
python scripts/release_moderation_templates_smoke.py --port 18132
python scripts/release_bot_store_smoke.py --port 18133
python scripts/release_economy_smoke.py --port 18134
python scripts/release_channel_features_smoke.py --port 18135
python scripts/release_template_safety_smoke.py --port 18136
python scripts/release_scheduled_events_lifecycle_smoke.py --port 18138
python scripts/release_sqlite_upgrade_from_tag_smoke.py v0.9.0
python scripts/release_sqlite_query_plan_smoke.py
python scripts/federation_e2e_validation.py
python scripts/federation_live_fundamentals_validation.py
node --check client/scripts/a11y-static-audit.mjs
node --check client/scripts/capture-release-screenshots.mjs
node --check client/scripts/contrast-audit.mjs
node --check client/scripts/release-real-ui-smoke.mjs
```

Expected outputs include:

- `PASS: release server product API smoke passed`
- `PASS: release real-browser UI smoke passed`
- `PASS: release server security smoke passed`
- `PASS: release server log leak smoke passed`
- `PASS: release server chat and native voice load smoke passed`
- `PASS: release server restart persistence smoke passed`
- `PASS: release server graceful shutdown smoke passed`
- `PASS: pre-auth websocket capacity enforced`
- `PASS: release gateway resume/replay smoke passed`
- `PASS: invite bounds and max-use exhaustion controls are enforced`
- `PASS: release poll voted flags and static/animated custom emoji upload/list/image/delete work`
- `PASS: public discovery is private-by-default, publishable, searchable, taggable, and removable`
- `PASS: onboarding malformed payloads, rule gate, role assignment, and re-entry work`
- `PASS: moderation templates validate inputs, enforce permissions, time out members, and write audit logs`
- `PASS: bot store search, reviews, review validation, owner-only metrics, install metrics, and uninstall metrics work`
- `PASS: economy XP, cooldown anti-spam, achievements, leaderboard, and level roles work`
- `PASS: anonymous posting, deanonymize permissions, disappearing cleanup, adaptive slowmode, and thread slowmode work`
- `PASS: guild template application rejects malicious stored data without partial guilds and applies safe data`
- `PASS release scheduled events lifecycle smoke`
- `[sqlite-upgrade-from-tag] OK: 34 migrations from v0.9.0; 31 current migrations applied; 65 total ledger rows.`
- `PASS: SQLite query-plan smoke validated 14 hot-path indexes`
- `[postgres-upgrade-from-tag] OK: 35 migrations from v0.9.0; 31 current migrations applied; 66 total ledger rows.`
- `test result: ok` from `cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture`
- `Release line-ending attributes verified for 173 files: text eol=lf with no CR bytes.`
- `PASS: 3-node federation/decentralization validation succeeded.`
- `PASS: Live decentralized fundamentals validation succeeded.`
- `PASS: Cross-node federation propagation verified (A-origin events reached C).`

When running the separate Docker PostgreSQL backup/restore drill, expected
outputs include:

- `Backup script produced: /tmp/backups/paracord-<timestamp>.dump`
- `Restored value: before-backup`

Client desktop diagnostics must redact troubleshooting payloads before writing
local logs. Keep
`npm run test:unit -- desktopDiagnostics.test.ts --reporter=dot` green when
editing `desktopDiagnostics.ts`, voice/gateway diagnostics, or diagnostic
serialization. Treat any output containing JWT secrets, bearer tokens, webhook
tokens, passwords, media tokens, session IDs, or token-bearing query parameters
as a release blocker.

API timing/error logs must redact request labels before writing URLs to the
console. Keep `npm run test:unit -- client.test.ts --reporter=dot` green when
editing `client/src/api/client.ts`, webhook execution routes, interaction
callback/followup routes, or API logging. Webhook tokens and interaction tokens
in path segments are secrets, not harmless IDs.

Native media tokens must stay bound to short-lived JWT validity plus revocable
voice-state membership. Keep `cargo test -p paracord-transport
expired_media_claims_are_rejected -- --quiet`, `cargo test -p paracord-server
resolve_active_media_room -- --quiet`, and `cargo test -p paracord-api --test
voice_routes -- --quiet` green when editing native media token generation,
WebTransport/raw-QUIC auth, guild voice, or DM voice routes.

Operator scripts must not print database credentials. When editing
`scripts/backup-db.sh` or `scripts/restore-db.sh`, run the containerized
syntax check and a mocked `PARACORD_DATABASE_URL` smoke that includes a
password; the displayed database URL must mask the password as `***`.

Guild webhook settings must preserve concrete error details for webhook URL
copy, webhook refresh, and test execution failures. Keep
`npm run test:unit -- GuildSettings.error.test.ts --reporter=dot` green when
editing Guild Settings webhook actions or shared error formatting.

## Packaging Checks

On Windows, set the static libvpx paths before building the Tauri MSI:

```powershell
$vpxRoot = Resolve-Path .\tmp-vcpkg\installed\x64-windows-static
$env:VPX_LIB_DIR = Join-Path $vpxRoot "lib"
$env:VPX_INCLUDE_DIR = Join-Path $vpxRoot "include"
$env:VPX_VERSION = "1.16.0"
$env:VPX_STATIC = "1"
cd client
npm run tauri -- build --bundles msi
cd ..
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" /DAppVersion=0.9.0 installer\paracord-client.iss
```

Expected Windows artifacts:

- `target/release/bundle/msi/Paracord_0.9.0_x64_en-US.msi`
- `installer/output/Paracord-Setup-0.9.0.exe`

Docker Compose config should parse:

```bash
docker compose config
```

## External Gates

These are not satisfied by local Windows smoke tests:

- GitHub Actions must pass on the final branch.
- Docker image build must pass in GitHub Actions on the final branch. Local
  Docker Desktop validation passed with
  `docker build -t paracord:release-readiness-smoke .` plus a container
  `/health` smoke.
- Fresh PostgreSQL migrations, PostgreSQL query-plan smoke, and the API
  PostgreSQL route smoke must run in GitHub Actions on the final branch. Local
  Docker PostgreSQL 16 validation passed with:
  `cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture`
  and `cargo test -p paracord-api --test postgres_route_smoke -- --nocapture`
  with `PARACORD_TEST_POSTGRES_URL` set. Local Docker PostgreSQL 16
  query-plan validation also passed with
  `cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture`,
  verifying 16 intended hot-path indexes are usable. A local Docker PostgreSQL 16
  backup/restore drill also passed by dumping a populated source database,
  restoring into a fresh database, and rerunning both PostgreSQL smoke tests
  against the restored database.
- Upgrade validation must run against a real released v0.9.0 user database
  snapshot. `scripts/release_sqlite_upgrade_from_tag_smoke.py` and
  `scripts/release_postgres_upgrade_from_tag_smoke.py` validate tag-schema
  paths only.
- Linux desktop packages must build and smoke on Linux.
- Clean-machine install, launch, update, and uninstall must be tested.
- Signed updater artifact generation must be verified in the release workflow.
- Real multi-client media must be tested: native media voice, LiveKit fallback,
  screen share, stream viewing, reconnect, and packet loss behavior.
- Release owner must review `docs/release-risk-waivers.md`.
- Release owner must approve final working-tree scope and commit split.

Do not tag a release while any external gate above is missing unless it is
explicitly documented as unsupported for that release.
