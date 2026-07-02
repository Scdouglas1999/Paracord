# Paracord Worktree Classification

Date: 2026-05-18

This classifies the current dirty worktree for release preparation. It is based on `git status --short`, `git diff --stat`, and `git ls-files --others --exclude-standard` from this workspace.

## Tracked Modifications

Classification: release-intended changes, but too large for one public commit.

Split before release into at least these commits:

- Security and abuse hardening: auth/session/rate-limit/CORS/federation/file-token changes across `crates/paracord-api`, `crates/paracord-core`, `crates/paracord-db`, `crates/paracord-federation`, `crates/paracord-server`, `crates/paracord-util`, `crates/paracord-ws`, and related tests.
- Native media: `crates/paracord-transport`, `crates/paracord-relay`, `crates/paracord-codec`, `crates/paracord-media-dev`, `client/src-tauri/src/native_media/*`, client media libraries, and voice UI.
- Product features: message features, scheduled messages/events, stickers, onboarding, economy, templates, bot store, moderation templates, stage/forum features, E2EE, DMs, webhooks, and admin UI.
- Database/migrations: all new SQLite/PostgreSQL migrations and matching `paracord-db` modules.
- Client UI/accessibility: settings overlays, channel settings behavior, admin guard/a11y fixes, responsive layout/styles, route/error states, and tests.
- CI/release/docs: `.github/workflows/*`, `Dockerfile`, `docker-compose.yml`, `.gitignore`, `README.md`, `RELEASE_NOTES.md`, `docs/*`, `installer/paracord-client.iss`, release smoke scripts, lockfiles, and audit artifacts.
- Optional object storage hardening: `crates/paracord-media/src/s3.rs`, `crates/paracord-server/src/config.rs`, `config/paracord.example.toml`, and self-hosting/release docs now keep S3-compatible storage disabled by default and require explicit credentials unless an admin opts into AWS credential-chain discovery.
- Release-critical line-ending hygiene: `.gitattributes` pins SQLite/PostgreSQL migration files, release Python/shell scripts, public release docs, and GitHub workflow YAML to LF line endings so SQLx migration checksums, helper-script shebangs, public release doc diffs, and release workflow diffs are not changed by platform checkout settings.
- Bot SDK: `packages/paracord-bot-sdk` source/tests/package metadata.
- Vendored dependency: `third_party/scap` and root `[patch.crates-io]` entry.

## Release Source To Commit

These untracked files are source, tests, migrations, docs, or package metadata that appear intentional for this release:

