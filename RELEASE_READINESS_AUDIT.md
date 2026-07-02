# Paracord Release Readiness Audit

Date: 2026-05-18

## Current Status

Do not publish a GitHub release yet. The local build, test, audit, packaging, and a real server smoke pass are now substantially stronger, but GitHub CI has not run on these exact changes, Linux packaging has not been locally verified, and several clean-machine/manual product checks remain.

For a one-by-one mapping from the original `goal.txt` checklist to current status, evidence, and gaps, see `RELEASE_CHECKLIST_STATUS.md`.

For the repeatable command set used to regenerate release evidence, see `docs/release-validation.md`.

## Evidence Captured

### Rust

- `cargo fmt --all -- --check`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo check --workspace`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo check --workspace --no-default-features`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo clippy --workspace -- -D warnings`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo test --workspace`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo test --workspace --all-targets`: PASS, rerun on 2026-05-18 after the latest client/profile feedback hardening.
- `cargo test -p paracord-core`: PASS, 30 tests.
- `cargo check -p paracord-media --features s3`: PASS
- `cargo test -p paracord-media --features s3 -- s3_ --quiet`: PASS after making AWS credential-chain discovery opt-in for S3-compatible storage.
- `cargo check -p paracord-server --features s3`: PASS after adding server feature forwarding for the optional S3-compatible storage backend.
- `cargo clippy -p paracord-server --features s3 -- -D warnings`: PASS.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security-audit.yml .github/workflows/security-dast-fuzz.yml`: PASS after replacing fragile release-artifact glob expansion with `compgen -G` and fixing a `security-dast-fuzz.yml` shellcheck warning for an unused health-wait loop variable; CI now runs the same digest-pinned workflow lint in the migration/feature sanity job.
- `cargo test -p paracord-server config::tests -- --quiet`: PASS after adding regression coverage that default storage remains local and S3 env vars do not select S3 without an explicit storage-type override.
- `python scripts\check_release_version.py`: PASS, release metadata and docs versions match `0.9.0`.
- `python scripts\check_release_version.py v0.9.0`: PASS, release tag version `0.9.0` matches Cargo, npm, Tauri, README, and release notes.
- `python scripts\check_python_syntax.py`: PASS, parsed 33 scripts without creating bytecode cache files.
- `node --check client\scripts\a11y-static-audit.mjs`, `node --check client\scripts\capture-release-screenshots.mjs`, `node --check client\scripts\contrast-audit.mjs`, and `node --check client\scripts\release-real-ui-smoke.mjs`: PASS.
- `node --check packages\paracord-bot-sdk\tests-node\sdk.test.mjs`: PASS.
- `cargo test -p paracord-server reserves_api_and_realtime_paths_from_spa_fallback -- --quiet`: PASS after preventing the embedded SPA fallback from returning HTML for reserved API/realtime paths.
- `cargo test -p paracord-server config`: PASS after changing federation to opt-in by default.
- `cargo check -p paracord-server`: PASS after Docker/federation config edits.
- `cargo check -p paracord-api`: PASS after generated OpenAPI auth metadata updates.
- `cargo check -p paracord-server`: PASS after adding Windows Ctrl-Break graceful shutdown handling.
- `cargo test -p paracord-api routes::docs`: PASS for generated OpenAPI public/protected auth metadata.
- `cargo test -p paracord-api --test phase6_feature_routes`: PASS, covers stickers, scheduled events recurrence/reminders/iCal, nullable scheduled-event field clearing plus `entity_type` updates, bot store reviews/metrics, and onboarding.
- `cargo test -p paracord-api --test coverage_gap_routes`: PASS, 23 tests covering scheduled messages, group sender keys, guild template safety, moderation templates, economy progression, slowmode/anonymous feature settings, webhooks, group DMs, identity export/import, admin backup filename hardening, admin settings full-response shape, upload-policy active-content downgrades, private custom-emoji image auth with query-token image loading, and related permission denials.
- `cargo test -p paracord-api --test coverage_gap_routes guild_template_apply_rejects_malicious_stored_data_without_partial_guild -- --quiet`: PASS, covers malicious stored guild-template data rejection and no partial guild creation.
- `cargo test -p paracord-api --test security_federation_regressions`: PASS, covers federation token/read protections, CSRF, password-reset completion/session revocation, media-token room membership, discovery, and federation transport regressions.
- `cargo test -p paracord-api federation_guild_allowlist`: PASS, covers default-deny guild federation allowlist behavior, configured IDs, and explicit wildcard opt-in used by local validation scripts.
- `cargo test -p paracord-api opengraph -- --quiet`: PASS, 11 OpenGraph/private-network validation tests, including documentation IP ranges, multicast, metadata aliases, `.local`, and `home.arpa`; response reads now stop at the 512 KiB parse cap.
- `cargo test -p paracord-federation ssrf -- --quiet`: PASS, 27 federation SSRF/private-address/redirect validation tests; federation RPCs, federated discovery, and moderation-list sync now use an SSRF-checked HTTP client with automatic redirects disabled, while federated file downloads perform manual redirects so every hop receives async DNS/private-network validation before request dispatch.
- `cargo test -p paracord-api --test rate_limit_regressions`: PASS.
- `cargo test -p paracord-api --test voice_routes`: PASS, covers native/LiveKit fallback route behavior.
- `cargo test -p paracord-transport expired_media_claims_are_rejected -- --quiet`: PASS, covers expired media JWT rejection with the same HS256 validation path used before native media authentication succeeds.
- `cargo test -p paracord-server resolve_active_media_room -- --quiet`: PASS, covers media accept guard rejection of stale session IDs, claimed-room mismatches, post-leave voice state, and DM voice room scoping.
- `cargo test -p paracord-api --test voice_routes -- --quiet`: PASS after fixing native DM voice to use canonical `0:{channel_id}` room claims, create a revocable DB voice state before issuing a media token, emit targeted recipient-scoped `VOICE_STATE_UPDATE` events on native DM voice join and active leave, keep no-op leaves for other DMs silent, clear that state only when leaving the active DM voice channel, forbid non-member DM voice leave, and preserve the active DM voice state when a different DM is left.
- Native guild/DM voice joins now fail closed if the DB voice-state row cannot be written, and remove the just-created voice-state row when native room admission fails before returning the room-full/internal error.
- `cargo test -p paracord-api --test coverage_gap_routes invite_create_rejects_out_of_range_limits -- --quiet`: PASS after adding invite creation bounds validation for `max_uses` and `max_age`, preserving `0` as the explicit unlimited/never sentinel.
- `cargo test -p paracord-api --test coverage_gap_routes public_guild_invites_are_visible_to_discovery_joiners -- --quiet`: PASS after fixing public discovery join support so private guild invite lists remain manager-only, while authenticated users can retrieve usable invite codes for public guilds and join through the same invite accept path as direct invite links.
- `cargo test -p paracord-api routes::auth::tests::csrf_cookie_is_readable_from_app_routes -- --quiet`: PASS after fixing browser session restore by scoping the CSRF cookie to `/`, allowing app routes such as `/app/templates` to read it and send `X-Paracord-CSRF` on refresh requests.
- `cargo test -p paracord-desktop --lib -- --quiet`: PASS after restricting Tauri's Rust-side `probe_server` and `native_fetch` self-signed TLS paths to loopback or exact trusted server origins; the renderer-facing trusted-server sync command now verifies non-loopback candidates through `/health` before storing them. Tests cover loopback allowance, synced server origin allowance, different-port rejection, untrusted external-host rejection, relative/non-HTTP URL rejection, trusted-origin parsing, and health-URL validation.
- `CARGO_INCREMENTAL=0 CARGO_BUILD_JOBS=1 cargo clippy -p paracord-desktop -- -D warnings`: PASS after the Tauri trusted-origin hardening. A prior local attempt failed before linting because C: had no free space for incremental metadata; deleting generated `target/debug/incremental`, `target/release/incremental`, and `target/tmp` freed about 13 GB, and the non-incremental rerun passed.
- `cd client && npm run test:unit -- InviteModal.test.tsx --reporter=dot`: PASS after fixing the invite modal to send explicit `max_age: 0` for "Never" and `max_uses: 0` for "No limit" instead of omitting those fields.
- `cargo test -p paracord-api --test channel_message_routes`: PASS.
- Added `crates/paracord-api/tests/postgres_route_smoke.rs` so CI can verify real PostgreSQL-backed API flows when `PARACORD_TEST_POSTGRES_URL` is set; coverage now includes users, guilds, channels, messages, scheduled messages, roles, members, invites, group DMs, reactions, webhook token execution, economy XP/leaderboard reads, and multipart attachments. Local Docker PostgreSQL 16 validation now passes from a freshly reset schema and after `pg_dump`/`pg_restore` into a fresh database.
- `cargo test -p paracord-api --test bot_system_routes`: PASS, including interaction-response, original-response edit, and followup component persistence through channel message history.
- `cargo test -p paracord-db -- --quiet`: PASS, 137 tests after adding persisted message component reads/writes to the shared message row layer.
- `cargo test -p paracord-core sqlite_backup_restore_round_trip_includes_media -- --nocapture`: PASS, covers SQLite backup archive creation, backup listing, DB restore, media restore, and pre-restore DB copy.
- Local Docker PostgreSQL 16 backup/restore drill: PASS, covers source migration smoke, PostgreSQL API route smoke, custom-format `pg_dump`, restore into a fresh database, restored row-count sanity checks, and migration/API route smoke against the restored database.
- `cargo audit`: PASS on the latest tree with no unignored vulnerability failures; it still reports 23 allowed upstream unmaintained/unsound warnings documented in `docs/release-risk-waivers.md`.
- `cargo audit -D warnings`: EXPECTED FAIL until the release owner accepts or resolves the 23 documented warning waivers.
- `git diff --check`: PASS after removing one trailing blank line in `client/src/components/ErrorBoundary.tsx`. The release-critical scoped diff check for workflows, migrations, release scripts, and release docs is warning-free after normalizing/pinning GitHub workflow YAML and release-script line endings; the full dirty worktree can still print non-failing `core.autocrlf` conversion warnings for non-pinned source/doc files.

