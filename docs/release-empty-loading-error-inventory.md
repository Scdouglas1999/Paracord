# Release Empty, Loading, And Error State Inventory

Purpose: map major client pages and shared surfaces to their current empty,
loading, and error behavior before a public release. This is not a visual QA
pass; it is a source-code inventory plus current automated evidence.

Last checked: 2026-05-18.

## Current Automated Evidence

- `cd client && npm run test:e2e` covers invalid channel not-found, voice
  unavailable/empty stream state, empty/lazy route rendering for `/app`,
  friends, DMs, discovery, templates, and developer portal, and verifies no
  page errors in the mocked smoke flow.
- `cd client && npm run test:unit -- --reporter=dot` covers component and store
  error paths in the current unit suite.
- `cd client && npm run test:unit -- CreateGuildModal.template.test.tsx --reporter=dot`
  covers create-server modal create/join/template tabs, template-load error
  feedback with concrete API details, invite-code parsing, and post-create
  navigation.
- `cd client && npm run test:unit -- DiscoveryPage.test.tsx --reporter=dot`
  covers retryable public-discovery load failure feedback with concrete API
  details, public-invite join, no-public-invite feedback, public-invite lookup
  failure feedback with concrete API details, and the accessible back action.
- `cd client && npm run test:unit -- FriendsPage.test.tsx --reporter=dot`
  covers labeled friend search, inline DM-open failure feedback, trimmed
  add-friend submission, and duplicate-send prevention while a request is
  pending.
- `cd client && npm run test:unit -- SearchPanel.test.tsx --reporter=dot`
  covers labeled message-search/filter controls, the named close action, and
  announced search-unavailable feedback when both server search and fallback
  recent-message filtering fail.
- `cd client && npm run test:unit -- SearchOverlay.test.tsx --reporter=dot`
  covers the global search overlay's named dialog, labeled search field, named
  close action, progress status, and announced failure feedback when both
  server search and fallback recent-message filtering fail.
- `cd client && npm run test:unit -- TopBar.summary.test.tsx --reporter=dot`
  covers announced channel-summary failure feedback.
- `cd client && npm run test:unit -- TopBar.dm.test.tsx --reporter=dot`
  covers user-visible direct-message voice-call join failure feedback.
- `cd client && npm run test:unit -- TopBar.pins.test.tsx --reporter=dot`
  covers inline pinned-message load and unpin failure feedback.
- `cd client && npm run test:unit -- TopBar.inbox.test.tsx --reporter=dot`
  covers inline inbox unread-state load failure feedback.
- `cd client && npm run test:unit -- TopBar.follows.test.tsx --reporter=dot`
  covers inline announcement-channel follow and unfollow failure feedback.
- `cd client && npm run test:unit -- EventList.test.tsx --reporter=dot`
  covers scheduled-event manager controls, regular-member RSVP behavior,
  retryable load errors with API details, RSVP/status failure details, and
  encoded calendar export URLs.
- `cd client && npm run test:unit -- BotAuthorizePage.reviews.test.tsx --reporter=dot`
  covers bot-review rendering/submission, review/load/authorization API error
  details, successful authorization, and unsafe redirect URL blocking.
- `cd client && npm run test:unit -- GuildChannelList.test.tsx --reporter=dot`
  covers accessible inline channel-create controls, immediate store-backed
  channel insertion after success, toasts when channel creation fails, copy-ID
  clipboard failure feedback, and a toast when leaving a server fails.
- `cd client && npm run test:unit -- ChannelManager.test.tsx --reporter=dot`
  covers concrete API error details for channel creation and slowmode failures,
  plus visible announcement-channel follow failure feedback.
- `cd client && npm run test:unit -- ChannelPermissionsEditor.test.tsx --reporter=dot`
  covers concrete API error details for overwrite loading, saving, and
  role-overwrite creation failures.
- `cd client && npm run test:unit -- CommandBuilder.test.tsx --reporter=dot`
  covers concrete API error details for command create/update failures plus
  accessible option expand and choice removal controls.
- `cd client && npm run test:unit -- InviteModal.test.tsx --reporter=dot`
  covers invite generation failure alerts, disabled copy controls when no
  invite exists, and portable invite-link copy failure feedback.
- `cd client && npm run test:unit -- Sidebar.test.tsx MemberList.test.ts UserPanel.test.tsx --reporter=dot`
  covers server/member/user identity copy actions and clipboard failure
  feedback.