- `Cargo.lock`
- `.gitattributes`
- `client/scripts/a11y-static-audit.mjs`
- `client/scripts/contrast-audit.mjs`
- `client/scripts/capture-release-screenshots.mjs`
- `client/scripts/release-real-ui-smoke.mjs`
- `client/src-tauri/src/native_media/capabilities.rs`
- `client/src-tauri/src/native_media/screen_capture.rs`
- `client/src-tauri/src/native_media/stream_registry.rs`
- `client/src-tauri/src/tray.rs`
- `client/src/api/client.test.ts`
- `client/src/api/economy.ts`
- `client/src/api/moderationTemplates.ts`
- `client/src/api/stage.ts`
- `client/src/api/templates.ts`
- `client/src/api/tenor.ts`
- `client/src/components/channel/ForumView.test.tsx`
- `client/src/components/developer/CommandBuilder.test.tsx`
- `client/src/components/ErrorBoundary.test.tsx`
- `client/src/components/file/FilePreview.test.tsx`
- `client/src/components/guild/ChannelPermissionsEditor.tsx`
- `client/src/components/guild/ChannelPermissionsEditor.test.tsx`
- `client/src/components/guild/ChannelManager.test.tsx`
- `client/src/components/guild/InviteModal.test.tsx`
- `client/src/components/guild/BotStoreSection.test.tsx`
- `client/src/components/guild/EconomySettingsSection.tsx`
- `client/src/components/guild/EventList.test.tsx`
- `client/src/components/guild/GuildSettings.error.test.ts`
- `client/src/components/guild/GuildWelcomeScreen.test.tsx`
- `client/src/components/guild/GuildEconomyPanel.tsx`
- `client/src/components/guild/GuildOnboardingGate.test.tsx`
- `client/src/components/guild/GuildOnboardingGate.tsx`
- `client/src/components/guild/GuildSettingsSections.tsx`
- `client/src/components/guild/OnboardingSettingsSection.tsx`
- `client/src/components/layout/CommandPalette.test.tsx`
- `client/src/components/layout/Sidebar.test.tsx`
- `client/src/components/layout/DMList.tsx`
- `client/src/components/layout/DMList.test.tsx`
- `client/src/components/layout/GuildChannelList.tsx`
- `client/src/components/layout/GuildChannelList.test.tsx`
- `client/src/components/layout/TopBar.dm.test.tsx`
- `client/src/components/layout/TopBar.inbox.test.tsx`
- `client/src/components/layout/TopBar.pins.test.tsx`
- `client/src/components/layout/TopBar.summary.test.tsx`
- `client/src/components/layout/TopBar.follows.test.tsx`
- `client/src/components/layout/overlays/SearchOverlay.test.tsx`
- `client/src/components/layout/UserPanel.tsx`
- `client/src/components/layout/UserPanel.test.tsx`
- `client/src/components/layout/VoiceParticipants.test.tsx`
- `client/src/components/layout/VoiceParticipants.tsx`
- `client/src/components/layout/overlays/*.tsx`
- `client/src/components/file/FileUpload.tsx`
- `client/src/components/file/FileUpload.test.tsx`
- `client/src/components/message/GifPicker.test.tsx`
- `client/src/components/message/GifPicker.tsx`
- `client/src/components/message/GitHubEventEmbed.test.tsx`
- `client/src/components/message/MessageEmbed.test.tsx`
- `client/src/components/message/MessageComponents.test.tsx`
- `client/src/components/message/SearchPanel.test.tsx`
- `client/src/components/message/StickerPicker.tsx`
- `client/src/components/message/MessageInput.sticker.test.tsx`
- `client/src/components/message/StickerPicker.test.tsx`
- `client/src/components/guild/EmojisSection.test.tsx`
- `client/src/components/guild/ModerationTemplatesSection.test.tsx`
- `client/src/components/ui/EmojiPicker.serverEmoji.test.tsx`
- `client/src/components/ui/Feedback.tsx`
- `client/src/components/user/UserSettings.mfa.test.tsx`
- `client/src/components/voice/ScreenSharePickerModal.tsx`
- `client/src/hooks/useMobile.ts`
- `client/src/lib/dmE2eeWorker.ts`
- `client/src/lib/groupDmE2ee.test.ts`
- `client/src/lib/groupDmE2ee.ts`
- `client/src/lib/keyVerification.ts`
- `client/src/lib/keyVerification.test.ts`
- `client/src/lib/media/mediaSenderKeyEnvelope.ts`
- `client/src/lib/media/mediaSenderKeyEnvelope.test.ts`
- `client/src/lib/clipboard.ts`
- `client/src/lib/tauriAxiosAdapter.ts`
- `client/src/lib/trustedHosts.ts`
- `client/src/lib/versionedStorage.ts`
- `client/src/pages/AccountRecovery.flow.test.tsx`
- `client/src/pages/AccountUnlockPage.test.tsx`
- `client/src/pages/DiscoveryPage.test.tsx`
- `client/src/pages/InvitePage.test.tsx`
- `client/src/pages/DMPage.test.tsx`
- `client/src/pages/FriendsPage.test.tsx`
- `client/src/pages/HomePage.test.tsx`
- `client/src/pages/BotAuthorizePage.reviews.test.tsx`
- `client/src/pages/DeveloperPage.metrics.test.tsx`
- `client/src/components/guild/BotStoreCard.test.tsx`
- `client/src/components/guild/CreateGuildModal.tsx`
- `client/src/components/guild/CreateGuildModal.template.test.tsx`
- `client/src/components/guild/EconomySettingsSection.test.tsx`
- `client/src/components/guild/GuildEconomyPanel.test.tsx`
- `client/src/components/guild/OnboardingSettingsSection.test.tsx`
- `client/src/components/message/MessageInput.test.tsx`
- `client/src/components/message/MessageList.anonymous.test.tsx`
- `client/src/components/message/ThreadPanel.test.tsx`
- `client/src/components/ui/Button.test.tsx`
- `client/src/components/ui/ImageLightbox.test.tsx`
- `client/src/components/user/UserProfile.test.tsx`
- `client/src/components/voice/ScreenSharePickerModal.test.tsx`
- `client/src/hooks/useFocusTrap.test.tsx`
- `client/src/lib/connectionManager.test.ts`
- `client/src/lib/customEmoji.test.ts`
- `client/src/lib/desktopDiagnostics.test.ts`
- `client/src/pages/GuildHub.test.tsx`
- `client/src/pages/LoginPage.flow.test.tsx`
- `client/src/pages/RegisterPage.test.tsx`
- `client/src/pages/TemplateGalleryPage.tsx`
- `client/src/pages/TemplateGalleryPage.test.tsx`
- `client/src/stores/folderStore.ts`
- `client/src/styles/components.css`
- `client/src/styles/layout.css`
- `client/src/styles/tokens.css`
- `client/src/styles/utilities.css`
- `client/src/types/*.types.ts`
- `client/src/workers/dmDecrypt.worker.ts`
- `crates/paracord-api/src/ai.rs`
- `crates/paracord-api/src/opengraph.rs`
- `crates/paracord-api/src/routes/docs.rs`
- `crates/paracord-api/src/routes/economy.rs`
- `crates/paracord-api/src/routes/message_features.rs`
- `crates/paracord-api/src/routes/mod_log.rs`
- `crates/paracord-api/src/routes/moderation_templates.rs`
- `crates/paracord-api/src/routes/onboarding.rs`
- `crates/paracord-api/src/routes/reports.rs`
- `crates/paracord-api/src/routes/stage.rs`
- `crates/paracord-api/src/routes/stickers.rs`
- `crates/paracord-api/src/routes/templates.rs`
- `crates/paracord-api/src/routes/tenor.rs`
- `crates/paracord-api/tests/common/mod.rs`
- `crates/paracord-api/tests/coverage_gap_routes.rs`
- `crates/paracord-api/tests/phase6_feature_routes.rs`
- `crates/paracord-api/tests/postgres_route_smoke.rs`
- `crates/paracord-codec/src/video/encoder/windows_h264.rs`
- `crates/paracord-db/migrations/*.sql`
- `crates/paracord-db/migrations_pg/*.sql`
- `crates/paracord-db/src/anonymous_messages.rs`
- `crates/paracord-db/src/bot_reviews.rs`
- `crates/paracord-db/src/channel_features.rs`
- `crates/paracord-db/src/channel_follows.rs`
- `crates/paracord-db/src/group_e2ee.rs`
- `crates/paracord-db/src/guild_templates.rs`
- `crates/paracord-db/src/mfa.rs`
- `crates/paracord-db/src/moderation_templates.rs`
- `crates/paracord-db/src/onboarding.rs`
- `crates/paracord-db/src/password_reset.rs`
- `crates/paracord-db/src/scheduled_messages.rs`
- `crates/paracord-db/src/stage_instances.rs`
- `crates/paracord-db/src/stickers.rs`
- `crates/paracord-models/src/id.rs`
- `crates/paracord-relay/src/stream.rs`
- `crates/paracord-transport/src/stream.rs`
- `docs/known-limitations.md`
- `docs/outbound-fetcher-inventory.md`
- `docs/release-commit-plan.md`
- `docs/release-empty-loading-error-inventory.md`
- `docs/release-risk-waivers.md`
- `docs/release-screenshot-inventory.md`
- `docs/release-validation.md`
- `docs/security-release-gate.md`
- `docs/screenshots/dashboard-current.png`
- `docs/screenshots/text-chat-current.png`
- `packages/paracord-bot-sdk/README.md`
- `packages/paracord-bot-sdk/examples/ping-bot.ts`
- `packages/paracord-bot-sdk/package-lock.json`
- `packages/paracord-bot-sdk/package.json`
- `packages/paracord-bot-sdk/src/*.ts`
- `packages/paracord-bot-sdk/tests-node/sdk.test.mjs`
- `packages/paracord-bot-sdk/tests/*.ts`
- `packages/paracord-bot-sdk/tsconfig.json`
- `packages/paracord-bot-sdk/vitest.config.ts`
- `scripts/release_bot_store_smoke.py`
- `scripts/release_channel_features_smoke.py`
- `scripts/release_discovery_smoke.py`
- `scripts/release_economy_smoke.py`
- `scripts/release_embedded_ui_smoke.py`
- `scripts/release_gateway_resume_smoke.py`
- `scripts/release_graceful_shutdown_smoke.py`
- `scripts/release_invite_abuse_smoke.py`
- `scripts/release_load_smoke.py`
- `scripts/release_log_leak_smoke.py`
- `scripts/release_moderation_templates_smoke.py`
- `scripts/release_onboarding_smoke.py`
- `scripts/release_poll_emoji_smoke.py`
- `scripts/release_product_smoke.py`
- `scripts/release_restart_smoke.py`
- `scripts/release_scheduled_events_lifecycle_smoke.py`
- `scripts/release_security_smoke.py`
- `scripts/check_migration_line_endings.py`
- `scripts/check_release_version.py`
- `scripts/check_python_syntax.py`
- `scripts/release_postgres_upgrade_from_tag_smoke.py`
- `scripts/release_sqlite_query_plan_smoke.py`
- `scripts/release_sqlite_upgrade_from_tag_smoke.py`
- `scripts/release_template_safety_smoke.py`
- `scripts/release_ws_pre_auth_capacity_smoke.py`
- `scripts/validate_release_checklist_status.py`
- `third_party/scap/**`