Notes:
- Vendored `third_party/scap` now checks cleanly after warning-only cleanup, with `cargo check -p scap` and `cargo test -p scap` passing.
- Windows test runs used reduced debug info/linker pressure:
  - `CARGO_PROFILE_TEST_DEBUG=0`
  - `CARGO_BUILD_JOBS=1`
  - `RUSTFLAGS=-C debuginfo=0`

### Client

- `cd client && npm audit --audit-level=moderate`: PASS on the latest tree, 0 vulnerabilities.
- `cd client && npm run typecheck`: PASS, rerun after the admin backup/security UI smoke expansion.
- `cd client && npm run test:a11y:static`: PASS after adding explicit accessible names to flagged icon-only controls, requiring icon-only buttons to use `aria-label`/`aria-labelledby` rather than `title`, failing title-only `icon-btn`/`command-icon-btn`/`hover-action-btn` controls, failing Tooltip-wrapped buttons/role-buttons without explicit names, verifying `role="menu"` elements have explicit names, failing non-interactive clickable elements outside inert backdrop/stop-propagation containers, expanding the static gate to verify `aria-modal` elements have dialog/alertdialog roles, accessible names, focusable `tabIndex={-1}` containers, literal `aria-labelledby` target IDs, and rerunning after the admin security-event pagination/details UI.
- `cd client && npm run test:unit -- --reporter=dot`: PASS after adding UserPanel identity-button accessibility and username-copy failure coverage, UserProfile DM/friend/block/report API error-detail coverage, shared Button default-type coverage, FileUpload accessible upload/remove control plus unsafe-image-MIME fallback coverage, CreateGuildModal create/join/template coverage, RegisterPage password-confirmation/trim/server-list coverage, InviteModal generate/copy failure coverage, InvitePage preview/login/accept coverage, DiscoveryPage concrete load-error retry/join/no-public-invite/join-failure coverage, HomePage dashboard DM success/failure coverage, FriendsPage action feedback/pending-guard/accessibility coverage, GuildChannelList inline channel-create accessibility/success/failure, copy-ID failure feedback, and leave-server failure-feedback coverage, ChannelManager channel admin action and announcement-follow error-detail coverage, ChannelPermissionsEditor overwrite load/save/add error-detail coverage, Sidebar server copy-ID failure feedback, MemberList member copy-ID failure feedback, TopBar pinned-message load/unpin failure feedback plus unsafe/external-avatar fallback coverage, TopBar inbox load-failure feedback coverage, TopBar summary failure alert coverage, TopBar announcement-channel follow/unfollow failure feedback coverage, SearchPanel and global SearchOverlay control/error accessibility coverage, TopBar DM voice-call failure feedback coverage, MessageComponents button/select/entity-load failure feedback and unsafe-link blocking coverage, safe entity-avatar rendering/fallback, MessageEmbed and GitHubEventEmbed unsafe-link plus embed-image coverage, FilePreview unsafe attachment URL and unsafe-image-MIME fallback coverage, ImageLightbox unsafe resource URL blocking, ErrorBoundary bug-report URL fallback, ForumView search/create-post error-detail feedback coverage, scheduled-event calendar URL path-segment encoding plus event load/action error-detail coverage, MessageList reaction/pin failure-feedback plus unsafe sticker and attachment URL fallback coverage, ThreadPanel restore/delete error-detail coverage, CommandPalette modal/focus coverage, CommandBuilder command create/update error-detail and option-control accessibility coverage, DM/group-DM error-state coverage, one-to-one DM E2EE send/locked-key store coverage, account setup/recovery phrase UX/name-trim coverage, account unlock redirect/recovery/import/cooldown/reconnect coverage, LoginPage password-reset/MFA flow coverage, UserSettings profile/settings/MFA error-detail coverage, onboarding gate/settings UI coverage, anonymous/disappearing-message display coverage, slowmode send-error feedback coverage, composer attachment upload plus unsafe-image-MIME fallback coverage, scheduled-message composer schedule-mode/failure/future-time validation coverage, sticker/GIF quick-send API error-detail coverage, gateway RESUMED queue flush/reconnect bookkeeping coverage, sticker/custom-emoji picker/composer-send with retryable sticker-load error-detail coverage, unsafe GIF/sticker URL fallback coverage, custom emoji token-aware image URL coverage, OAuth redirect userinfo blocking, screen-share thumbnail URL safety, economy leaderboard/settings UI coverage, moderation-template create/apply/delete UI coverage, template-gallery browse/create/delete/error coverage, bot review/authorization load and authorization error-detail coverage, public bot-store card and BotStoreSection load/install/add error-detail coverage, developer metrics/create-form accessibility, token-copy failure-detail coverage, developer create-bot API error-detail coverage, guild webhook error-detail coverage, desktop/API log redaction coverage, channel settings gear e2e coverage, admin security-event pagination/details UI coverage, server-root URL coverage for federation admin routes, expanded custom-CSS/external/resource-URL sanitizer coverage, stored image data URL safety for guild icons/banners, profile banners, bot-store icons, entity avatars, and Markdown autolink external-URL gating, 91 files / 513 tests.
- `cd client && npm run test:unit -- Button.test.tsx --reporter=dot`: PASS, 2 tests covering the shared Button defaulting to `type="button"` while preserving explicit `type="submit"` for form submits.
- `cd client && npm run test:unit -- CommandPalette.test.tsx --reporter=dot`: PASS, 2 tests covering Ctrl+K open, dialog role/name/modal metadata, explicit search-field label, initial focus, Tab containment, Escape close, and focus restore.
- `cd client && npm run test:unit -- LoginPage.flow.test.tsx --reporter=dot`: PASS, 4 tests covering password reset request/token submission, mismatched-password blocking, MFA challenge display, MFA code submission, navigation after MFA login, rotated token adoption after public-key attachment during login, and `/users/@me` auth-store refresh before entering the app shell.
- `cd client && npm run test:unit -- RegisterPage.test.tsx --reporter=dot`: PASS, 3 tests covering password-confirmation mismatch blocking, trimmed registration payloads, connected-server persistence, app navigation, and unlocked local public-key attachment.
- `cd client && npm run test:unit -- HomePage.test.tsx --reporter=dot`: PASS, 2 tests covering dashboard online-friend DM open/navigation and visible failure feedback.
- `cd client && npm run test:unit -- FriendsPage.test.tsx --reporter=dot`: PASS, 2 tests covering labeled friend search, inline DM-open failure feedback, trimmed friend-request submission, and duplicate-send prevention while a request is pending.
- `cd client && npm run test:unit -- UserSettings.mfa.test.tsx --reporter=dot`: PASS, 8 tests covering account-settings MFA setup, backup-code display, disable-with-code flow, MFA status/setup/verify/disable failure details, profile-save failure details, and settings-save failure details.
- `cd client && npm run test:unit -- OnboardingSettingsSection.test.tsx GuildOnboardingGate.test.tsx --reporter=dot`: PASS, 4 tests covering malformed member payload tolerance, configured member gate rendering, admin settings load/edit/save, role option filtering/selection, progressive message threshold clamping, save feedback, and load-error feedback.
- `cd client && npm run test:unit -- MessageInput.test.tsx --reporter=dot`: PASS, 16 tests covering composer send/reply/typing behavior, anonymous-channel warning, slowmode/rate-limit send-error feedback, selected-file image preview rendering, unsafe image MIME fallback, attachment upload/send wiring, scheduled-message action labeling, ISO payload wiring, future-time validation before API calls, success reset/toast, and preserving content/date on schedule rejection.
- `cd client && npm run test:unit -- SearchPanel.test.tsx --reporter=dot`: PASS, 2 tests covering labeled message-search/filter controls, named close action, and announced search-unavailable feedback when server search plus fallback recent-message filtering fail.
- `cd client && npm run test:unit -- SearchOverlay.test.tsx --reporter=dot`: PASS, 2 tests covering the global search overlay dialog name, labeled search field, named close action, progress status, and announced search-unavailable feedback when server search plus fallback recent-message filtering fail.
- `cd client && npm run test:unit -- TopBar.dm.test.tsx --reporter=dot`: PASS, 1 test covering user-visible direct-message voice-call join failure feedback.
- `cd client && npm run test:unit -- messageStore.test.ts --reporter=dot`: PASS, 24 tests including one-to-one DM locked-key rejection and encrypted v2 payload construction before API send.
- `cd client && npm run test:unit -- AccountRecovery.flow.test.tsx --reporter=dot`: PASS, 4 tests covering local identity creation into recovery-phrase display, acknowledgement-gated continue, trimmed local identity and recovery names, invalid recovery phrase rejection, and valid recovery navigation.
- `cd client && npm run test:unit -- AccountUnlockPage.test.tsx --reporter=dot`: PASS, 4 tests covering no-account redirect, recovery/import navigation, failed-attempt cooldown disabling, and stored-server reconnect after successful unlock.
- `cd client && npm run test:unit -- InvitePage.test.tsx --reporter=dot`: PASS, 3 tests covering invite preview failure feedback, unauthenticated accept routing, and authenticated accept with verification payload, guild insertion, channel fetch/selection, and navigation.
- `cd client && npm run test:unit -- DiscoveryPage.test.tsx --reporter=dot`: PASS, 4 tests covering retryable discovery load failure feedback with concrete API details, public-invite join flow, no-public-invite feedback, public-invite lookup failure feedback with concrete API details, and the accessible back action.
- `cd client && npm run test:unit -- StickerPicker.test.tsx EmojiPicker.serverEmoji.test.tsx MessageInput.sticker.test.tsx EmojisSection.test.tsx --reporter=dot`: PASS, 14 tests covering sticker load/filter/select/retryable error/empty states, unsafe sticker image URL fallback, sticker-only composer send, sticker/GIF quick-send API error details, server custom-emoji load/filter/select plus gateway refresh behavior, and guild settings emoji upload validation/rename/delete/read-only/empty states.
- `cd client && npm run test:unit -- GuildEconomyPanel.test.tsx EconomySettingsSection.test.tsx --reporter=dot`: PASS, 4 tests covering current progress, achievements, leaderboard rendering, economy load-error feedback, level-role mapping load/add/remove/save, filtered assignable roles, and save toast feedback.
- `cd client && npm run test:unit -- ModerationTemplatesSection.test.tsx --reporter=dot`: PASS, 5 tests covering timed-mute template creation/reset, create-disabled state, existing template rendering, target-user apply with optional reason/DM overrides, success feedback, named delete action, and empty state.
- `cd client && npm run test:unit -- TemplateGalleryPage.test.tsx --reporter=dot`: PASS, 5 tests covering template browsing/details, owned-guild template creation, template apply-to-new-server navigation and channel fetch, valid selection after deleting the selected template, owner delete confirmation, concrete apply/create/delete error feedback, and load-error feedback.
- `cd client && npm run test:unit -- CreateGuildModal.template.test.tsx --reporter=dot`: PASS, 4 tests covering create-server create/join/template tabs, template preview, apply-to-new-server navigation/channel selection, invite-code parsing/navigation, and announced template-load error feedback with concrete API details.
- `cd client && npm run test:unit -- BotAuthorizePage.reviews.test.tsx --reporter=dot`: PASS, 5 tests covering review summary/list rendering, review rating/body submission, review refresh, review-error feedback with API details, authorization-detail load errors with API details, bot authorization failure details from the review surface, successful authorization, and userinfo-bearing redirect URL blocking.
- `cd client && npm run test:unit -- BotStoreCard.test.tsx --reporter=dot`: PASS, 4 tests covering public bot-card metadata, verified/category/tag/install-count/rating rendering, install action wiring, disabled install state, adding state, data-URL icon rendering, error fallback, and unresolved icon-hash fallback.
- `cd client && npm run test:unit -- BotStoreSection.test.tsx --reporter=dot`: PASS, 3 tests covering retryable public bot-store load errors with API details, built-in bot install failure details, and public bot add failure details.
- `cd client && npm run test:unit -- DeveloperPage.metrics.test.tsx --reporter=dot`: PASS, 5 tests covering labeled and trimmed create-bot form submission, developer metrics refresh, install/active-guild/review/event-bucket rendering, graceful metrics-load failure, bot-token copy failure details, and create-bot API error details.
- `cd client && npm run test:unit -- CommandBuilder.test.tsx --reporter=dot`: PASS, 3 tests covering command create/update API error details plus accessible option expand and choice removal controls.
- `cd client && npm run test:unit -- desktopDiagnostics.test.ts --reporter=dot`: PASS, 2 tests covering redaction of sensitive diagnostic object keys, bearer tokens, JWT-like tokens, token-bearing query parameters, and Error messages before desktop diagnostics serialization.
- `cd client && npm run test:unit -- client.test.ts --reporter=dot`: PASS, 2 tests covering redaction of webhook token path segments, interaction token path segments, and sensitive query parameters in API timing/error request labels.
- `cd client && npm run test:unit -- GuildSettings.error.test.ts --reporter=dot`: PASS, 3 tests covering Guild Settings API response error details, plain Error details for clipboard/network failures, and fallback text when no detail is available.
- `cd client && npm run test:unit -- ChannelManager.test.tsx --reporter=dot`: PASS, 3 tests covering concrete API error details for channel creation and slowmode failures plus visible announcement-channel follow failure feedback.
- `cd client && npm run test:unit -- ChannelPermissionsEditor.test.tsx --reporter=dot`: PASS, 3 tests covering concrete API error details for overwrite loading, overwrite saving, and role-overwrite creation failures.
- `cargo test -p paracord-api --test coverage_gap_routes profile_fields_include_pronouns_and_linked_accounts -- --quiet`: PASS, covering profile pronouns, linked account output, and filtering of script/userinfo linked-account URLs before profile responses.
- `cd client && npm run test:unit -- ScreenSharePickerModal.test.tsx BotAuthorizePage.reviews.test.tsx MessageEmbed.test.tsx GifPicker.test.tsx StickerPicker.test.tsx MessageList.anonymous.test.tsx security.test.ts --reporter=dot`: PASS, 53 tests covering shared URL filtering, userinfo-bearing OAuth redirect blocking, unsafe message embed image blocking, unsafe GIF URL and invalid-dimension filtering, unsafe sticker image fallback, unsafe message sticker/attachment URL fallback, and unsafe screen-share thumbnail fallback.
- `cargo test -p paracord-api --test coverage_gap_routes custom_emoji_images_require_membership_and_support_query_tokens -- --quiet`: PASS, covering unauthenticated custom-emoji image denial, member token query fallback for browser image loads, `nosniff`, and served PNG bytes.
- `cargo test -p paracord-api middleware::tests -- --quiet`: PASS, including query-token fallback path coverage for guild emoji/sticker image assets only.
- `cd client && npm run test:unit -- customEmoji.test.ts --reporter=dot`: PASS, 2 tests covering custom emoji token parsing/formatting and cross-origin API image URLs with token query fallback.
- `cd client && npm run test:unit -- GuildHub.test.tsx Sidebar.test.tsx --reporter=dot`: PASS, 6 tests covering server context-menu keyboard behavior, unsafe guild banner/icon data URL fallback behavior in guild hub and sidebar surfaces, and scheme-less `host:port` federated server URL rendering without crashing GuildHub.
- `cd client && npm run test:unit -- security.test.ts BotStoreCard.test.tsx MessageComponents.test.tsx GuildWelcomeScreen.test.tsx GuildHub.test.tsx Sidebar.test.tsx DiscoveryPage.test.tsx HomePage.test.tsx --reporter=dot`: PASS, 58 tests covering safe stored image data URL rendering/fallback for guild icons/banners, profile/banner-adjacent shared policy, bot-store icons, entity avatars, and existing URL/resource safety.
- `cd client && npm run test:unit -- markdown.test.ts security.test.ts --reporter=dot`: PASS, 58 tests covering Markdown rendering and the shared URL policy, including safe clickable autolinks and inert credential-bearing autolinks.
- `cd client && npm run test:unit -- ImageLightbox.test.tsx TopBar.pins.test.tsx security.test.ts --reporter=dot`: PASS, 40 tests covering unsafe image lightbox resource blocking, safe same-origin lightbox images, pinned-message failure feedback, and unsafe pinned-author avatar fallback behavior.
- `cd client && npm run test:unit -- security.test.ts TopBar.pins.test.tsx ErrorBoundary.test.tsx --reporter=dot`: PASS, 43 tests covering shared URL policy, pinned-message external-avatar fallback, and safe fallback for configured bug-report URLs.
- `cd client && npm run test:unit -- FileUpload.test.tsx FilePreview.test.tsx MessageInput.test.tsx security.test.ts --reporter=dot`: PASS, 57 tests covering selected-file image previews, attachment previews, composer upload wiring, and unsafe image MIME fallback behavior for SVG-like files.
- `cd client && npm run test:unit -- ForumView.test.tsx --reporter=dot`: PASS, 3 tests covering tag-filter keyboard navigation plus concrete API error details for forum search and post-creation failures.
- `cd client && npm run test:unit -- MessageList.anonymous.test.tsx --reporter=dot`: PASS, 5 tests covering anonymous/expiry indicators, user-visible reaction and pin failure feedback in message history, unsafe sticker image URL fallback, and unsafe image attachment URL fallback.
- `cd client && npm run test:unit -- ThreadPanel.test.tsx --reporter=dot`: PASS, 2 tests covering archived-thread restore and delete failure feedback with concrete API details.
- Added explicit programmatic labels to previously visual-label-only admin federation/storage settings, bot-store configuration controls, command-builder inputs, and economy level-role mapping controls.
- Admin destructive actions now use the app confirmation dialog instead of native browser `confirm()` prompts for user, guild, federation peer, backup delete, and backup restore flows; the static accessibility gate now rejects string-literal `confirm()` calls in React UI.
- Custom-CSS sanitizer tests now cover UI-hiding/interception vectors including display, visibility, opacity, filter, positioning, z-index, pointer-events, transform, clip-path, backdrop-filter, cursor, unsafe URL/script values, import rules, nested media/supports blocks, and legacy binding properties.
- `cd client && npm run test:unit -- useFocusTrap.test.tsx --reporter=dot`: PASS, 4 tests covering initial focus, Tab/Shift+Tab wrapping, Escape close, and focus restore.
- `cd client && npm run test:unit -- ContextMenu.test.tsx --reporter=dot`: PASS, 12 tests covering menu role/rendering, mount focus, Escape close, click activation, disabled item suppression, arrow-key highlighting with `aria-activedescendant`, Enter/Space activation, and disabled/divider skipping.
- `cd client && npm run test:unit -- Sidebar.test.tsx --reporter=dot`: PASS, 3 tests covering server context-menu keyboard open, main-menu Arrow/Home/End focus movement, folder-submenu keyboard focus movement/return, server copy-ID failure feedback, and create-folder dialog semantics/focus-trap close behavior.
- `cd client && npm run test:unit -- FilePreview.test.tsx --reporter=dot`: PASS, 3 tests covering keyboard-open image preview, dialog semantics, initial close-button focus, Escape close, unsafe attachment URL blocking, and unsafe image MIME fallback.
- `cd client && npm run test:unit -- FileUpload.test.tsx --reporter=dot`: PASS, 3 tests covering named upload/remove controls for staged files, hidden input selection forwarding, and unsafe image MIME fallback.
- `docs/release-empty-loading-error-inventory.md`: updated to include CreateGuildModal create/join/template empty/loading/error behavior and current MessageInput inline send/upload/slowmode/sticker/GIF error behavior.
- `cd client && npm run test:unit -- UserPanel.test.tsx --reporter=dot`: PASS, 3 tests covering the named user identity button, username copy action, username-copy failure feedback, and a stable admin dashboard control for admin users.
- `cd client && npm run test:unit -- UserProfile.test.tsx --reporter=dot`: PASS, 4 tests covering profile-popup DM, friend-request, block, and report-submit failure feedback with concrete API details.
- `cd client && npm run test:unit -- MemberList.test.ts --reporter=dot`: PASS, 5 tests covering member status derivation and member copy-ID failure feedback.
- Channel/member copy-ID custom context menus and the server dock context menu now support keyboard open via Shift+F10/ContextMenu, expose menu/menuitem roles with explicit menu labels, focus an action, and close on Escape; the server dock context menu now moves focus with Arrow/Home/End, and its folder submenu opens from keyboard, moves focus with Arrow/Home/End, and closes back to the submenu trigger with Escape/ArrowLeft.
- Modal accessibility hardening now covers admin destructive confirmations, forum tag/new-post dialogs, MessageList create-thread/report-message dialogs, FilePreview image lightbox, CommandPalette, DM picker, channel permissions editor, Sidebar create-folder dialog, and user report/identity verification dialogs with app dialog semantics, focus trap, Escape close, and focus restore where applicable; broader manual screen-reader/focus-order audit remains before release.
- `cd client && npm run build`: PASS on the latest tree after client/profile feedback hardening; entry JS is `assets/index-BXkAOfWY.js` at 341.64 kB and largest JS chunk remains `assets/vendor-livekit-DQ-t7ERF.js` at 437.47 kB.
- `cd client && npm run test:e2e`: PASS after the admin security-event pagination/details UI, gateway RESUMED reconnect fix, and rebuilt production client; Playwright smoke verifies channel-tree ArrowUp/ArrowDown focus movement through visible category and channel treeitems, channel edit gear opening `Server settings` to the `Channels` section with target highlighting, plus non-admin `/app/admin` access-denied guarding without an admin stats request.
- `cd client && npm run test:contrast`: PASS on the latest tree after client/profile feedback hardening, and the GitHub client CI job runs the contrast audit before unit tests.
- `cd client && npm run test:unit -- EventList.test.tsx --reporter=dot`: PASS, 5 tests covering scheduled-event manager edit/start/cancel/delete controls, nullable field clearing, event type submission, regular-member RSVP-only behavior, retryable event-load error details, RSVP/status failure details, and encoded path segments for calendar export URLs.
- `cd client && npm run test:unit -- groupDmE2ee.test.ts --reporter=dot`: PASS, 5 tests covering sender-key envelope distribution, recipient decryption, cached follow-up decryption, local-cache-loss recovery from acknowledged envelopes, missing-envelope denial, membership-change sender-key rotation, and recipient identity-key rotation.
- Real UI smoke against release server + Vite dev proxy: PASS after fixing the client health-contract mismatch. Covered registration, app route entry, nonblank dashboard render, and viewport body checks at 320, 375, 414, 768, 1366, and 1920 widths.
- `docs/release-empty-loading-error-inventory.md` maps every major page and shared surface to current empty/loading/error behavior. Remaining gaps are now explicit: manual visual QA with empty datasets, failed network calls, long names, and real failed DM/group-DM action flows. `cd client && npm run test:unit -- HomePage.test.tsx FriendsPage.test.tsx DMList.test.tsx DMPage.test.tsx DiscoveryPage.test.tsx --reporter=dot` covers the local inline feedback paths for dashboard online-friend DM failure, friend-list DM failure and duplicate friend-request prevention, single-DM create, group-DM create, group-member add/remove failures, no eligible add candidates, and retryable public-discovery load failures.