- `cd client && npm run test:unit -- MessageComponents.test.tsx --reporter=dot`
  covers visible feedback for failed message component button/select
  interactions, inline entity-select option-load failures, and unsafe
  link-button URL blocking.
- `cd client && npm run test:unit -- ForumView.test.tsx --reporter=dot`
  covers forum tag keyboard navigation plus API error details for failed search
  and post creation.
- `cd client && npm run test:unit -- MessageList.anonymous.test.tsx --reporter=dot`
  covers anonymous/expiry message indicators plus visible reaction and pin
  failure feedback in message history.
- `cd client && npm run test:unit -- ThreadPanel.test.tsx --reporter=dot`
  covers archived-thread restore and delete failure feedback with concrete API
  details.
- `cd client && npm run test:unit -- UserSettings.mfa.test.tsx --reporter=dot`
  covers account-settings MFA setup/backup-code/disable flows, concrete
  MFA-status/setup/verify/disable failure details, profile-save failure
  details, and settings-save failure details.
- `cd client && npm run test:a11y:static` covers accessible metadata for dialogs,
  menus, icon controls, non-interactive click handlers, and literal label
  references. It does not verify visual quality of empty/loading/error states.

## Page Inventory

| Surface | Empty State | Loading State | Error State | Release Notes |
|---|---|---|---|---|
| `HomePage` | Active voice, recent DMs, and online friends show explicit empty copy; server list hides when empty. | No first-class page loading state; data arrives from stores. | Relationship fetch failures surface through store toasts; online-friend DM open failures now show a toast instead of failing silently. | `HomePage.test.tsx` covers dashboard DM success/navigation and failure feedback; manual review with zero guilds, zero friends, and API failure toasts remains. |
| `FriendsPage` | Per-tab empty copy for online/all/pending/blocked and add-friend CTA. | No dedicated relationship loading state; action buttons now disable while their request is pending. | Inline `role="alert"` add-friend/action errors and `role="status"` add-friend success feedback. | `FriendsPage.test.tsx` covers labeled search, DM-open failure feedback, trimmed friend-request submission, and duplicate-send prevention; consider adding a list-loading skeleton if relationship fetch is slow. |
| `DMPage` | No-channel route shows "Select a conversation"; group member add list now shows "No eligible friends to add." when no candidates exist. | Message list owns message loading. | Group add/remove failures surface as inline `role="alert"` feedback. | Manual visual pass still needed for group DMs with empty friend lists, failed member actions, and long usernames. |
| `GuildPage` | Stage/video/stream panels include empty copy; invalid channel route has a not-found card. | Channel loading screen uses `LoadingSpinner`. | Invalid/deleted channel has a recovery button. | Covered by e2e invalid-channel smoke; media empty states still need real product pass. |
| `GuildHub` | Voice and text sections show empty copy. | No dedicated guild-hub loading state. | Depends on surrounding guild/channel stores and navigation. | Manual visual pass needed for guild with no channels. |
| `DiscoveryPage` | No public servers/search-results state. | Skeleton grid while loading. | Load failures show a retryable inline alert with API details; no-public-invite joins remain distinct from invite lookup/accept failures, which show concrete toast feedback. | Unit coverage verifies load retry, public-invite join, no-public-invite feedback, public-invite lookup failure details, and the accessible back action; manual visual pass remains. |
| `DeveloperPage` | No bot apps, no commands, no installs, and no metrics states. | Page/app/commands loading spinners. | `ErrorBanner` with retry for app-load errors; action errors inline through same page error, including clipboard detail for bot-token copy failures, API detail for create-bot failures, and command create/update failures. | `DeveloperPage.metrics.test.tsx` covers labeled/trimming create-bot controls, metrics refresh, metrics failure fallback, token-copy failure details, and create-bot API error details; `CommandBuilder.test.tsx` covers command create/update error details and accessible option controls; manual long-token/empty command visual pass remains. |
| `TemplateGalleryPage` | No owned guilds, no templates, no roles, and no selected-template states. | `LoadingSpinner` while loading templates. | Load and action failures render an `ErrorBanner` with concrete API error details where available. | `TemplateGalleryPage.test.tsx` covers details, create-from-guild, apply navigation, selected-template fallback after delete, concrete apply/create/delete error feedback, and load-error feedback; manual visual pass remains. |
| `CreateGuildModal` | Template tab shows no-template copy; create/join tabs are form-driven. | Create/join/template actions use `Working...`; template tab shows loading copy while templates load. | Announced inline error copy for failed create, join, template load, and template apply; template-load failures preserve concrete API details. | Unit coverage verifies create, join, template preview/apply, navigation, and template-load API error details; manual visual pass remains. |
| `InviteModal` | Generated invite fields stay empty when invite creation fails, and copy controls are disabled without an invite. | Invite creation disables copy actions and shows generating text. | Invite generation failures and invite-link copy failures show inline alerts. | `InviteModal.test.tsx` covers generation failure, disabled copy actions, avoiding copyable error text, and clipboard failure feedback. |
| `AdminPage` | Users, guilds, security events, federation peers, and backups have empty copy. | Subsections use local loading states/spinners/skeleton-like rows. | Admin actions use toasts; edit guild modal uses inline controls. | Manual pass needed across all admin tabs with empty datasets and denied non-admin user. |
| `GuildSettingsPage` | Uses permission/loading gate before rendering settings. | Permission loading screen. | Non-admin/missing guild routes redirect/guard through surrounding logic. | Manual second-user UI check remains in the release checklist. |
| `GuildSettings` | Many subsection empties: members, bans, invites, emoji, webhooks, templates, reports, onboarding, economy/bots through child sections. | Global settings loading spinner plus child-section loading states. | Top `ErrorBanner` with retry for essential load/save failures; many actions set inline error. | Needs manual tab-by-tab visual pass due breadth. |
| `BotAuthorizePage` | Guild picker shows no servers available; review area can render empty review state. | Loading authorization details. | Inline authorization-detail, authorization-submit, and review-submit errors preserve concrete API details. | `BotAuthorizePage.reviews.test.tsx` covers review rendering/submission, load/authorization/review failure details, successful authorization, and unsafe redirect blocking; manual OAuth denied/error states remain. |
| `InvitePage` | No distinct "invite missing" empty state; preview failure becomes error. | Preview and accept loading states. | Inline invite load/accept errors. | `InvitePage.test.tsx` covers preview failure, disabled accept without preview, unauthenticated login routing, authenticated accept payload, and post-accept channel navigation; manual visual expired/exhausted invite pass remains. |
| `LoginPage` | Not applicable. | Per-form submit loading labels. | `ErrorBanner` for login, MFA, reset, and email verification flows. | Product smoke covers MFA/reset API; real email delivery UI remains. |
| `RegisterPage` | Not applicable. | Submit loading label. | Inline registration error plus local password-confirmation mismatch blocking. | `RegisterPage.test.tsx` covers password-confirmation blocking, trimmed payloads, connected-server persistence, app navigation, and unlocked local public-key attachment; manual validation copy pass remains. |
| `ServerConnectPage` | Existing-server list hides when empty. | Submit/reconnect loading status. | `ErrorBanner` with friendly connection errors. | Manual invalid URL/TLS/certificate cases remain. |
| `AccountSetupPage` | Recovery phrase step is shown after identity creation and gated by acknowledgement. | Submit loading label. | Inline `role="alert"` setup/migration error. | `AccountRecovery.flow.test.tsx` covers recovery phrase display/acknowledgement and trimmed username/display-name submission; account migration visual pass remains. |
| `AccountRecoverPage` | Not applicable. | Submit loading label. | Inline `role="alert"` recovery error. | `AccountRecovery.flow.test.tsx` covers 24-word validation, trimmed recovery username submission, and successful recovery navigation; manual invalid-word/checksum cases remain. |
| `AccountUnlockPage` | Not applicable. | Submit loading label and cooldown copy. | Inline `role="alert"` unlock/cooldown error. | `AccountUnlockPage.test.tsx` covers missing-account redirect, recovery/import navigation, repeated-failure cooldown disabling, and stored-server reconnect after unlock; manual visual cooldown timing pass remains. |
| `UserSettings` | Account, appearance, voice, notifications, activity, keybinds, identity, and server sections are form-driven; MFA/session sections include empty/current-state copy. | Save/action buttons expose busy labels; session and MFA actions use local loading state. | Top-level settings/profile errors use `ErrorBanner` with concrete API details; MFA status/setup/verify/disable failures now use announced inline alerts with API details. | `UserSettings.mfa.test.tsx` covers MFA success flows plus MFA status/setup/verify/disable, profile-save, and settings-save failure details; manual full settings visual pass remains. |
| `MediaTest` | Participants list shows no participants. | Connection/action status is log-driven. | Inline connection error plus log entries. | Dev-only page; not a release-critical public workflow. |
| `PrivacyPage` / `TermsPage` | Static content; no async state. | Not applicable. | Not applicable. | Confirm legal/policy content before publication. |
| `SettingsPage` | Compatibility route; no standalone product state. | Not applicable. | Not applicable. | Prefer current user settings overlay path. |