## Internal Notes Or Owner Decision Before Commit

These files may be useful, but should not be committed to the public release unless the owner wants them public:

- `AGENTS.md`: repository-specific agent instructions. Commit only if this project intentionally publishes Codex/agent guidance.
- `ANALYSIS_REPORT.md`
- `FEDERATION_BRIDGED_CHANNELS_DESIGN.md`
- `FEDERATION_PORTABLE_IDENTITY_DESIGN.md`
- `GROUP_E2EE_DESIGN.md`
- `PLAN_EXECUTION_LEDGER.md`
- `SELF_HOSTING_DEPLOYMENT_GUIDE.md`
- `VALIDATION_MASTER.md`
- `VALIDATION_REPORT.md`
- `RELEASE_CHECKLIST_STATUS.md`
- `RELEASE_READINESS_AUDIT.md`
- `RELEASE_WORKTREE_CLASSIFICATION.md`

Recommendation: keep `RELEASE_CHECKLIST_STATUS.md`, `RELEASE_READINESS_AUDIT.md`, and this classification file until the release is cut; decide after release whether they belong in public history.

## Generated Or Local Files Now Ignored

These were excluded via `.gitignore` and should not be committed:

- `client/coverage/`
- `target-server-rebuild/`
- `tmp-vcpkg/`
- `.cargo/config.toml`
- `client/src-tauri/Cargo.lock` (nested stale/generated lockfile; `client/src-tauri` is a root Cargo workspace member and the release lockfile is the root `Cargo.lock`)
- `packages/*/dist/`
- `packages/*/node_modules/`
- `/goal.txt`

## Remaining Owner Decisions

- Confirm whether `packages/paracord-bot-sdk/package.json` should remain `MIT` while the main app uses the root custom source-available `LICENSE`.
- Confirm whether `third_party/scap` should be vendored in full, replaced with a documented fork/submodule strategy, or trimmed to exclude upstream CI/release metadata. Current local edits include warning-only cleanup in `src/capturer/mod.rs`, `src/capturer/engine/win/mod.rs`, and `src/frame/audio.rs`.
- Confirm which internal reports/design docs should be public.
- After decisions, stage files by the commit split above and keep generated artifacts ignored.