Notes:
- The Playwright e2e smoke is mocked; it does not prove real backend/client integration.
- Production client bundle is now route/vendor split: after route-level lazy loading and targeted Rollup chunks, latest `cd client && npm run build` passes without Vite chunk-size warnings; entry JS is `assets/index-BXkAOfWY.js` at 341.64 kB and the largest JS chunk is `assets/vendor-livekit-DQ-t7ERF.js` at 437.47 kB.
- The real UI smoke still sees two expected pre-login `401 Unauthorized` refresh probes before registration.

### Bot SDK

- `cd packages/paracord-bot-sdk && npm audit --audit-level=moderate`: PASS on the latest tree, 0 vulnerabilities.
- `cd packages/paracord-bot-sdk && npm ci`: PASS, 0 vulnerabilities.
- `cd packages/paracord-bot-sdk && npm run build`: PASS on the latest tree.
- `cd packages/paracord-bot-sdk && npm test`: PASS on the latest tree, 4 files / 8 tests.
- `cd packages/paracord-bot-sdk && node .\tests-node\sdk.test.mjs`: PASS on the latest tree, 3 Node tests.
- `cd packages/paracord-bot-sdk && npm pack --dry-run`: PASS on the latest tree, 16 packaged files, 6.3 kB package size.
- `docs/bot-development.md` documents the current create/install/register/invoke/respond flow, interaction callback/followup/original-response endpoints, SDK usage, and default local `8090` URLs.
- `packages/paracord-bot-sdk/README.md` example uses the default local `8090` server port and calls `.build()` on `SlashCommandBuilder`.