## Shared Component Inventory

| Surface | Empty State | Loading State | Error State | Release Notes |
|---|---|---|---|---|
| `MessageList` | Message history/feed empty state and many per-feature placeholders. | Message/history fetch state handled in message store/list. | Report/thread/delete/reaction/pin actions surface through dialogs/toasts. | `MessageList.anonymous.test.tsx` covers anonymous/expiry indicators plus reaction and pin failure feedback; manual long-history and failed-send product pass remains. |
| `ThreadPanel` | Archived threads show restore guidance and hide the composer. | Restore/delete actions expose disabled button states. | Restore and delete failures show toast feedback with concrete API details. | `ThreadPanel.test.tsx` covers restore/delete failure details; manual thread panel visual pass remains. |
| `SearchPanel` | No-results copy is shown after a completed search with no matches. | Loading state is exposed through an `aria-live`/busy status while search is running. | Search failures surface as inline `role="alert"` feedback when both server search and fallback recent-message filtering fail. | `SearchPanel.test.tsx` covers labeled query/author controls, named close action, and announced failure feedback; manual long-result and keyboard-navigation visual pass remains. |
| `MessageInput` | Poll/schedule composers have validation copy. | Send/upload controls expose busy states; scheduled sends switch the primary action to schedule mode and disable while scheduling. | Send/upload, poll, schedule, slowmode, sticker quick-send, and GIF quick-send failures surface announced inline composer errors with API details where available. | Unit coverage verifies slowmode feedback, selected-file upload wiring, scheduled-message success reset, future-time validation, schedule rejection preserving content/date, and sticker/GIF quick-send failure details; manual visual composer pass remains. |
| `StickerPicker` | No stickers and no matching stickers states. | Loading copy while sticker assets load. | Load failures show an announced retryable error with concrete API details. | `StickerPicker.test.tsx` covers load/filter/select, empty state, retryable load-error details, and unsafe image fallback; manual picker visual pass remains. |
| `MessageComponents` | Unsupported top-level/non-action-row components render nothing; entity selects show no-options copy when an empty list loads. | Button/select actions disable while submitting; entity selects show `Loading options...` while fetching. | Button and select interaction failures show error toasts; entity-select option-load failures show an inline `role="alert"` and toast; unsafe link-button URLs show a blocked-link toast instead of opening. | `MessageComponents.test.tsx` covers button failure, string-select failure, entity option-load failure feedback, and unsafe link-button URL blocking; manual bot-component visual pass remains. |
| `ForumView` | No posts, no search results, and no tags states. | Forum post loading spinner. | Toasts for load/search/sort/tag/post failures now preserve API error details. | `ForumView.test.tsx` covers tag-filter keyboard navigation plus search and create-post error details; manual forum UX pass remains. |
| `EventList` | No-events state distinguishes managers from regular members. | Skeleton rows while events load. | Load failures show retryable inline alerts with API details; RSVP and status failures show toast details. | `EventList.test.tsx` covers manager controls, regular-member RSVP, retryable load-error details, RSVP/status failure details, and calendar URL encoding; manual event UX pass remains. |
| `DMList` | No DMs, no search results, no friends available for new DM. | No dedicated list loading state. | Single-DM and group-DM create failures surface as inline `role="alert"` feedback in the picker. | Manual visual pass still needed for failed create flows and long friend names. |
| `MemberList` | No members / no members to display states. | Virtualized list only; no dedicated loading state. | Member copy-ID failures show an error toast; profile actions use announced inline alerts with API details for DM, friend, block, and report failures. | `MemberList.test.ts` covers member copy-ID clipboard failure feedback; `UserProfile.test.tsx` covers profile-popup action failure details; manual large guild/offline/profile visual pass remains. |
| `TopBar` / `TopBarOverlay` surfaces | Search, pins, inbox, follows, and help overlays have empty copy where applicable. | Global search exposes an `aria-live`/busy status while search is running; channel summary shows a generating state; DM voice-call button disables while joining; follow/unfollow actions show busy button labels. | Global search failures surface as inline `role="alert"` feedback; channel-summary failures surface inline alerts; pinned-message load/unpin failures surface inline alerts; inbox load failures surface inline alerts instead of caught-up copy; direct-message voice-call join failures surface as error toasts; announcement-channel follow/unfollow failures surface inline alerts. | `SearchOverlay.test.tsx` covers the global search dialog name, labeled field, close action, progress status, and failure alert; `TopBar.summary.test.tsx` covers channel-summary failure feedback; `TopBar.pins.test.tsx` covers pinned-message load/unpin failure feedback; `TopBar.inbox.test.tsx` covers inbox load-failure feedback; `TopBar.dm.test.tsx` covers DM voice-call join failure feedback; `TopBar.follows.test.tsx` covers follow/unfollow failure feedback; modal semantics are also covered by static audit and focus trap tests. |
| `GuildChannelList` | Guilds with no channels show explicit empty copy. | Inline channel creation disables controls and shows a spinner label while creating. | Inline channel-create failures show an error toast and keep the typed name available for retry; server/channel copy-ID failures show error toasts; leave-server failures show an error toast instead of silently closing. | `GuildChannelList.test.tsx` covers labeled inline create controls, successful store-backed insertion, failed-create feedback, copy-ID clipboard failure feedback, and leave-server failure feedback; manual channel-tree visual QA with long names and permission-denied users remains. |
| `ChannelManager` | Categories with no channels show explicit empty copy; no-category guilds get a category creation prompt. | Reorder/update operations are mostly optimistic; feature and follower lists use local busy states. | Channel/category create, rename, delete, NSFW, slowmode, voice-setting, feature-setting, and announcement follow/unfollow failures preserve concrete API error details. | `ChannelManager.test.tsx` covers channel create, slowmode, and announcement-follow failures; manual admin settings visual QA remains. |
| `ImageLightbox` / `FilePreview` | Unsafe attachment URLs render a blocked-link fallback. | Image browser loading is native image loading. | Missing image is browser-level; unsafe attachment preview/download URLs are blocked before becoming media targets or links. | `FilePreview.test.tsx` covers dialog semantics and unsafe attachment URL blocking; real upload/lightbox pass remains. |
| `ChannelPermissionsEditor` | No overwrites and no members found states. | `LoadingSpinner` for overwrite load. | Inline load/save/delete/add errors preserve concrete API details. | `ChannelPermissionsEditor.test.tsx` covers load, save, and role-add failure details; manual complex permission matrix pass remains. |
| `OnboardingSettingsSection` | Rules/roles can be empty by configuration. | Loading spinner. | Inline load/save errors. | Release smoke covers route behavior; mobile visual pass remains. |
| `BotStoreSection` | No public bots, no trigger logs, disabled/no-role options. | Public bot store search shows skeleton cards; built-in install actions show busy labels. | Public bot-store load failures show retryable inline API details; public add, built-in install, remove, and save failures show API-detail toasts. | `BotStoreSection.test.tsx` covers retryable public load-error details, public add failure details, and built-in install failure details; manual full bot-store visual pass remains. |