Open decision:
- `packages/paracord-bot-sdk/package.json` uses `MIT` while the app workspace points to the root custom source-available `LICENSE`. Confirm whether the SDK is intentionally permissive.

### Migration And Security Scripts

- `python scripts\ci_migration_sanity.py`: PASS on the latest tree after client/profile feedback hardening; applies 65 SQLite migrations and checks 66 PostgreSQL migrations for filename parity plus obvious dialect drift.
- `python scripts\release_sqlite_upgrade_from_tag_smoke.py v0.9.0`: PASS on the latest tree. Builds a temporary SQLite database from the `v0.9.0` tag migrations, validates released migration checksums against the current tree, applies 31 newer current migrations, and verifies 65 SQLx migration ledger rows plus key new tables/columns.
- `python scripts\release_postgres_upgrade_from_tag_smoke.py v0.9.0`: PASS on the latest tree against Docker PostgreSQL 16 on `127.0.0.1:55437`. Destructively resets the disposable database from `PARACORD_TEST_POSTGRES_URL`, builds the PostgreSQL schema from the `v0.9.0` tag migrations, validates released migration checksums against the current tree, applies 31 newer current migrations, and verifies 66 SQLx migration ledger rows plus key new tables/indexes. The disposable container was stopped after validation.
- GitHub migration CI is configured to fetch full tag history and run `python3 scripts/check_release_version.py`, `python3 scripts/validate_release_checklist_status.py`, `python3 scripts/check_migration_line_endings.py`, `python3 scripts/check_python_syntax.py`, `python3 scripts/release_sqlite_upgrade_from_tag_smoke.py v0.9.0`, `python3 scripts/release_sqlite_query_plan_smoke.py`, and the PostgreSQL job's `python3 scripts/release_postgres_upgrade_from_tag_smoke.py v0.9.0`; GitHub CI still must run on the final pushed branch before release.
- `.gitattributes` now pins SQLite/PostgreSQL migration files, release Python/shell scripts, public release docs, and GitHub workflow YAML to LF line endings so SQLx migration checksums, helper-script shebangs, public release doc diffs, and release workflow diffs are not changed by platform checkout settings; `python scripts/check_migration_line_endings.py` verifies 173 release-critical files resolve to `text eol=lf` and contain no CR bytes in the working tree.
- Docker Linux backup/restore script smoke: PASS after LF normalization. A disposable `postgres:16` container ran the actual `scripts/backup-db.sh` and `scripts/restore-db.sh`; the first run exposed `env: 'bash\r': No such file or directory`, then `.gitattributes` and script LF normalization fixed the shebang issue. The rerun backed up a seeded `script_smoke` table, dropped it, restored from `/tmp/backups/paracord-20260517-190046.dump`, and recovered `before-backup`.
- `scripts/setup.sh` release-readiness cleanup: removed mojibake section comments, stopped referencing the nonexistent `docker/docker-compose.yml`, stopped manually applying SQLite migrations through `psql`, documents SQLite/default server-managed migrations, builds client production assets before checking the Rust workspace, and points Docker users at the root `docker compose up -d --build` flow.
- `docker run --rm -v "${PWD}:/work" -w /work bash:5 bash -n scripts/setup.sh scripts/backup-db.sh scripts/restore-db.sh`: PASS. Local `bash` still cannot run because WSL is missing its `ext4.vhdx`, so syntax validation used a disposable Linux container.
- Backup/restore log hygiene: containerized script smokes with mocked `pg_dump`/`pg_restore` and `PARACORD_DATABASE_URL=postgres://alice:secret-password@db.example.com:5432/paracord` print `postgres://alice:***@db.example.com:5432/paracord`, not the secret password.
- LiveKit proxy token-validation failures no longer log token length, secret length, or API-key length metadata; a focused source scan for the old length-field labels now returns no source matches.
- `cargo test -p paracord-api livekit_proxy::tests -- --quiet`: PASS, covers LiveKit proxy log-label sanitization for request URI query values, backend target query strings, embedded backend target URLs in HTTP forwarding errors, and construction of the hardened HTTP proxy client with explicit timeout and redirects disabled.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55436/paracord_test cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture`: PASS on the latest tree against Docker PostgreSQL 16. Applies PostgreSQL migrations, seeds/analyzes representative member rows for deterministic prefix-search planning, runs deterministic `EXPLAIN` checks with sequential scans disabled, and verifies 16 intended hot-path indexes are usable for message pagination, attachment hydration, scheduled workers, login lookups, bot reviews/metrics, group E2EE sender-key lookup, slowmode lookup, full-text search, member nick prefix search, pending attachment cleanup, bot guild installs, and forum thread listing. This smoke is now wired into the GitHub PostgreSQL CI job, but GitHub still must run it on the final pushed branch. Validation found and fixed query-plan drift: bot reviews now have an index matching the real `ORDER BY updated_at DESC, id DESC` query, and additional hot-path indexes were added in `20260304000003_hot_path_perf_indexes.sql`.
- `python scripts\security_gate_check.py`: PASS on the latest tree after client/profile feedback hardening; reads the public `docs/security-release-gate.md` file and reports all 10 P0 tasks are DONE. The private local security tracker remains a fallback only.
- `python scripts\validate_release_checklist_status.py`: PASS, structurally covers 13 sections, 149 source goal bullets, and 155 status entries: 96 DONE, 49 PARTIAL, 8 BLOCKED, 2 OWNER, 0 TODO; the verifier now also fails if the `RELEASE_CHECKLIST_STATUS.md` structural-summary line is stale or mismatched.
- `python scripts\release_security_smoke.py --port 18109 --fuzz-iterations 120`: PASS on the latest tree against a rebuilt `target\release\paracord-server.exe` instance. Starts a temporary SQLite-backed release server, runs DAST checks, and runs the auth API fuzz smoke without leaving server logs in an undrained pipe.
- `python scripts\security_dast_smoke.py --base-url <release-server>`: PASS through the release-security wrapper. Covered security headers, auth-required admin route, CORS non-wildcard behavior, LiveKit proxy deny path, encoded traversal rejection, and auth challenge shape.
- `python scripts\security_api_fuzz.py --base-url <release-server> --iterations 120`: PASS through the release-security wrapper, no 5xx responses.
- `python scripts\release_log_leak_smoke.py --port 18111`: PASS on the latest tree against a rebuilt `target\release\paracord-server.exe` instance, with `startup_health_seconds=5.03` and `log_bytes=4358`. The smoke forces Tenor through an unreachable local HTTPS proxy and confirms the captured log does not contain the sample JWT secret, password, bearer token, webhook token, GitHub webhook secret, or fake Tenor API key.
- `python scripts\release_load_smoke.py --port 18110 --messages 5000 --max-page-seconds 2.0 --voice-participants 4`: PASS on the latest tree against a rebuilt `target\release\paracord-server.exe` instance after fixing the smoke harness to reuse HTTP connections without carrying cookies across synthetic users. Sent 5000 messages in 48.973s with 35 rate-limit retries, paged latest messages in 0.025s, paged before the first message in 0.001s, joined four native-voice participants, started/stopped a native stream, and recorded RSS from 27,832,320 bytes idle to 33,398,784 bytes after the voice phase.
- `node client/scripts/release-real-ui-smoke.mjs --port 18152`: PASS on the latest tree against the rebuilt release server after client/profile feedback hardening and CSRF session-restore fixes. Logs in through Chromium, hard-loads `/app/templates` to verify browser session restore on an authenticated route, navigates through the real app shell to a seeded guild/channel, sends a message, uploads a PNG through the composer, verifies the image attachment in message history, opens the shared image viewer, closes it with Escape, creates a guild template from the Template Gallery, previews it, creates a new guild from it, verifies template usage count through the API, searches public discovery, filters by Technology, joins a separately owned public guild through its public invite, opens/closes the channel settings dialog, opens the admin dashboard, verifies no document-level horizontal overflow across the visited admin tabs, deletes a disposable user and guild through confirmation dialogs, adds/inspects/removes a federated peer through the admin UI, edits every visible admin settings field, verifies persisted settings through the API and after remounting the settings panel, creates/downloads/restores/deletes a backup, verifies security-event Next/Previous pagination, exact-action filtering for backup create/restore/delete events, details expansion for backup-create metadata, and fails on page errors.
- `python scripts\federation_e2e_validation.py`: PASS after fixing local script env setup and federation relay behavior. Covers three local nodes, trust setup, message create/edit/delete, reaction add/remove, member join/leave, and A-to-B-to-C relay without a direct A-to-C peer.

Local PostgreSQL migration execution now has real Docker-backed evidence:
- `psql`, `pg_isready`, `initdb`, and `postgres` are still not available on the Windows PATH, and no local PostgreSQL Windows service was found.
- Docker Desktop is now usable; latest fresh PostgreSQL validation used disposable Docker PostgreSQL 16 containers on `127.0.0.1:55436` for migration/query-plan/API route checks and `127.0.0.1:55437` for synthetic upgrade-from-tag validation.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55436/paracord_test cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture`: PASS on the latest tree against a fresh disposable Docker PostgreSQL 16 container.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55436/paracord_test cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture`: PASS on the latest tree against the same disposable container.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55438/paracord_test cargo test -p paracord-api --test postgres_route_smoke -- --nocapture`: PASS on the latest tree against a fresh disposable Docker PostgreSQL 16 container after expanding coverage to scheduled messages, group DMs, webhooks, and economy XP/leaderboard behavior. This run found and fixed PostgreSQL group DM recipient insertion (`INSERT OR IGNORE` -> portable conflict handling), PostgreSQL `user_xp.last_xp_at` text/timestamp binding and projection, and no-nonce message side-effect gating for XP/dispatch/thread counters.

Upgrade note:
- The SQLite and PostgreSQL upgrade evidence is synthetic tag-schema validation, not a real production/user database snapshot. Representative released `v0.9.0` database snapshots are still required before this item should be considered release-grade.

### Packaging

- `cargo build --release --bin paracord-server`: PASS after the latest production client build so embedded UI is current.
- `cargo build --release --bin paracord-server`: PASS after the latest client build.
- `python scripts/release_embedded_ui_smoke.py --port 18142`: PASS. `GET /` from the rebuilt release server returned HTML with `id="root"`, current `assets/index-BXkAOfWY.js`, hashed JS assets, and no blocked inline service-worker cleanup script.
- `cd client && npm run tauri -- build --bundles msi`: PASS on 2026-05-18 after latest client/app changes with `VPX_LIB_DIR`, `VPX_INCLUDE_DIR`, `VPX_VERSION=1.16.0`, and `VPX_STATIC=1` set to the local static vcpkg libvpx install. The build recompiles `env-libvpx-sys`, `vpx-encode`, `paracord-codec`, and `paracord-desktop`, then produces `target\release\bundle\msi\Paracord_0.9.0_x64_en-US.msi` (9,076,736 bytes) with no `.app` bundle-id warning.
- Inno Setup build: PASS on 2026-05-18 after latest Tauri rebuild, produced `installer\output\Paracord-Setup-0.9.0.exe` (9,349,685 bytes) with Inno Setup 6.4.2.
- `docker compose config`: PASS on the latest tree after pinning the optional LiveKit service image to `livekit/livekit-server:v1.9.11`, matching the release workflow's bundled LiveKit version instead of the mutable `latest` tag.
- `docker build -t paracord:release-readiness-smoke .`: PASS on the latest tree. Built the Linux server image with current client production assets embedded.
- Docker container startup smoke: PASS on the latest tree. `docker run -d --rm --name paracord-docker-smoke-20260518 -p 18150:8090 ... paracord:release-readiness-smoke` answered `/health` with `service=paracord status=ok`; `docker stop paracord-docker-smoke-20260518` cleaned it up.
- Docker embedded UI smoke: PASS on the latest image. `paracord-docker-ui-smoke-20260518` served embedded HTML with `id="root"` and hashed `/assets/index-B3p8LFcE.js`; `docker stop paracord-docker-ui-smoke-20260518` cleaned it up.
- Docker Compose stack smoke: PASS after replacing placeholder `devkey/devsecret` with non-placeholder local LiveKit credentials in `docker-compose.yml` and docs. `docker compose up -d --build` starts both `paracord` and `paracord-livekit`; Paracord applies migrations, logs `LiveKit admin API health check passed`, answers `GET /health` with `{"service":"paracord","status":"ok"}`, and `docker compose down --volumes --remove-orphans` cleans the smoke stack and volume.

Not yet verified:
- Linux AppImage/deb build locally or in CI. Local WSL is not usable for this pass: `wsl -d Ubuntu` fails with `Wsl/Service/CreateInstance/MountDisk/HCS/ERROR_FILE_NOT_FOUND` because the distro `ext4.vhdx` is missing.
- Clean-machine install, launch, update, and uninstall.
- Signed updater artifact generation in GitHub Actions.

### Real Server Smoke

Release server binary smoke against a throwaway SQLite data dir: PASS again after the federation default change.

Covered:
- `/health`
- `/api/v1/auth/options`
- first human registration
- first human admin promotion
- `/api/v1/admin/stats`
- guild creation
- channel creation
- message send
- message list

Current smoke output:
- `health = ok`
- `adminStats = true`
- `guildId = 314129762085769216`
- `channelId = 314129762106740736`
- `messageCreated = true`
- `messagesListed = true`