## Remaining Release Gaps

- This inventory confirms that every major route has either an explicit state,
  a delegated child state, or a documented gap.
- Recent code hardening added user-visible error feedback for `DMPage`
  group-member add/remove, `DMList` single/group-DM create failures, and
  `GuildChannelList` inline channel-create, copy-ID, and leave-server failures,
  `InviteModal` invite generation/copy failures, message component
  button/select/entity-load failures, forum search/create-post error details,
  MessageList reaction/pin failures, plus
  `Sidebar`/`MemberList`/`UserPanel` clipboard-copy failures, plus
  `TopBar` summary, pinned-message load/unpin, and inbox load failures, plus
  `ChannelManager` admin channel-action and announcement-follow failures, plus
  `EventList` load/action details, `BotAuthorizePage` load/authorize/review
  details, `StickerPicker` retryable load details, `ThreadPanel`
  restore/delete details, `BotStoreSection` public-store/install/add details,
  and `UserSettings` profile/settings/MFA API-detail failures.
- Several pages rely on store toasts rather than local retry panels. That is
  acceptable for non-blocking actions, but should be manually reviewed for
  critical route-load failures before release.
- A final visual QA pass is still required at 320, 375, 414, 768, 1366, 1440,
  and 1920 widths with empty datasets, failed network calls, and long names.