Extended release-server product API smoke: PASS against `target\release\paracord-server.exe`.

- `cargo check -p paracord-api`: PASS after tightening template-apply name validation.
- `cargo build --release --bin paracord-server`: PASS after tightening template-apply name validation.
- `cargo check -p paracord-api`: PASS after validating stored template role/channel data before application.
- `cargo build --release --bin paracord-server`: PASS after stored template-data validation.
- `python scripts\release_template_safety_smoke.py --port 18136`: PASS. Seeds safe and malicious template rows into a temporary SQLite-backed release server, verifies invalid JSON, unsafe role names, invalid role permissions, unsafe channel names, and invalid channel types are rejected without creating partial guilds, then verifies a safe stored template applies roles/channels and increments usage count.
- `cargo check -p paracord-server`: PASS after scheduled-event validation/worker cleanup hardening.
- `cargo build --release --bin paracord-server`: PASS after scheduled-event validation/worker cleanup hardening.
- `cargo build --release --bin paracord-server`: PASS after SQLite voice-state bool normalization for native-media active session resolution.
- `python scripts\release_scheduled_events_lifecycle_smoke.py --port 18138`: PASS. Verifies member permission denials, unsafe event create/update payload rejection, RSVP/iCal, worker reminder/start, auto-created event-channel cleanup on completion, recurring successor creation, cancellation, and deletion against the release binary.
- `python scripts\release_product_smoke.py --port 18124`: PASS on the latest tree after client/profile feedback hardening and production-client rebuild; covers admin stats/settings, auth session refresh/login/logout revocation, password-reset safety, MFA setup/login/disable, template create/list/apply/delete, unsafe-name rejection, Paracord forum-channel template apply, disappearing-message workers, scheduled-message live delivery, scheduled-event workers, bot creation/OAuth/install/command/callback/followup/component/remove, E2EE DM APIs, native-media voice join/leave, and native stream start/stop.
- `cargo test -p paracord-api --test security_federation_regressions password_reset_completion_updates_password_revokes_sessions_and_consumes_token -- --quiet`: PASS. Verifies valid password reset completion, one-time reset token use, old-session revocation, old-password rejection, and new-password login.
- `python scripts\release_restart_smoke.py --port 18116`: PASS on the latest tree; creates durable guild/channel/message state, schedules a pending message, stops and restarts the release server against the same SQLite database, verifies pre-restart message visibility with the existing access token, refreshes the persisted session, sends a post-restart message, and verifies the restarted scheduled-message worker delivers the pending message.
- `python scripts\release_graceful_shutdown_smoke.py --port 18126`: PASS on the latest tree; starts the rebuilt release binary, reaches `/health` in 2.53 seconds, sends Windows Ctrl-Break to the process group, verifies the graceful shutdown log line, and observes return code 0 without forced kill.
- `python scripts\release_gateway_resume_smoke.py --port 18139`: PASS on the latest tree; starts the release binary, connects to `/gateway`, receives READY, creates a live message, verifies the MESSAGE_CREATE dispatch, reconnects with the same gateway session and the older READY sequence, verifies RESUMED plus replay of the buffered message event, and confirms an unknown resume session falls back to fresh READY instead of getting stuck.
- `cd client && npm run test:unit -- connectionManager.test.ts --reporter=dot`: PASS. Verifies the client treats `RESUMED` as a successful lifecycle event by resetting reconnect attempts and flushing queued outbound presence/voice updates after a same-session gateway resume.

Covered:
- second user registration and non-admin denial from `/api/v1/admin/stats`
- admin settings read/update/reload, runtime/config setting persistence, and non-admin denial from `/api/v1/admin/settings`
- auth session listing, refresh-token rotation, old access-token rejection, password relogin, logout, logged-out access-token rejection, and logged-out refresh-token rejection
- forgot-password existing/missing account response parity, invalid reset-token rejection, valid reset-token completion, one-time reset token use, old-session revocation, old-password rejection, new-password login, MFA setup/status, invalid TOTP rejection, valid TOTP enablement, MFA-required password login, MFA login token issuance, and backup-code disable
- guild creation
- role creation/listing
- text, voice, announcement, and forum channel creation
- guild template create/list/apply/delete plus unsafe `<script>` template-apply name rejection
- stored template-data safety: invalid JSON, unsafe role/channel names, invalid permissions, invalid channel types, no partial guild creation, safe data still applies, and Paracord forum channel type `7` is preserved during apply
- disappearing-message policy update plus background-worker deletion from channel history
- scheduled-event create/update/RSVP/iCal plus background-worker reminder/start/event-channel creation
- scheduled-event lifecycle hardening: non-manager denial, unsafe create/update rejection, auto-created event-channel deletion after completion, recurrence successor creation, cancellation, and deletion
- scheduled-message create/list plus live background-worker delivery into channel history, including pending scheduled-message delivery after server restart
- native media voice join/leave and stream start/stop response shape with a per-run UDP voice port
- channel overwrite create/list
- invite creation, preview, and second-user accept
- member listing includes the invited user
- bot application creation, OAuth guild install, guild bot listing, global/guild command creation, guild command discovery, slash interaction callback, unsafe component URL rejection, component interaction dispatch, followup creation, guild bot removal, and post-removal guild bot listing
- message create, reply, edit, pin/list pins, reaction add/remove, search, unpin, and delete
- image attachment upload, attach-to-message, authenticated download, byte equality, and content type
- thread creation/listing
- forum post creation
- webhook create, execute, edit, delete-message, GitHub HMAC rejection, and GitHub HMAC acceptance
- one-to-one DM creation and group DM creation/recipient listing
- plaintext one-to-one DM rejection, encrypted v2 DM send, encrypted payload metadata, and recipient encrypted DM listing
- release server restart persistence for SQLite state, access tokens, refresh tokens, post-restart message writes, and pending scheduled-message delivery
- release server graceful shutdown via Windows Ctrl-Break, using the same shutdown `Notify` path as other background workers

Current extended smoke output:
- `guild = 314706179945140224`
- `text = 314706180142272512`
- `voice = 314706180205187072`
- `announcement = 314706180213575680`
- `forum = 314706180272295936`
- `role = 314706180008054784`

Current restart smoke output:
- `guild = 314708122138578944`
- `channel = 314708122205687808`
- `message = 314708122272796672`
- `scheduled = 314708122402820096`

README public-claim cleanup:
- README voice/streaming copy no longer claims six presets or 4K/100 Mbps streaming. It now matches the four server presets implemented in `crates/paracord-media/src/streaming.rs`.
- README system-audio copy now calls native system-audio capture platform-specific release-validation work rather than guaranteed production behavior.
- README/config/self-hosting/release-note storage wording now frames S3-compatible object storage as an optional, disabled-by-default backend; local filesystem storage remains the default. S3-compatible storage now requires explicit configured credentials unless the admin opts into AWS SDK credential-chain discovery with `use_aws_credential_chain = true`, and server config tests verify S3 env vars alone do not switch the app away from local storage.
- `docs/release-screenshot-inventory.md` inventories the three public README screenshots and flags them for replacement or owner confirmation before publication.
- `docs/outbound-fetcher-inventory.md` inventories outbound HTTP fetchers and confirms the user/peer-controlled surfaces use private-network/DNS validation plus fail-closed or manually revalidated redirect behavior; fixed vendor and operator-configured integrations are documented separately. OpenGraph link previews now block the same broader reserved/documentation/multicast/local-domain classes covered by the federation URL validators, federation RPC/discovery/moderation fetchers disable automatic redirects, federated discovery streams peer JSON through a 512 KiB response cap, federated file redirects are revalidated with DNS checks at every hop, fixed Tenor/IP-detection calls have explicit short timeouts, Tenor and public-IP detection disable automatic redirects and cap response bodies, public-IP detection validates IP syntax, LiveKit admin/proxy HTTP forwarding has explicit timeouts, redirects disabled, bounded admin response bodies, bounded proxy request/response bodies with the upstream response cap enforced while streaming, AI provider calls validate HTTP(S) credential-free base URLs, disable redirects, and cap streamed JSON responses, and Tenor upstream failures are logged without full request URLs or upstream response bodies that could expose the configured API key.

Client e2e keyboard/route smoke:
- `cd client && npm run test:e2e`: PASS on the latest tree after client/profile feedback hardening, gateway RESUMED reconnect fix, and production-client rebuild; covers keyboard focus/Enter/Space activation checks for text and voice channel tree items, ArrowUp/ArrowDown focus movement through visible category/channel treeitems, command-palette Ctrl+K/input-focus/Escape/filter/Enter-selection coverage, channel edit gear/settings overlay coverage, non-admin `/app/admin` access-denied guard coverage, exact desktop no-overflow coverage at 1366x768, 1440x900, and 1920x1080, page-error capture, lazy-route smoke coverage for `/app`, friends, DMs, discovery, templates, and developer portal, and dark/light/AMOLED/high-contrast theme application checks.

Client bundle split verification:
- `cd client && npm run build`: PASS after splitting route pages with React lazy loading and adding targeted Rollup chunks for React, LiveKit, crypto, icons, animation, code highlighting/sanitization, drag/drop, and Tauri APIs.
- Largest post-split JS chunks: `assets/vendor-livekit-DQ-t7ERF.js` 437.47 kB, `assets/index-BXkAOfWY.js` 341.64 kB, `assets/vendor-react-CfbVQ996.js` 230.87 kB.
- Follow-up checks: `cd client && npm run test:unit -- --reporter=dot` PASS (91 files / 513 tests), `cd client && npm run test:e2e` PASS with lazy-route navigation and page-error capture.

Operational load smoke update:
- `python scripts\release_load_smoke.py --port 18110 --messages 5000 --max-page-seconds 2.0 --voice-participants 4`: PASS on the latest tree after extending the smoke to enable native media, create a voice channel, invite three additional users, join four native-voice sessions, start/stop a native stream, leave each session, and record memory at idle/chat/voice phases.
- Latest measurements: `idle_rss_bytes=27832320`, `loaded_rss_bytes=32821248`, `voice_rss_bytes=33398784`, `page_seconds=0.025`, `before_page_seconds=0.001`, `voice_seconds=0.012`, `send_seconds=48.973`, `rate_limit_retries=35`.
- Remaining gap: this still does not exercise real desktop capture, decoded media playback, or screen-share memory under a receiving client.

Runtime log-leak update:
- `python scripts\release_log_leak_smoke.py --port 18111`: PASS on the latest tree after adding a fake `PARACORD_TENOR_API_KEY` to the release-binary smoke, forcing Tenor through an unreachable local HTTPS proxy, and hitting `/api/v1/tenor/search`; the captured server log did not include the fake Tenor key, JWT secret, password, bearer token, webhook token, or GitHub webhook secret. Latest output: `startup_health_seconds=5.03`, `log_bytes=4358`.

Real browser UI smoke:
- `node client/scripts/release-real-ui-smoke.mjs --port 18152`: PASS on the latest tree after client/profile feedback hardening, embedded SPA fallback hardening, and production-client rebuild. The smoke starts the release server, seeds a real account/guild/channel plus disposable admin targets over HTTP, logs in through Chromium, navigates through the app shell, sends a real message, uploads a PNG through the composer, verifies the attachment renders in message history, opens the shared image viewer, closes it with Escape, opens/closes the channel settings dialog, opens the admin dashboard, checks visited admin tabs for document-level horizontal overflow, deletes a disposable user and guild through confirmation dialogs, adds/inspects/removes a federated peer through the admin UI, edits and verifies every visible admin settings field through UI and API, creates/downloads/restores/deletes a backup, verifies security-event Next/Previous pagination, filters backup create/restore/delete events, expands backup-create details, and fails on uncaught page errors.

Client stream-watching unit smoke:
- `npx vitest run src/components/layout/VoiceParticipants.test.tsx --reporter=dot`: PASS.

Gateway pre-auth capacity smoke:
- `python scripts/release_ws_pre_auth_capacity_smoke.py --port 18127 --max-connections 3 --connections 5`: PASS on the latest tree. The release binary accepted exactly 3 unauthenticated gateway sockets through HELLO and closed the 2 overflow sockets while they were still pre-identify.

Gateway resume/replay smoke:
- `python scripts\release_gateway_resume_smoke.py --port 18139`: PASS on the latest tree. The release binary replayed buffered `MESSAGE_CREATE` event `314708122272796672` after reconnecting session `42b93350-6bd1-4acd-8e41-cceca8f0c655` with an older sequence, and a bogus resume session recovered through fresh `READY`.
- Client follow-up: `cd client && npm run test:unit -- connectionManager.test.ts --reporter=dot` PASS after fixing `RESUMED` handling to flush pending outbound messages and reset reconnect backoff.

SQLite hot-path query-plan smoke:
- `python scripts/release_sqlite_query_plan_smoke.py`: PASS. Applies all SQLite migrations to a fresh database and verifies SQLite uses 14 intended hot-path indexes for message pagination, attachment hydration, scheduled workers, login lookups, bot reviews/metrics, group E2EE sender-key lookup, slowmode lookup, pending attachment cleanup, bot guild installs, and forum thread listing.

PostgreSQL hot-path query-plan smoke:
- Docker PostgreSQL 16 on `127.0.0.1:55436`.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55436/paracord_test cargo test -p paracord-db postgres_query_plan_smoke_when_configured -- --nocapture`: PASS on the latest tree. The test applies PostgreSQL migrations and verifies 16 matching hot-path `EXPLAIN` plans use the intended indexes.

PostgreSQL fresh-schema validation:
- Docker PostgreSQL 16 container on `127.0.0.1:55436`, started as `paracord-postgres-refresh-20260518` and stopped after validation.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55436/paracord_test cargo test -p paracord-db postgres_pool_and_migrations_smoke_when_configured -- --nocapture`: PASS, 1 test.
- `PARACORD_TEST_POSTGRES_URL=postgres://postgres:postgres@127.0.0.1:55438/paracord_test cargo test -p paracord-api --test postgres_route_smoke -- --nocapture`: PASS, 1 test covering users, guilds, channels, messages, scheduled messages, roles, members, invites, group DMs, reactions, webhook token execution, economy XP/leaderboard behavior, and multipart attachment upload/delete on PostgreSQL.
- PostgreSQL backup/restore validation: Docker PostgreSQL 16 on `127.0.0.1:55434` ran source migration smoke and API route smoke, dumped `paracord_source` with custom-format `pg_dump`, restored into `paracord_restore`, confirmed restored row counts (`users=4`, `messages=3`), then reran the migration smoke and API route smoke against the restored database.
- Fixes made while validating: the shared API test helper now generates schema-valid <=32 character usernames for PostgreSQL, the database PostgreSQL migration smoke now uses a unique username so it can run against restored/non-empty databases, the Postgres route smoke expects exhausted single-use invites to return 404, group DM recipient writes now use portable conflict handling, PostgreSQL economy XP writes/readbacks normalize `TIMESTAMPTZ`, and no-nonce message sends reliably run created-message side effects.
- Container cleanup: `docker stop paracord-postgres-smoke-20260517`: PASS.

Invite abuse-control smoke:
- `cargo test -p paracord-db invites -- --quiet`: PASS, including exhausted-invite lookup/list filtering regressions.
- `python scripts/release_invite_abuse_smoke.py --port 18128`: PASS against the release binary. Rejects negative/out-of-range `max_uses` and `max_age`, verifies `0` round-trips as unlimited/never, creates a max-use-one invite, verifies preview before first use, accepts it once, verifies preview is hidden after exhaustion, verifies a second user cannot accept it, verifies invalid invite codes return 404, and verifies exhausted invites no longer appear in the guild invite list.

Live federation and LiveKit fundamentals:
- `python scripts\federation_live_fundamentals_validation.py`: PASS after fixing a federation relay scoping bug and SQLite bool decoding regressions in polls/emojis. Starts three local federation-enabled nodes and the bundled managed LiveKit server, then verifies messages, edit/delete, reactions, member join/leave, threads, polls, custom emoji upload, friends, DMs, user settings, LiveKit voice join, LiveKit stream start/stop response shape, realtime gateway events, and A-origin event propagation to C through B without direct A-to-C trust.
- Regression coverage added: `cargo test -p paracord-db list_room_member_servers -- --quiet`, `cargo test -p paracord-db get_poll_decodes_sqlite_exists_voted_flag -- --quiet`, and `cargo test -p paracord-db create_emoji_decodes_sqlite_returning_animated_flag -- --quiet` all PASS.

Release-binary poll/custom emoji smoke:
- `cargo build --release --bin paracord-server`: PASS after DB fixes.
- `python scripts\release_poll_emoji_smoke.py --port 18129`: PASS against the release binary. Creates a guild/channel, joins a second user via invite, creates a poll, verifies initial `voted=false`, votes/unvotes and verifies the `voted` flag transitions, uploads a PNG custom emoji and a GIF custom emoji, verifies static/animated flags, verifies list membership, downloads the same emoji bytes, and deletes both.
- `cargo test -p paracord-db -- --quiet`: PASS, 136 tests.
- `cargo clippy -p paracord-db -- -D warnings`: PASS.

Release-binary public discovery smoke:
- `cargo build --release --bin paracord-server`: PASS after adding discovery visibility updates and private-by-default guild visibility.
- `python scripts\release_discovery_smoke.py --port 18130`: PASS against the release binary. Verifies new guilds are `private` by default and absent from public discovery, non-members cannot publish a guild, owners can publish with normalized/deduped discovery tags, published guilds appear in default/search/tag discovery queries, owners can unpublish, and invalid tags are rejected.
- `cargo test -p paracord-db test_create_guild_with_valid_data -- --quiet`: PASS, including an assertion that new guild rows are private regardless of stale schema defaults.

Release-binary onboarding edge-case smoke:
- `python scripts\release_onboarding_smoke.py --port 18131`: PASS against the release binary. Verifies malformed onboarding settings are rejected, cross-guild role options are rejected, valid onboarding settings persist, new member onboarding state is initially incomplete, completion without accepting rules is rejected, selecting roles outside configured onboarding options is rejected, valid completion assigns the selected role, and re-entering `/onboarding/me` preserves accepted rules/selected role state.

Current-build screenshots:
- `cd client && npm run screenshots:release`: PASS on the latest tree after building the client. Captures `docs/screenshots/dashboard-current.png` and `docs/screenshots/text-chat-current.png` from Vite preview with sanitized mocked release-preview data.
- PNG verification: both screenshots are 1440x900 and nonblank by pixel sampling (`dashboard-current.png`: 106 sampled colors; `text-chat-current.png`: 50 sampled colors).
- README now embeds `docs/screenshots/text-chat-current.png` and removes the old GitHub-hosted voice/streaming screenshots until real media validation passes.
- `npm run typecheck`: PASS.
- `npm run test:unit -- --reporter=dot`: PASS, 91 files / 513 tests.
- Evidence added: active-stream participant control now exposes `aria-label="Watch ... stream"` and clicking it sets `watchedStreamerId` plus navigates to the voice channel. Real media receive/render remains a manual multi-client gap.

Worktree/commit planning:
- `git status --short --untracked-files=all` still reports hundreds of changed/untracked paths.
- `RELEASE_WORKTREE_CLASSIFICATION.md` was refreshed on 2026-05-18, and a local `git status --short --untracked-files=all` coverage check confirms every current untracked path is explicitly listed or matched by a documented release/internal/generated classification pattern.
- `docs/release-commit-plan.md` defines owner decisions and a proposed nine-commit release split.
- Remaining cleanup/commit work is owner-gated because staging public/internal/discard scope incorrectly would risk publishing private audit artifacts or omitting intended release source.

### Feature Coverage Evidence

Automated route coverage now directly exercises several checklist feature areas:

- Stickers and animated emoji asset flow: `sticker_upload_list_image_and_delete_flow`.
- Scheduled events recurrence/reminders/iCal: `scheduled_events_support_recurrence_reminders_and_ical`.
- Scheduled events release-binary lifecycle: `python scripts\release_scheduled_events_lifecycle_smoke.py --port 18138`.
- Scheduled events client controls: `cd client && npm run test:unit -- EventList.test.tsx --reporter=dot` covers manager edit/start/cancel/delete, nullable field clearing, event type submission, regular-member RSVP-only behavior, retryable event-load error details, RSVP/status failure details, and calendar export URL path-segment encoding.
- Group DM E2EE client sender-key lifecycle: `cd client && npm run test:unit -- groupDmE2ee.test.ts --reporter=dot` covers sender-key envelope distribution, cached recipient decrypt, local-cache-loss recovery from acknowledged envelopes, missing-envelope denial, key rotation when group membership changes so newly added members cannot decrypt earlier messages, and key rotation when a recipient identity public key changes.
- Guild templates: release product smoke, `guild_template_apply_rejects_malicious_stored_data_without_partial_guild`, plus stored template-data safety coverage from `python scripts\release_template_safety_smoke.py --port 18136`.
- Bot store metrics/reviews: `bot_store_reviews_and_metrics_track_installs`, plus release-binary store/review/metrics abuse coverage from `python scripts\release_bot_store_smoke.py --port 18133`.
- Onboarding rules and role selection: `onboarding_flow_enforces_rules_and_assigns_selected_roles`.
- Scheduled messages create/list/cancel: `scheduled_messages_create_list_and_cancel`.
- Moderation templates create/apply/delete and timed mute: `moderation_templates_can_be_created_applied_and_deleted`, `moderation_templates_apply_timed_mute`, plus release-binary audit coverage from `python scripts\release_moderation_templates_smoke.py --port 18132`.
- Economy/progression XP and level roles: `economy_progression_awards_xp_and_assigns_level_roles`, plus release-binary cooldown/leaderboard/level-role evidence from `python scripts\release_economy_smoke.py --port 18134`.
- Group E2EE sender key post/get/ack/recovery: `group_sender_keys_post_get_and_ack`.
- Anonymous posting and slowmode/adaptive slowmode route enforcement: `channel_feature_settings_anonymous_and_thread_slowmode_enforced`, plus release-binary anonymous/deanonymize/disappearing/adaptive-slowmode evidence from `python scripts\release_channel_features_smoke.py --port 18135`.
- Webhooks including token execution and Discord-compatible edit/delete: `webhook_execution_creates_message_via_token_route`, `webhook_discord_compat_supports_embeds_edit_and_delete`.

Remaining manual feature evidence is still required for real multi-client UI/media behavior, especially native media, desktop capture/screen share, decoded stream viewing, keyboard/mobile UX, and externally deployed federation staging.

Bug found and fixed during smoke:
- Startup-created system bot users prevented the first real user from becoming admin.
- Fix: first-admin detection now ignores negative-ID system users, bot accounts, and federated placeholder users.
- Regression test added: `test_create_user_as_first_admin_ignores_system_bots`.
- Guild template application rejected templates containing Paracord forum channels because the allow-list used stale type `15` while `ChannelType::Forum` is `7`.
- Fix: template validation now derives allowed channel types from the Paracord `ChannelType` enum and the route regression verifies forum type `7` survives template apply.
- Client route guard expected `/health` to return `{ service: "paracord" }`, while the real server returns `{ status: "ok" }`. Fix: accept either shape and update the mocked e2e health response to the real contract.
- `client/index.html` had an inline service-worker cleanup script blocked by its own CSP. Fix: removed the duplicate inline script; equivalent cleanup already runs from `src/main.tsx`.

### CI And Release Workflow

Fixed:
- `Cargo.lock` is no longer ignored and should be committed with the release for reproducible Rust application builds.
- Generated/local artifacts are now ignored for nested Tauri lockfile, SDK `dist`, and `/goal.txt`; the remaining untracked source/docs/package files are classified in `RELEASE_WORKTREE_CLASSIFICATION.md`.
- Dockerfile now copies all workspace members needed by the Rust build stage (`client/src-tauri` and `third_party`) and disables built-in TLS for the documented container HTTP quick start.
- `docker-compose.yml` now validates with `docker compose config`, disables built-in TLS by default, quotes the LiveKit key string so YAML does not parse it as a mapping, passes matching LiveKit API credentials to Paracord, pins the LiveKit image to `v1.9.11`, and removed the stale `/data/config` volume because the active config file is `/data/paracord.toml`.
- Federation is now disabled by default in generated/example config. It remains available as an explicit opt-in after trusted peers and key operations are configured.
- Local federation validation scripts now explicitly opt into loopback/private federation URLs and all-guild federation membership with env vars, while production defaults remain SSRF-protected and guild-deny-by-default.
- API docs now point to the generated OpenAPI route inventory and include the new v0.9 endpoint families in `docs/api-contracts.md`.
- Added `docs/known-limitations.md` and linked it from README/release notes so unsupported or incomplete platform/media/federation/updater/Docker/database behaviors are explicit.
- Release Windows client job now installs/configures `libvpx:x64-windows-static` through vcpkg.
- Release Windows client job now installs and locates Inno Setup before invoking `ISCC.exe` for the `.exe` installer.
- Release Linux client job now installs `libvpx-dev`.
- CI jobs that run Ubuntu workspace Rust checks or coverage now install Tauri native packages plus `libvpx-dev`, including the cross-platform no-default-features smoke and coverage jobs.
- Migration sanity CI now builds the production client before the default-feature workspace Cargo check so `rust-embed` has `client/dist` on fresh GitHub runners.
- Migration sanity CI now runs `bash -n scripts/setup.sh scripts/backup-db.sh scripts/restore-db.sh` on Ubuntu so operator shell-script syntax regressions are gated.
- Migration sanity CI now runs `python3 scripts/check_release_version.py`, `python3 scripts/validate_release_checklist_status.py`, `python3 scripts/check_migration_line_endings.py`, `python3 scripts/check_python_syntax.py`, shell-script syntax checks, and the digest-pinned actionlint workflow check so release metadata drift, stale checklist evidence, line-ending regressions, helper-script syntax errors, and workflow lint regressions fail before tagging.
- Release workflow now has a `validate-release-version` job that runs `python3 scripts/check_release_version.py "${GITHUB_REF_NAME}"`, `cargo audit`, client and bot SDK `npm audit --audit-level=moderate`, `python3 scripts/validate_release_checklist_status.py`, `python3 scripts/check_migration_line_endings.py`, `python3 scripts/check_python_syntax.py`, shell-script syntax checks, and digest-pinned actionlint before any release artifacts build; tag releases now fail early on version drift, dependency audit failures, stale checklist evidence, CRLF/shebang drift, helper-script syntax errors, or workflow lint regressions.
- Release workflow checkout of `RELEASE_NOTES.md` now preserves downloaded artifacts, and required upload/release artifact paths fail hard when expected server, MSI, Inno, AppImage, or deb outputs are missing.
- Signed updater artifacts are only enabled when signing secrets are configured.
- Release artifact paths now match the workspace-root Tauri target path.
- The Windows libvpx setup docs now use `VPX_STATIC=1`, matching the static vcpkg triplet, local `.cargo/config.toml`, and GitHub release workflow.

Verified:
- Workflow YAML parses with Prettier.
- `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint@sha256:b1934ee5f1c509618f2508e6eb47ee0d3520686341fec936f3b79331f9315667 .github/workflows/ci.yml .github/workflows/release.yml .github/workflows/security-audit.yml .github/workflows/security-dast-fuzz.yml`: PASS after fixing the required-artifact verifier to avoid unquoted glob splitting and cleaning up the security DAST health-wait loop.

Not yet verified:
- GitHub Actions has not run on these exact workflow changes.

## Remaining Release Blockers

- GitHub CI must pass on the final branch.
- Linux desktop packages must be built and smoke-tested.
- PostgreSQL migrations and route smoke must still pass in GitHub CI/staging on the final branch; local Docker PostgreSQL fresh-schema and backup/restore validation now pass, but a real released user database snapshot upgrade remains open.
- A clean-machine install/run test must be performed for server and desktop client.
- Packaged desktop app must be tested against a real running server, not only mocked Playwright.
- Native media flows still need manual product validation on intended platforms; LiveKit now has local managed-server validation, but external deployment validation remains open.
- Screen/audio capture support and limitations need final platform notes, especially macOS/Linux.
- Auto-updater signing and `latest.json` generation need a real signed release workflow run.
- Working tree still contains many intentional untracked source/docs/package files; classify and stage intentionally before release.
- Fresh GitHub CI will fail or test an incomplete candidate if release-critical untracked files are not committed, including root `Cargo.lock`, public release-gate docs, release smoke scripts, new migrations, and the approved `third_party/scap` strategy.
- Release owner must confirm bot SDK license/versioning.
- Release owner must accept or reject the RustSec warning waivers documented in `docs/release-risk-waivers.md`.

## Recommendation

The codebase is much closer to releaseable than at the start of this pass, but the release gate should remain closed until CI and clean-machine/manual package validation pass.
