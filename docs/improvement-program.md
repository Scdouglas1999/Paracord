# Improvement implementation program

Source: `output/review-2026-09-08/REVIEW.md`, reviewed commit
`e54a83239803425144cbea73183aa9226c9e809c`.

The goal covers every review item. An item is complete only when its behavior,
integration, migration where applicable, and verification are present. Partial
work below does not narrow the goal. No plaintext or wrong-server fallbacks are
acceptable for encrypted or account-scoped operations.

| # | Requirement and completion evidence | Status |
|---|---|---|
| 1 | Durable encrypted outbox; original serialized request and nonce; pending/failed timeline rows; retry/edit/copy/discard; no silent eviction; serialized retry with backoff; reload, failure and lost-response tests | In progress |
| 2 | Explicit server/account operation context; per-server authenticated profiles; compound entity keys; context captured before async operations; server-switch, logout and colliding-ID tests | In progress |
| 3 | First-DM setup/unlock/peer-readiness UI; enrollment and recovery guidance; draft preservation; two fresh users successfully exchange encrypted messages | In progress |
| 4 | Client-encrypted DM attachment bytes and metadata; protected keys inside message; decrypt previews/downloads; ciphertext size limits; encrypted local outbox; server-storage confidentiality tests and accurate documentation | Complete (1:1 DMs; group DMs fail closed; see 2026-09-12 checkpoint) |
| 5 | History/realtime reconciliation for creates/edits/deletes; bounded journal; request/session generation guards; explicit historical windows; controlled concurrency tests | In progress |
| 6 | Mobile composer reserves typing width; secondary tools menu; expanding drafts; 320/390/768px, coarse-pointer, zoom and keyboard verification | In progress |
| 7 | Capability/permission/platform/encryption-aware action model; accurate DM poll availability; summaries/scheduling/media/attachment integration; server enforcement tests | In progress |
| 8 | Typed Rust response DTOs and generated TS schemas; summary/detail contracts; real request/response OpenAPI schemas; runtime/fixture contract validation; deterministic welcome count | In progress |
| 9 | Compatible dependency graph; ESLint works and is required in CI; lint, typecheck, tests and build pass | Complete |
| 10 | Patched HTTP dependency graph; independent Rust/npm audit jobs; dependency-update PR configuration; audit and HTTP/release validation | Complete |
| 11 | Home Needs You with previews/context/actions and ranking reasons; truthful quiet state; stable focus/hover; reduced duplication; multi-space verification | Complete |
| 12 | Header action hierarchy and overflow menu; active panels remain discoverable; distinct unread and mention indicators; responsive/keyboard verification | Complete |
| 13 | Guided voice permission/device/secure-context/codec/certificate/transport checks; join-failure and setup entry points; redacted export; blocked-UDP recovery test | Complete (browser; the desktop native-QUIC probe is specified, not built) |
| 14 | Call-session lifecycle/cancellation/teardown ownership; explicit call states; device preference separation; separate outbox/history/encryption/row responsibilities; lifecycle tests | In progress |
| 15 | Real UI two-user/two-server tests: enrollment/DM, attachment confidentiality, response loss, replay/history, revoked permission, unsupported poll, mobile typing width | In progress (enrollment/DM, attachment confidentiality, response loss, replay/history, first-owner setup exist as real-server tests; two servers, revoked permission, unsupported poll, mobile width remain) |
| 16 | Secure first-owner claim/setup, naming and initial space; complete password guidance; isolated restore verification; released SQLite upgrade fixture; encrypted-media recovery keys/config; operator-facing evidence | In progress |

## Verification ledger

- Baseline review: 1,205 existing client tests pass in a clean dependency install;
  four added review probes fail. Existing source was unchanged before this program.
- Native call/capture, PostgreSQL and physical keyboard testing remain required;
  the review's browser-only checks do not prove those requirements.

## Implementation notes

- Work branch: `codex/improvement-program`.
- Dependencies are repaired first so subsequent checks run in this working tree.
- Implement server/account isolation and message reconciliation as foundations for
  durable delivery and encryption flows. Keep each unfinished requirement visible.

## Verified implementation checkpoint (2026-09-08)

Evidence is saved under `output/improvement-program/`.

- Client: 1,224 tests in 171 files pass; production build and type checking pass.
- Lint now runs without dependency errors and has zero errors. Its 121 React
  Compiler migration warnings remain visible; no error rules were downgraded.
  Native form primitives are mapped for accessibility checks, actual missing
  label associations are fixed, and stale effect dependencies are corrected.
- Static accessibility and contrast checks pass. User-uploaded media previews
  can load local WebVTT captions, with resource cleanup and validation tests.
- npm audit reports zero vulnerabilities after compatible package updates.
  Vitest and its coverage provider use the patched 4.1.11 release.
- h2 is patched to 0.4.16; the lockfile change is limited to that package.
  Locked Cargo metadata validates and 25 server tests pass. Rust audit passes
  with the existing three exceptions; the expired Windows notification exception
  still needs resolution. Updating notify-rust alone does not remove quick-xml
  0.37.5, so that unrelated update was not retained.
- Rust and npm audits are independent CI jobs. Dependabot updates are configured
  for Cargo, client npm packages and GitHub Actions.
- History fetches own a bounded, coalescing mutation journal. Overlapping pages
  deduplicate, current creates/edits/deletes survive delayed history, deletion
  defeats replay during a request, old requests cannot clear replacement loading
  state, and late decryption cannot overwrite edits, metadata, deletion or logout.
  Cross-server operation ownership remains part of item 2, so item 5 stays open.
- Narrow composers use a tools menu based on actual container width. Drafts
  expand with content and resize with the visual viewport; touch targets are
  44px. Desktop and touch Chromium smoke tests both pass at 320/390/768px,
  including at least 160px typing width, menu keyboard dismissal and focus
  return, draft preservation, a reduced keyboard-sized viewport and 200% CSS
  zoom. Screenshots of the 390px layout were inspected. Real device/browser zoom
  and the real-server scenarios in item 15 remain outstanding.

Next foundation: explicit server/account operation contexts and per-server
profiles, followed by durable encrypted delivery and the DM enrollment and
attachment encryption flows. The other review requirements retain their full
scope above.

## Server/account isolation checkpoint (2026-09-08)

Evidence for this checkpoint is in `output/improvement-program/server-isolation/`.

- Every remote server has a verified REST account profile. Public gateway
  projections merge only into that server's verified user; they cannot create an
  authenticated profile or borrow home-server flags. Private profiles are not
  persisted in the server directory. Supplying a new login credential clears
  the old profile until verification completes. New directory entries use UUIDs
  so colliding URL hashes cannot share credentials.
- Active REST routing now rejects a missing remote connection. Home account
  login/settings endpoints explicitly use the home client. API methods return
  rejected promises for unavailable connections, preserving their asynchronous
  error contract. Request reachability updates identify the responding host.
- Captured operation contexts bind the server, account, base URL and cancellation
  signal before asynchronous work. Owned requests check identity before and after
  responses, token refresh and retries; old owned 401 responses cannot clear or
  overwrite a replacement session. Selection changes do not retarget a request.
  This is integrated into permission and member requests; other domains still
  require migration.
- Permission data is cached under server/account/entity keys and uses canonical
  domain API factories. Invalidated old requests cannot evict replacement data.
  UI profiles react to server selection without inheriting another server's
  administrator flags.
- Member lists, loading markers and fetch coalescing now use compound account
  and guild keys. Member readers, member gateway mutations, permission readers
  and member identity-key lookups use the appropriate account key. Delayed
  snapshots reconcile membership, role and identity changes in linear time.
  The journal coalesces fields for at most 10,000 distinct members and cancels
  overflow explicitly. Logout/reset/cancellation release request ownership;
  an old transport cannot repopulate state or block a replacement request.
- Credential storage operations are serialized per key, including reads. A late
  native save cannot undo logout, and a late delete cannot erase a subsequent
  login. Native refresh-token hydration and remote credential hydration reject
  stale reads after logout or new credentials. Memory credentials left during
  native storage degradation are also cleared on deletion.
- Full client verification: 1,264 tests in 179 files pass, including all nine
  member reconciliation/cancellation regressions. Type checking, the production
  build, lint (zero errors; 121 existing Compiler warnings), static accessibility
  audit and desktop/touch browser smoke tests pass. Native storage concurrency
  is exercised with controlled IPC responses; this does not claim an OS keychain
  or native call end-to-end run.

Remaining in item 2: compound guild/channel/message/read-state and remaining
entity stores; operation capture throughout mutations and encryption; connection
and account lifetime ownership; persistence migrations and full two-server UI
verification. Call media still needs a captured call scope instead of selected
server state. The durable encrypted outbox and encrypted attachment work have not
been implemented yet. None of these requirements is considered complete.

## Guild ownership checkpoint (2026-09-08)

Evidence is saved in `output/improvement-program/guild-isolation/`.

- The guild store now retains an explicit account scope and compound key on each
  guild. Selection stores an account-qualified reference. Snapshots, loading,
  request coalescing, create/update/delete/leave, and gateway changes operate
  within that account. Payload origin fields cannot override transport ownership.
- Pending guild snapshots reconcile additions, edits and removals. Journals
  coalesce fields and have a 10,000-guild limit with explicit cancellation.
  Reset and credential revocation cancel owned operations; late responses cannot
  restore a deleted session's list or clear a replacement request's loading state.
- Direct guild selectors and permission lookups use the current account's key.
  Cross-server lists filter out accounts that are no longer verified. Sidebar
  highlighting distinguishes identical guild IDs from different servers, and
  navigation validates the account represented by the row.
- Create, invite acceptance, public join and template application now go through
  owned guild operations using canonical domain API factories. Landing-channel
  requests retain that reference across server switches, require successful
  visibility checks, and navigate to the space home when it has no visible
  channels. They no longer prefill an unscoped channel cache from the result.
- Leaving a background space does not switch servers to issue the request or
  navigate away from a different server's same-ID space. Marking a whole space
  read fetches visible channels from its own server, bounds acknowledgements to
  eight in flight, and updates read state only after successful acknowledgement.
- Verification: 1,276 client tests in 182 files pass. New coverage uses actual
  domain clients with controlled Axios responses for colliding IDs, delayed
  snapshots and mutations, account revocation, navigation and read actions.
  Selector tests exercise immediate profile/owner changes and hidden stale
  selections. Build, typecheck, lint (zero errors; 121 existing warnings), static
  accessibility and both desktop/touch browser smoke tests pass.

Item 2 is still in progress. The channel store remains keyed by bare guild and
channel IDs; cross-domain conversation/attention aggregation, muted/pinned
preferences, messages, read state and other entity caches still require complete
account scoping. Local UI state and remaining multi-request workflows must also
retain ownership across selection changes. Connection/session lifetime and
canonical home-server identity, persistence migrations, encrypted delivery and
the real two-server UI scenarios remain required. The browser smoke suite is
mocked and does not prove item 15.

## Channel ownership checkpoint (2026-09-08)

Evidence is saved in `output/improvement-program/channel-isolation/`.

- Channel collections, their index, loading/errors and snapshot ownership now use
  server/account/entity keys. DMs use the same account-qualified collections;
  the active-server DM mirror and selected-guild flat channel array are removed.
  Selection retains an account-qualified channel reference. Local UI views expose
  IDs only inside an explicit account and keep action identities stable.
- Guild-channel and DM list requests capture verified operation contexts. Lists
  coalesce within their own collection without cancelling other guilds or hosts.
  Pending snapshots reconcile creates, partial edits, last-message activity and
  deletes. Journals coalesce fields, enforce a 10,000-channel bound and explicitly
  invalidate overflow. Revocation/reset cancel ownership and clear the journal;
  late responses cannot repopulate data or clear replacement loading state.
- Visibility requests must succeed and return their actual ID list. The previous
  unfiltered-list fallback is removed. Failed channel requests have a distinct
  error screen with an account-bound retry action. Individual-channel detail
  responses update known channels without adding a channel excluded from the
  collection. The mocked browser harness now supplies visibility and detail
  responses explicitly instead of depending on the old fallback.
- Gateway channel/DM/thread mutations and last-message changes use the event's
  account. Background DM metadata changes refetch only their owning account.
  DM creation, group creation and recipient management retain their account
  across asynchronous responses. Reorders commit after acknowledgement and do
  not restore stale snapshots over concurrent edits when a request fails.
- DM index rows and command-palette results retain colliding IDs from multiple
  servers and open the account represented by the row. A DM deep link no longer
  searches unrelated servers for matching metadata. Channel readers, guild
  aggregation and member-key channel lookups use the account-qualified cache.
- Verification: 1,279 client tests in 183 files pass, including 20 channel-store
  regressions, five actual account-view/navigation tests and the request-error
  retry UI test. Build/typecheck, lint (zero errors; 120 remaining warnings),
  static accessibility and desktop/touch Chromium smoke pass. The 390px touch
  screenshot was inspected. A final focused 13-test run verifies the existing
  mute-preference interface after the aggregation changes.

Item 2 remains in progress. Message and outbox storage, read-state records,
conversation/pin keys, muted preferences, relationships, typing/presence and call
state still need complete account ownership and appropriate persistence migration.
The current mute-preference interface still supplies bare guild IDs; this
checkpoint preserves its behavior until that producer and all consumers migrate
together. Remaining direct thread/channel/settings workflows and local UI state
must retain operation/session ownership, including late HTTP responses and
account changes. Canonical home-server identity and connection lifetime also
remain open. Global DM encryption state, durable encrypted sends and encrypted
attachments are not implemented by this checkpoint. Full real-server two-user /
two-server UI verification remains required; the mocked smoke is not item 15.

## Read state and notification ownership checkpoint (2026-09-09)

Evidence is saved in `output/improvement-program/read-notification-isolation/`.

- Read records, loading and errors are keyed by verified server/account. The
  active read-state mirror is removed. Gateway updates use their source account;
  header, inbox, DM rows and attention aggregation read their owning records.
- Read refreshes coalesce per account, reconcile pending local changes through a
  bounded journal, and release ownership immediately on cancellation. Reset and
  revocation prevent late responses from restoring data or clearing a replacement
  request. Debounced read writes capture their HTTP context before waiting;
  navigation cancels the component's pending write.
- Mute preferences now persist by account in a separate, explicitly scoped
  namespace. Legacy unowned settings are not attributed to the next login. The
  canonical server settings populate each account, with owned refresh/save
  operations and pending-snapshot reconciliation. Failed saves retain confirmed
  settings, and overlapping saves for the same guild are rejected while busy.
- Unmute updates only the mute flag, preserving notification level and suppression
  settings instead of deleting the entire override. All mute consumers use
  account-qualified guild keys. Server-resolved mute expiry is refreshed at the
  deadline and on focus; cross-tab changes trigger a canonical refresh.
- Verification: the full client suite passes 1,284 tests across 183 files;
  the final lifecycle refinement passes all 25 read/mute regressions. Build,
  typecheck and lint pass (zero errors, 119 remaining warnings). Desktop and touch
  Chromium smoke pass; the 390px touch composer screenshot was inspected.

Item 2 remains in progress. Conversation/pin keys, message/outbox/crypto state,
relationships, presence/typing, call state and remaining direct HTTP workflows
still require complete account and operation ownership. Read acknowledgements
also need backend correctness work: a stale cursor currently clears all mentions,
without validating that its message belongs to the channel. The optimistic UI
and server counter semantics need reconciliation with concurrent new messages.
Message history remains unscoped, so this checkpoint does not establish complete
isolation of a switched conversation. Canonical home-server identity, connection
lifetime and real two-server/two-user UI verification remain outstanding. Durable
encrypted outbox and attachment encryption are still required.

## Conversation and pin ownership checkpoint (2026-09-09)

Evidence is saved in `output/improvement-program/conversation-isolation/`.

- Conversation entries retain an explicit account scope and use the same JSON
  server/account/entity key as channel caches. Pin mutations take account-owned
  channel references and persist those keys in a new scoped namespace. Legacy
  pins have no account provenance: the original storage is retained but is not
  attributed to another login. New scoped pins preserve their account and order
  across hydration and are visible only with that account's available channels.
- Home and sidebar navigation share a domain action that verifies the account
  represented by a conversation before selecting it and resolving its route.
  Replaced-account rows fail visibly without switching or changing selection.
  Home-server DMs use the explicit home account.
- Expanded and collapsed space attention, selected highlights and React keys use
  compound guild keys. Colliding guild IDs no longer highlight or add attention
  to an unrelated space. Collapsed navigation validates the row's guild account.
- Conversation fan-out refetches on verified account changes even when the server
  ID stays the same, while retaining reconnect refresh behavior.
- Verification: 1,294 client tests in 184 files pass, including ownership,
  persistence, stale navigation and collapsed collision tests. The final reconnect
  refinement passes the focused unified-conversation suite. Build, typecheck,
  lint (zero errors, 119 warnings), static accessibility and both desktop/touch
  Chromium smoke pass. The 390px touch screenshot was inspected; diff whitespace
  checks pass with original line endings preserved.

Item 2 remains in progress. Message/outbox/encryption ownership, relationships,
presence/typing and call state remain outstanding, as do remaining direct HTTP
workflows, connection lifetime and canonical home-server identity. The voice
occupancy and friend-request inputs to attention still need account scoping.
Backend read acknowledgement/counter correctness remains required. This
checkpoint does not complete durable delivery, encrypted attachments or the real
server UI scenarios from item 15.

## Durable encrypted storage foundation (2026-09-09)

Evidence is saved in `output/improvement-program/encrypted-storage/`.

- Added an account-bound encrypted IndexedDB vault. HKDF derives a nonextractable
  AES-GCM key from the unlocked identity and explicit server/account scope. Each
  record authenticates its address, revision and schema version. An encrypted
  identity manifest prevents opening an existing account vault with the wrong
  key before any write; missing manifests with existing records are errors.
  Neither private keys nor record plaintext are persisted. The implementation
  requires IndexedDB, Web Locks and Web Crypto and rejects unavailable storage
  or quota failures without a plaintext or memory-only success path.
- Account transactions hold a Web Lock across reads, encryption and a strict
  durable IndexedDB commit. Related records can commit atomically, allowing a
  future ratchet advance and original outbound request to persist together.
  Exceptions and storage failures roll back every record in the commit. Account
  locks work across tabs and workers; records are neither capped nor evicted by
  the vault. Closing, logout and identity lock cancel queued/staged operations.
- The vault-session adapter captures the verified HTTP/account context before
  opening storage and requires the unlocked public key to match the server
  account's enrolled identity. It retains account ownership across selection
  changes and cancels on revocation or identity lock. Further operations reject
  an enrolled-identity change even when the user ID stays the same.
- Unlocked-key callbacks now use disposable private copies. Input ownership,
  copy isolation, wiping on success/failure, lock/replacement cancellation and
  rejection of stale results are covered. Server challenge signing uses the
  same key-operation lifetime.
- Verification: 1,303 client tests in 186 files pass. The final identity-rotation
  refinement passes nine focused key/vault-session tests. Build, typecheck and
  lint pass (zero errors; 119 warnings). Seven browser tests pass: existing
  desktop/touch smoke plus five tests against actual Chromium IndexedDB, Web
  Crypto and Web Locks. Browser coverage includes reload, colliding account/
  server/namespace IDs, concurrent updates from two tabs, atomic rollback after
  simulated quota failure, logout cancellation, wrong-key rejection and copied
  ciphertext authentication failure. These tests run in the normal E2E gate.

This is a storage foundation, not completion of items 1–4. The production Signal
session/prekey/pin paths and offline message queue still use their old stores;
existing queued plaintext has not yet been migrated. The new vault-session
adapter must be integrated with the ratchet, encrypted outbox, attachments and
read/decrypt history, including exact-request replay and recoverable legacy-data
handling. Worker crypto ownership and legacy callbacks' internal side effects
still need migration to the new lifetime. First-DM enrollment/unlock/recovery UI,
full message account scoping and real two-user/two-server UI scenarios remain
required. No encrypted-delivery or attachment-confidentiality claim is established
by these storage-only tests. All original requirements remain in scope.

## Atomic Signal message preparation (2026-09-09)

Evidence is saved in `output/improvement-program/atomic-dm-preparation/`.

- Extracted the DM cipher into a dependency-bound core. Storage, identity checks
  and the peer-bundle client can belong to one captured server and vault
  transaction. A canonical key API factory supports that binding. The existing
  application entry points remain explicit transitional callers of the old
  stores until the producer/consumer cutover is complete.
- The optional V1 encryption downgrade is removed. Missing sessions/prekeys fail
  with their actual error. A malformed v2 envelope without a header is rejected
  instead of being interpreted as v1. Explicit legacy v1 ciphertext remains
  readable. Identity pins are checked before session access; malformed peer
  keys cannot be normalized into a different usable key.
- Added vault-backed Signal session, prekey and peer-pin repositories. Session
  addresses include the conversation and both identity keys within their vault
  account. Ratchet advances, consumed prekeys and trust updates participate in
  the caller's transaction. Different conversations using the same identity pair
  maintain independent ratchets.
- Durable DM preparation now saves the exact serialized request and original
  nonce in the same commit as the ratchet and encrypted local plaintext cache.
  A persisted account sequence keeps queue order independent of clock precision
  and random UUID ordering. There is no queue cap or eviction in this path.
  Failed persistence rolls back all related state and leaves the draft with the
  caller. Outgoing and received plaintext is encrypted inside the vault and
  indexed by the authenticated envelope/context for historical reads and replay.
- Verification: the full 1,304-test client suite in 186 files passes, along with
  build and lint (zero errors; 119 warnings). The final protocol hardening passes
  ten focused crypto tests. Typecheck also includes the typed browser fixtures.
  Ten browser tests passed before the final added independent-conversation
  regression; all four final durable-DM browser tests pass. These exercise actual
  X3DH/Double Ratchet/Web Crypto/IndexedDB code: fresh identity exchange, reload
  and exact-request recovery, a reply after reload, cached historical decryption,
  complete rollback on simulated outbox quota failure, 105 concurrent sends
  retained/decrypted in order, and independent conversation ratchets.

Item 1 is in progress. The new preparation subsystem is not yet the composer or
retry loop's production path: the existing plaintext queue is still present and
must be migrated without guessing its account or losing drafts. Production
Signal prekey enrollment, historical state recovery/migration, scoped worker
crypto, group DMs, delivery scheduling/backoff and error classification, pending
and failed timeline rows, edit/copy/discard actions, attachment encryption and
account-scoped message caches remain required. The browser protocol tests use a
fixture prekey service; they do not establish the real server/account enrollment
or user-interface scenarios required by items 3 and 15. All other review items
retain their original full scope.

## Message ownership and draft preservation (2026-09-09)

Evidence is saved in `output/improvement-program/message-isolation/`.

- Each verified account now owns its message store, with nested conversation
  maps for history, pins, errors and loading. Request/reaction journals, cache
  recency and decrypting IDs belong to that store. Canonical message/pin/reaction
  APIs capture the owner before async work; switching selection does not change
  their destination. Timeline, background DM previews, composer/scheduling
  actions and message gateway dispatch use explicit owned stores. Group-DM edit
  identity lookup now uses the originating server's verified profile.
- Account revocation clears the store and cancels its operations. Retained
  callbacks cannot repopulate revoked stores, and sends through an ended session
  reject. Cancelled history releases loading immediately; old completion cannot
  clear a replacement request or publish into another account. Independent
  servers can load colliding conversation IDs concurrently, with their own
  realtime reconciliation journals. Cache limits remain 500 messages per
  conversation and 25 conversations **per account**, not a global budget.
- Send/edit/delete cancellation cannot resolve as confirmed success and cause
  callers to clear unsent work. Missing conversation metadata rejects before
  deciding whether a message can be plaintext. Legacy queue persistence now
  propagates storage failures, preserves unreadable stored data and retains
  server-rejected drafts. Its automatic 100-entry eviction is removed. Legacy
  records without a provable owner remain stored without being assigned to the
  next signed-in account; owned queue views retain other accounts' records.
- Composer, timeline edit/popover state and reply containers have account/channel
  boundaries, including when server-local IDs collide. Message text drafts use
  explicit server/account/channel keys, save immediately on editing, and clear
  only their submitted revision. Recent typing survives immediate navigation;
  typing during delivery and a replacement composer's newer draft survive late
  send success. Old completion cannot cancel another composer's reply. Opening
  the poll composer preserves the original message draft. Storage errors remain
  visible with an explicit retry action instead of being silently ignored.
- Verification: 1,332 client tests in 190 files pass, including canonical Axios
  routing with colliding IDs, concurrent histories and realtime edits, late
  responses, revocation, cancellation/replacement, quota failures, rejected and
  unreadable queue retention, mounted account selectors and composer/draft
  regressions. Typecheck, production build and lint pass (zero errors; 118
  warnings). All 11 Chromium tests pass: desktop/touch smoke plus the existing
  real-browser encrypted vault and Signal preparation scenarios.

Items 1, 2 and 5 remain in progress. This checkpoint does **not** cut production
DM delivery or text drafts over to encrypted vault storage. Both existing local
text-draft storage and the transitional legacy queue still persist plaintext;
exact serialized request/nonce replay, ratchet/queue atomicity, backoff and
pending/failed timeline actions are still confined to the unfinished delivery
integration. Legacy unowned drafts need explicit recovery UI, not guessed
ownership. The old queue still rebuilds requests on replay; preservation guards
above do not establish delivery correctness or confidentiality. Cross-tab draft
conflict handling must move to vault transactions at that cutover.

Other outstanding account boundaries include polls/commands/interactions,
typing/saved-message/attachment stores, direct thread and attachment requests,
crypto worker/prekey/pin/group-DM state, and connection/call lifetimes. Keying UI
state alone does not bind their downstream HTTP and crypto work. Full poll,
attachment and scheduled-message draft recovery also remains required. Global
cache budgeting, pin/reaction snapshot reconciliation, historical-window
semantics and the real two-user/two-server UI scenarios remain open. All 16
original requirements retain their full scope.

## Delivery identity and key publication (2026-09-09)

Evidence is saved in `output/improvement-program/delivery-identity/`.

- The server now separates the immutable message creation nonce from the mutable
  encryption IV. Delivery receipts belong to a channel and author and survive
  deletion. Replaying a committed creation returns that message's current state;
  replaying after deletion returns `410 DELIVERY_ALREADY_DELETED` and cannot
  resurrect it. Receipt creation, message insertion and monotonic channel cursor
  advancement commit together. Existing stored delivery identities are migrated
  without altering ciphertext. Original client UUIDs previously overwritten by
  cipher IVs cannot be reconstructed and are not claimed to have been recovered.
- Encrypted edits now update their cipher nonce, ciphertext and ratchet header
  together. They previously retained the old header, making the edited encrypted
  payload inconsistent. The response's top-level `nonce` identifies creation;
  `e2ee.nonce` is the cipher IV. Data export includes server delivery receipts.
- Added the durable account delivery driver and canonical captured HTTP
  transport. It sends the exact serialized committed body, checks response
  account/channel/nonce, serializes requests across browser tabs with Web Locks,
  records attempts before network work, retains rejected drafts, respects
  `Retry-After` across explicit retry, and persists exponential backoff. A failed
  conversation blocks its later messages while other conversations can proceed.
  Confirmation and queue removal share an encrypted vault transaction. Logout
  and lock cancel the sender without manufacturing failure or success. A wake
  arriving during delivery cannot strand newly queued work.
- Prekey publication now validates the complete request before a database
  transaction updates any keys. Signed-key replacement, disposable-key inserts,
  last-resort replacement and response counts commit together. A late database
  failure restores the entire preceding bundle; concurrent publications for one
  account serialize. Signed-prekey IDs are now account-owned in both database
  schemas, fixing setup failures when two clients generate the same ID. Existing
  published keys, signatures and timestamps survive migration.
- Added authenticated `GET /users/@me/keys` and its client API method. It returns
  a single-statement snapshot of the account's public identity and published
  prekeys without consuming a disposable prekey. This supplies evidence for
  verifying local private-key ownership before migration; it does not itself
  perform that migration or enrollment.
- Verification: all 1,347 client tests in 191 files pass, plus build, final
  typecheck and lint (zero errors; 118 warnings). All 18 Chromium tests pass.
  New delivery cases cover lost-response replay after reload, exact request
  bytes, cross-tab serialization, failed acknowledgement persistence, permanent
  rejection, rate-limit deadlines, in-flight logout and enqueue during delivery.
  All 182 database tests and 74 API tests pass on SQLite; the same 74 API tests
  pass on actual PostgreSQL 18.6. The API suites cover message/channel behavior,
  key publication, preceding-schema upgrades, storage/listing limits and existing
  export/import routes. PostgreSQL ran from verified distribution packages in a
  temporary directory and was stopped after verification.
  The release server builds successfully, and the real-server Chromium smoke
  passes against its embedded UI and real registration/login/authenticated HTTP
  endpoints. This smoke does not yet exercise the production DM interface.

Items 1–4 remain unfinished. The new durable sender is not yet the production
composer/queue path, and production drafts and the transitional queue still
persist plaintext. Prekey publication replay needs immutable request identity
before a consumed disposable key can safely remain consumed across a lost upload
response. Existing legacy private prekeys require verified ownership before
migration; account-scoped enrollment, archived signed keys for delayed initial
messages, historical/worker/group-DM migration, and first-DM recovery UI remain
required. Pending/failed timeline integration and retry/edit/copy/discard actions
must preserve ratchet correctness, including the first X3DH message and uncertain
server commits. Attachment encryption and real two-user/two-server UI tests are
still open. HTTP-intercepted browser delivery tests are not substitutes for those
production scenarios. All original requirements retain their full scope.


## Verified prekey enrollment and delayed messages (2026-09-09)

Evidence is saved in `output/improvement-program/prekey-enrollment/`.

- Prekey publication now supports immutable UUID receipts bound to the account's
  enrolled identity and complete request. An exact retry returns the original
  response without re-inserting consumed one-time keys or replacing a newer
  signed key. Changed bodies or identities reject with 409. Receipt persistence
  shares the key-publication transaction, so a receipt storage failure rolls
  back the keys too. Database migration/export includes the receipt table.
- The new client enrollment service uses a captured account operation context
  and encrypted vault. Private keys and the exact pending request commit before
  upload; acknowledgement removes only the matching pending request. Reload,
  network loss and failed local acknowledgement persistence retain the same
  publication identity and bytes. It requires a committed response that echoes
  the expected request and key IDs; it does not accept an older server's missing
  acknowledgement as success. An enrollment Web Lock serializes browser tabs.
- Legacy prekeys can enter the owned vault only after verifying the enrolled
  identity, the server's signed-prekey signature, matching private/public key
  pairs, key IDs, and every still-published one-time and last-resort key. Missing
  or conflicting private material raises an explicit recovery error. Legacy
  data with no provable owner requires deliberate new-key initialization; it is
  never silently assigned to the next account. Strict migration reads preserve
  original storage and surface locked keychains, unreadable envelopes and
  malformed records instead of treating those failures as absent keys.
- Inventory HTTP does not hold the vault lock. If decryption consumes a private
  prekey during the read, enrollment retries the observation against current
  private state instead of falsely reporting a recovery problem. Session lock
  or logout cancels pending operations without deleting private keys or upload.
- New X3DH headers name the recipient's signed-prekey ID. Rotation archives the
  preceding signed private key, and the decryptor selects the specified key.
  This is also supported by the existing production cipher and legacy rotation
  code. A delayed initial message survives rotation and vault reload; an unknown
  signed-key ID fails without consuming a one-time key. Previously discarded
  signed keys and old messages without a signed-key ID are not magically
  recoverable; their migration/recovery cases remain explicit work.

- Verification: all 1,356 client tests in 192 files, all 28 Chromium tests,
  typecheck, client build and lint pass (zero errors; 118 warnings). The browser
  tests use actual vault/crypto/context/transport code with a controlled prekey
  HTTP service. All 182 database tests and the same 78 API tests on SQLite and
  PostgreSQL 18.6 pass, including receipt-write failure and replay after one-time
  key consumption. The temporary PostgreSQL instance was stopped after testing.

This completes another integration prerequisite, not the full DM cutover. The
new enrollment service and canonical transport are exercised in real browser
storage tests but are not yet called by the production READY/composer flow. That
flow still uses the legacy unscoped prekey service, worker and queue. Historical
ratchet ownership and scoped worker migration must be resolved before replacing
those callers; running both key writers concurrently would be unsafe. The
original legacy stores remain intact, including old plaintext data, until their
owners and recovery path are accounted for. No confidentiality completion is
claimed for them. First-DM UI, owned recovery/export, production encrypted drafts
and outbox, group DMs, attachments, pending/failed timeline actions and the real
two-user/two-server UI scenarios remain required. All 16 requirements retain
their full scope.


## Conversation action availability and enforcement (2026-09-09)

Evidence is saved in `output/improvement-program/conversation-actions/`.

- A new authenticated channel capability endpoint returns versioned decisions
  bound to the channel and account. It reports supported actions, permissions,
  DM blocks, thread locks, timeouts, server summary configuration and configured
  call transports. Reading capability metadata does not consume peer prekeys.
  The client validates the complete response and its channel/account ownership.
- Encrypted DMs and group DMs no longer offer a usable poll composer. The server
  explicitly rejects polls and server summaries in those conversations before
  creating a message or reading history for a summary. Voice channels also
  reject unsupported polls. Invalid AI providers and missing required Anthropic
  credentials are rejected by the same configuration parser used for discovery.
- Scheduling creation and edits now re-check visibility, DM blocks, channel
  support, member timeouts and thread locks. Moderators with Manage Messages or
  Manage Channels retain the existing permission to post in locked threads.
  Joining an existing one-to-one DM call re-checks blocks before creating voice
  state or issuing a token. A blocked account cannot use the persistent channel
  to bypass the block through a new call or scheduled message.
- A client action model adds local encryption and device requirements. The
  composer and summary/DM-call header controls use its decisions. Account or
  channel changes cannot reuse an earlier decision; late responses after logout
  cannot re-enable controls. Focus, connectivity and permission/relationship
  events trigger fresh checks. Missing/invalid responses block actions with a
  retry explanation rather than assuming permission.
- Denied actions explain their reason. Text remains editable. Revoking a poll
  permission preserves its question and options; revoking attachment permission
  preserves staged files and blocks upload/submission. Disabled attachments
  cannot enter through paste, drop or the hidden file input. GIF/sticker send
  entry points also respect the send decision. Header account/channel changes
  remount owned overlays so an earlier summary cannot appear in another account.
- The tools menu now measures before paint and responds to content and visual
  viewport changes. Long explanations remain within the viewport; its own
  scrolling does not dismiss it, and Home/End/arrow navigation keeps the selected
  item visible. Desktop and touch screenshots were inspected, including a 390px
  menu and a reduced 420px viewport.

Verification: all 1,377 client tests in 194 files pass. The full 28-test browser
suite passes; its two desktop/touch UI scenarios were rerun after the final menu
changes, including a live permission change with a preserved draft and blocked
submission. Type checking, client build and lint pass (zero errors, 118 existing
warnings). The same 72 relevant API tests pass on SQLite and PostgreSQL 18.6.
The rebuilt release server passes embedded-UI boot and the real authentication
smoke test. Temporary test servers were stopped after verification.

Item 7 remains in progress. Encrypted attachment production and safe encrypted
scheduling are not integrated; the client explicitly disables them until their
producers are ready. Device checks here cover API availability and secure
contexts; complete call encryption/codec/certificate/transport diagnostics and
all media entry points still need integration. Capability responses are
advisory, and endpoint enforcement remains authoritative. A server-side prekey
inventory is not proof that a local ratchet or private key is usable. Production
first-DM setup/recovery and ratchet ownership remain open. These browser action
tests use controlled HTTP responses and do not replace the full two-user,
two-server UI scenarios. All earlier unfinished requirements retain their full
scope; this checkpoint does not complete the overall goal.


## Header hierarchy and responsive panel verification (2026-09-09)

Evidence is saved in `output/improvement-program/header-hierarchy/`.

Review item 12 is complete against its stated scope:

- The header keeps navigation, search, members (including group-DM members), and
  the current DM call control available. Summary, pins, threads, follows,
  leaderboard, administration, inbox and shortcuts share one labeled More menu
  at every width. The former desktop/mobile duplication is removed. The
  separate group-DM members toolbar is removed because that control now lives
  in the shared header.
- An open secondary panel has a visible named control in the header that also
  closes it. On narrow layouts that control moves to a separate row. Search and
  members show their active state on their primary buttons. The existing
  dialogs and panels retain their own named close controls. Breadcrumbs and
  secondary context respond to the available header width, preserving room for
  the channel name when a side panel is open. Narrow group DMs give their name
  a separate line so it is not squeezed between navigation and call controls.
- Ordinary unread activity uses a neutral hollow marker; mentions use an
  explicit @ count. Accessible descriptions state unread conversation and
  mention counts, and the Inbox menu entry repeats that context. Browser tests
  refresh actual UI read state through controlled API responses and verify all
  three states: unread, mentions and read.
- Action components have stable identities instead of being declared inside
  the parent render. Realtime count changes preserve focused primary buttons.
  Keyboard opening, menu navigation, Escape, selection and panel closure have
  verified focus behavior. Menus anchored to the header stay attached to their
  trigger while unrelated message history scrolls; focusing a menu does not
  scroll the page and dismiss it.
- Mobile detection and CSS now agree on widths below 768px, including fractional
  widths. Previously, at exactly 768px the shell and CSS disagreed about overlay
  versus desktop behavior; an 88vw panel could extend beyond the viewport and
  hide its close button. The overlay also bounds its child panel width. Browser
  checks open and close panels at 320, 390, 767, 768 and 1280px, with visible close
  controls and no horizontal overflow. One-to-one and group DM headers are
  checked at 320, 390, 768 and 1280px on desktop and touch Chromium. Active system
  audio capture remains explicitly announced in a separate status row.

Verification: all 1,388 client tests in 195 files pass, as do the full 28-test
browser suite, TypeScript/build, static accessibility and configured theme
contrast checks. Lint has zero errors and 101 warnings. The two full UI scenarios
also pass in the default dark theme after the high-contrast run. Desktop panel,
mobile menu, unread/mention and DM screenshots were inspected and saved for both
pointer modes. The release build and real embedded-UI/authentication smoke test
pass; the temporary server was stopped afterward.

This completes the header review item only. It does not replace the real
multi-user/multi-server failure scenarios, physical keyboard checks, production
encrypted outbox and attachment integration, first-DM recovery, generated API
contracts, Home prioritization, voice diagnostics/lifecycle work, or operator
setup/recovery requirements that remain open elsewhere in this ledger. The
full goal remains active with all original requirements intact.

## Independent DM session generations (2026-09-09)

Evidence is saved in `output/improvement-program/dm-session-generations/`.

The account-owned encrypted messaging implementation now retains independent
ratchets for every authenticated X3DH generation. A fresh initial message no
longer replaces the only saved session. This preserves outstanding ciphertext
when both users initiate simultaneously or a peer reinstalls while old history
is still arriving. The v2 wire format is unchanged.

- Session generation records, the selected sending session, prekey consumption,
  plaintext cache and prepared outbound requests remain in the same encrypted
  account transaction. Failed candidate authentication makes no ratchet writes;
  IndexedDB and deserialization failures propagate outside candidate attempts.
- Incoming decryption requires an exact positive server message ID. The selected
  sending session advances only with a newer authenticated incoming message,
  comparing snowflakes as BigInt. Uncached older history can update its own
  generation without replacing the selected session. A cached replay does not
  advance session selection. This watermark covers received messages; delivery
  acknowledgment/own-message observation still needs integration with production
  messaging and must not be assumed implemented here.
- The current ratchet is read and tried first. Retired private keys are loaded
  only when necessary. They are not evicted, and a missing active ratchet fails
  closed instead of silently fetching another bundle.
- The single-ratchet format previously written inside the account/conversation
  vault upgrades transactionally, retaining counters and key material. This is
  not a claim or migration of the old unscoped secure-storage sessions. Ownership
  and recovery for those production sessions remain required before cutover.
- Received initial-message generation IDs bind the authenticated ciphertext,
  nonce bytes and ratchet header. Altering unauthenticated X3DH extensions or
  equivalent base64 spelling cannot recreate a consumed generation through a
  reusable last-resort prekey. The cipher exposes an explicit existing-session
  decryption operation so trying archived candidates cannot initialize over them.

Verification: all 1,388 client tests in 195 files pass; the encrypted browser
suite passes 32 tests. Six added browser regressions cover simultaneous first
messages and queued ciphertext through reload, older uncached history after a
peer reinstall (including IDs beyond JavaScript's safe integer limit), incoming
storage quota rollback and retry, last-resort replay rejection, account-owned
format upgrade without enrollment/counter reuse, and missing-active-state failure.
TypeScript/build pass; lint reports zero errors and the same 101 warnings. These
checks exercise real browser crypto and persistent IndexedDB with controlled
prekey/delivery HTTP fixtures, not the full two-user/two-server production UI.

Items 1, 2 and 3 remain in progress. Production messaging, its plaintext legacy
queue/drafts, the global prekey writer, unowned legacy ratchets, group-DM storage,
first-DM enrollment/recovery UI, and durable delivery controls still require a
coordinated cutover. Queued initial-message cancellation/editing also needs a
protocol-safe design because later prepared ciphertext may depend on that first
message. No original requirement is reduced or marked complete by this checkpoint.

## Durable identity and truthful setup (2026-09-09)

Evidence is saved in `output/improvement-program/identity-setup/`.

Tracing the production cutover exposed prerequisites in the existing identity
setup path. These production behaviors are now changed:

- The password-encrypted identity keystore has a dedicated durable store. Its
  AES-GCM ciphertext, scrypt salt, IV and public/profile metadata are persisted
  directly, instead of passing the already encrypted envelope through the
  generic browser secure store, which deliberately retains values only in
  memory. No unencrypted private key or memory-only success is persisted.
- Identity reads, writes, imports, exports, profile updates and deletion use the
  same store. A cross-tab Web Lock serializes updates; concurrent creation
  cannot overwrite an existing committed identity. Missing legacy private data,
  malformed keystores, unavailable locking and quota errors fail explicitly.
  Recognized legacy password-encrypted envelopes migrate nondestructively.
  Explicit import/recovery can replace a keystore; ordinary setup cannot.
- Setup uses separate local encryption and current server password fields, plus
  a two-factor/backup-code field. Previously the page passed the new encryption
  password as the server password despite saying they could differ, suppressed
  attachment failures and ignored the replacement login session.
- The attachment operation binds to a verified server/account before async work,
  validates the challenge origin/time and proves possession of the unlocked key.
  A verified existing attachment is reused; a known different enrolled identity
  requires recovery rather than replacement. The acknowledged token, refresh
  token and matching account profile replace the revoked login session on the
  intended server. A wrong account/key response is rejected. Reauthentication
  401 responses are handled by the form without triggering automatic logout.
- A failed attach retains the newly saved identity. Retrying or reloading setup
  unlocks/reuses that key instead of creating another one. The setup route waits
  for profile hydration and rejects a link naming another account. A DM composer
  blocked on initial enrollment now links to this setup route with its server,
  account and return conversation. In-app navigation retains the current session
  and existing draft. Setup does not report success before attachment succeeds.
- Account forms now own a viewport-height scroll region, with an accessible name
  and keyboard focus for scrolling. The app hides document overflow; the old
  growing layout clipped long forms below the screen. Real wheel scrolling and
  keyboard return-to-top reach the submit control at 320px and 390px. Screenshots
  were inspected. Recovery copy distinguishes restoring the identity key from
  restoring encrypted messages and their session keys.

Verification: 1,399 client tests in 197 files pass. The full browser suite passes
39 tests, including five new identity cases: reload/wrong-password recovery;
concurrent creation; failed persistence; nondestructive legacy migration with
corrupt/missing-data failures; and the rendered setup form retrying a server 401,
reloading, unlocking the same identity, adopting the replacement token and
returning to its conversation. Export/import, profile updates and deletion also
round-trip through the durable store. Additional component/transport tests cover
separate credentials, MFA, scope retention, mismatched responses, known-key
replacement rejection, draft retention, and profile hydration. TypeScript/build,
lint (zero errors, 101 existing warnings), and static accessibility checks pass.

This is not the production encrypted outbox cutover. The old prekey writer,
unscoped Signal/group sessions, legacy queue/drafts and send/edit paths still
need coordinated replacement. Server-side concurrency control for initial
identity attachment, full encrypted session/media backup and recovery, and the
real two-user/two-server scenarios remain open. The default browser setup HTTP uses controlled fixture data. A separate
real-server test runs browser login and identity setup against the embedded
release UI and a throwaway SQLite database: a real rejected server password,
page reload, unlocking the same saved identity, successful challenge/attachment,
and a subsequent authenticated profile request using the replacement bearer
token all pass. Both real-server tests and the locked release build pass; the
temporary server was stopped afterward. Items 1–3, 6, 15 and 16 retain their full unfinished scope;
no review item is marked complete by this checkpoint.

## Atomic identity enrollment and removal checkpoint (2026-09-09)

Evidence: `output/improvement-program/atomic-identity/`.

The server now treats initial identity enrollment, deliberate replacement and
same-key reauthentication separately. Omitted/null `expected_public_key` requests
initial enrollment; a different existing identity requires its expected previous
key. Competing initial enrollments serialize on the account, so only one can
install its key. The transaction rechecks the verified password hash and caller's
live tracked session after acquiring the lock. Key changes, revocation of old
sessions and insertion of the replacement session commit together. Detachment
also commits key removal and session revocation together, propagating storage
errors instead of ignoring them. Same-key reauthentication does not revoke the
account's other sessions (the existing session-count limit still applies).

The scoped setup helper sends explicit initial-enrollment intent. The API contract
documents the expectation field and transaction behavior. Both database engines
have a new case-insensitive public-key uniqueness index; public-key lookup accepts
legacy hex case and normal writers store lowercase. A legacy database containing
multiple owners for equivalent keys fails migration without selecting or deleting
an owner. Such conflicting identities require administrator resolution before an
upgrade can proceed.

Verification:

- 22 targeted API tests pass independently on SQLite and PostgreSQL, including
  competing enrollment, explicit replacement, same-key retries, stale password
  and revoked-session proofs, key/session rollback after injected insertion or
  revocation failures, legacy uppercase ownership, and an ambiguous legacy
  upgrade that leaves both owners unchanged.
- 283 Rust library tests pass (101 API and 182 database).
- 1,399 client tests in 197 files pass, with TypeScript checking, production
  build and lint (zero errors, 101 existing warnings).
- Five identity browser tests pass. Both live-server tests pass against the
  newly built locked release binary and a temporary SQLite database, including
  browser login, rejected setup credentials, reload, unlocking the saved key,
  successful attachment and authenticated use of the replacement bearer token.
- The temporary PostgreSQL and release-server processes were stopped. The
  CRLF-aware diff check passes.

This closes the initial-enrollment transaction gap recorded in the preceding
checkpoint; it does not complete any full review item. The legacy automatic
attachment paths in LoginPage/RegisterPage still need consolidation with the
scoped setup flow; notably RegisterPage currently ignores the successful
attachment's replacement session and suppresses attachment errors. That path is
not covered by the dedicated setup success test and remains to be fixed. The
production prekey writer, unscoped Signal/group sessions, legacy outbox/drafts,
coordinated send/edit/discard protocol, encrypted attachments and complete
backup/recovery remain open, as do the real two-user/two-server scenarios and
all other unfinished requirements in the table above.

## Login/registration identity separation checkpoint (2026-09-09)

Evidence: `output/improvement-program/auth-enrollment-consolidation/`.

Login and registration no longer silently attach the unlocked device key after
establishing a password session. That second mutation previously raced auth-route
redirection; registration ignored its replacement credentials and both pages
suppressed failures. Enrollment now uses the existing scoped AccountSetupPage
and attachAccountIdentity flow, with its explicit first-DM setup action,
authentication/recovery errors and validated replacement-session adoption.
The obsolete unscoped attachment/challenge wrapper was removed from authApi.

These pages also no longer copy the home session into a remote-server entry.
ConnectionManager already supports the explicit home connection; creating a
second owner for those same credentials caused logout and subsequent sign-in to
retain a misleading remote session. Existing persisted duplicate entries still
require migration as part of account-context work; this change prevents new ones
from these two paths. Cookie-only login, registration and MFA responses clear
any preceding refresh-token body copy rather than retaining another session's
credential.

Verification: 1,400 client tests in 197 files pass, including registration with
an unlocked local identity, login without implicit attachment and cookie-only
refresh-token clearing. TypeScript/build and lint pass (zero errors, 101 existing
warnings). All 39 default browser tests pass. The locked release build passes;
both real-server tests pass against the newly embedded client. The extended
live-browser scenario performs rejected setup authentication, reload and reuse
of the saved key, explicit successful attachment, logout, registration of a
second account, another logout and password login. It checks the second account
has no attached key, its registration token remains valid, no implicit attachment
request occurs during account changes, and the saved encrypted identity remains
byte-for-byte unchanged. The scenario uses the real API without response mocks.
The test initially matched the outgoing login fields before the registration
route rendered; waiting for the destination heading corrected the test rather
than masking a product failure.

The preceding checkpoint's LoginPage/RegisterPage attachment follow-up is now
resolved. The full encrypted messaging cutover, migration of legacy duplicate
server entries and unscoped crypto data, complete recovery, two-server messaging
scenarios, and every other incomplete requirement above remain open. No full
review item is marked complete by this checkpoint. Live testing also exposed a
stale connection-loss banner after intentional logout; its session ownership
remains to be corrected with the connection lifecycle work.

## Editable encrypted message intents checkpoint (2026-09-09)

Evidence: `output/improvement-program/message-intents/`.

The durable messaging foundation now distinguishes editable queued drafts from
immutable prepared requests. Enqueue stores content, recipient identity, reply
reference, stable delivery nonce, ordering sequence and revision inside the
account vault without fetching a bundle or advancing a ratchet. The delivery
driver prepares only the head of each conversation. Ciphertext, private ratchet
state, outgoing plaintext cache, exact serialized request, initial attempt
metadata and removal of the editable intent commit in the same transaction.
Existing prepared requests retain their original bytes and continue replaying
through the same sender.

Draft editing and discard use encrypted vault transactions with expected
revisions, so a stale window cannot overwrite another edit. Preparation and
editing compete for the same account transaction: once preparation wins,
changing the draft is rejected and its original request remains intact. A
preparation failure leaves the encrypted intent available for retry/edit/copy;
failed conversations do not prevent other conversations from progressing. The
driver exposes edit/discard methods that notify observers and wake delivery.
Editing keeps a server-mandated retry deadline. An unprepared initial draft can
be discarded safely because the next draft still creates the first X3DH message.

Verification: all 1,400 client tests in 197 files pass, along with TypeScript,
production client build and lint (zero errors, 101 existing warnings). All 44
default browser tests pass. The 12 delivery tests include five new cases using
actual browser IndexedDB, Web Locks and two real cryptographic identities:

- Edit/discard behind a failed conversation head, independent conversation
  progress, stale-revision rejection, and successful ordered decryption after
  retrying the original immutable request.
- Discard the initial intent and verify the next message initializes and decrypts
  as ratchet message zero, with only one bundle fetch.
- Lose the first HTTP response, reload, and replay byte-identical ciphertext and
  nonce without fetching a new bundle.
- Inject a prepared-request storage failure: no HTTP request, ratchet or plaintext
  cache commits; the encrypted intent survives and retry initializes correctly.
- Pause preparation and race an edit: the committed original body wins and
  decrypts to the original content.

These are foundation tests with controlled HTTP responses, not production UI
coverage. The production composer, plaintext legacy drafts/outbox, existing eager
Signal/group crypto paths and legacy migration have not been switched over. The
low-level eager prepare helper remains for existing session-generation tests;
production integration should enqueue intents and let the driver prepare heads.
Prepared-message edit/discard is deliberately still unfinished: it must resolve
an uncertain server commit using the immutable nonce, then reconcile the remote
message and affected Signal generation. Deleting a prepared request locally or
rolling back a ratchet that has received newer messages is not an acceptable
implementation. Pending/failed timeline actions, that resolution protocol,
prekey/session integration, attachment encryption and the full real two-user/
two-server UI scenarios remain required. No full review item is marked complete.

## Uncertain-delivery resolution checkpoint (2026-09-09)

Evidence: `output/improvement-program/delivery-resolution/`.

The server exposes authenticated
`POST /channels/{channel_id}/message-deliveries/{nonce}/resolve`. It atomically
competes with creation for the existing author/channel/nonce receipt. If
resolution wins, the nonce is permanently reserved as cancelled and every delayed
create receives `410 DELIVERY_CANCELLED`. If creation already committed, the
response identifies its message; after deletion it reports the same ID as deleted.
Resolution never edits/deletes an existing message or alters the channel tail.
Normal edit/delete endpoints retain their authorization and event behavior.

Both database migrations add an explicit cancelled flag, defaulting existing
receipts to delivered. A cancelled reservation allocates a snowflake for its
receipt without inserting a message. Cancellation differs from a previously
delivered message that was deleted, so API errors and response states remain
truthful. The unique receipt and transaction arbitrate concurrent create/resolve
requests on both engines, and a failed reservation leaves creation possible.
Visibility or DM membership is required; send permission is not, allowing an
author who lost send permission to resolve their queue. Other authors cannot
claim or inspect the caller's receipt through a shared nonce.

The captured client transport validates status, author, channel, nonce, outcome
and exact decimal message IDs. It rejects malformed, mismatched and asynchronous
acceptance responses. A cancelled creation response leaves a prepared send in
the failed queue; the sender does not falsely acknowledge it or discard crypto
state needed for subsequent messages. The API contract documents the sealing
side effect and the required encryption reconciliation.

Verification:

- 32 API tests pass on SQLite and separately on PostgreSQL (24 existing channel
  message tests and eight delivery-identity tests). Six new API cases cover
  cancellation before creation, existing edits/deletion, concurrent races with
  permanent replay outcomes, author/access isolation, nonce validation, injected
  database failure, and visibility versus send permission.
- All 182 database tests pass, including the preceding-schema upgrade fixture,
  which now verifies migrated receipts still resolve as delivered.
- All 1,412 client tests in 197 files pass, plus TypeScript, client build and
  lint (zero errors, 101 existing warnings). The new transport validation cases
  include integer IDs beyond JavaScript's safe numeric range.
- All 44 default browser tests pass. The locked release build and all three
  real-server tests pass. The additional live HTTP case creates a real account,
  guild and channel, seals a nonce, observes the delayed POST return
  `410 DELIVERY_CANCELLED`, and repeats resolution successfully. This runs
  against the embedded release server with a temporary SQLite database and no
  API response mocks. Existing live UI identity/account-change coverage passes.
- Temporary PostgreSQL and release-server processes were stopped. The
  CRLF-aware diff check passes.

The full outbox requirement remains unfinished. Next, a durable client mutation
must record the requested edit/discard, resolve its nonce, and reconcile the
relevant Signal generation plus any remote edit/delete before removing the
prepared queue item. Both cancelled initial requests and already-deleted initial
messages can strand later drafts if their generation is reused blindly; the
current low-level deleted-receipt handling still needs that coordinated change.
Ratchets must not be rolled back over newly received messages. The production
composer/timeline, legacy queue/draft migration, prekey/session cutover, encrypted
attachments, complete recovery and full two-user/two-server UI scenarios remain
open, together with the other unfinished review items. No full review item is
marked complete by this checkpoint.


### Prepared-message discard and sending-generation retirement checkpoint

Evidence: `output/improvement-program/prepared-discard/`.

The durable driver now persists discard intent before resolution, seals the
original nonce, and deletes an already delivered message through the normal
authorized endpoint. A missing DELETE result requires confirmation of deletion
for that same message ID. Lost resolution/delete responses resume resolution
without replaying the original creation. Cancellation and deletion reconcile
encryption before the local receipt and queue removal commit atomically.

Each prepared DM records its sending generation. Removing it retires that
generation for future sends while preserving private ratchet state for delayed
incoming replies. Authenticated delayed replies cannot reactivate a retired
sending generation. Unattempted eager followers return to encrypted editable
intents with their original order and nonce; followers explicitly marked for
discard resolve their own original requests independently. Attempted followers
without a resolution and missing legacy bindings remain explicit recovery work.

Verification: 1,417 client tests across 197 files and all 50 default browser tests
pass. TypeScript, production client build and lint pass (zero errors, 101 existing
warnings). Six added browser cases exercise cancellation/deletion, fresh-session
interoperability, delayed replies, reload after lost resolution, atomic rollback
on failed retirement persistence, and multiple prepared discards. These use real
browser storage/locks/crypto with controlled HTTP responses. Five additional unit
cases verify resolution/delete response handling. The CRLF-aware diff check passes.

This checkpoint does not complete a review item. Prepared editing, discard during
an in-flight send and after acknowledgement, legacy migrations, production
composer/timeline and prekey/session cutover, encrypted attachments, complete
recovery and full two-user/two-server UI scenarios remain unfinished, along with
the other open review requirements.


### In-flight discard persistence checkpoint

Evidence: `output/improvement-program/inflight-discard/`.

Discarding a prepared queued message now commits through the vault immediately,
without waiting behind the account's network delivery lock. The active attempt
re-reads the durable record before recording either its success or failure. A
concurrent discard survives both outcomes, blocks following messages in that
conversation, and proceeds to nonce resolution and authorized deletion. A late
429 still supplies a mandatory retry deadline; switching to discard cannot bypass
it. A reload before the original request returns resumes the persisted discard
without replaying the creation body.

Verification: all 1,417 client tests in 197 files and all 55 default browser tests
pass, along with TypeScript and the production client build. Lint on the two
changed source/test files passes without errors or warnings. Five new browser
cases cover late success, permission denial, lost response, rate limiting and
reload while the original HTTP request is held open. They verify immediate
persistence, resolution before followers, fresh-session follower decryption and
no duplicate original POST. The CRLF-aware diff check passes.

The race while an item remains queued is addressed. A discard requested after
acknowledgement has already removed it still needs a timeline handoff to ordinary
message deletion. Prepared editing, legacy sending-session metadata and attempted
follower recovery also remain open. These modules are not yet the production
composer/timeline or prekey writer; all previously listed integration, encrypted
attachment, recovery and multi-server UI work remains required. No additional
review item is marked complete by this checkpoint.


### Atomic message edits and history checkpoint

Evidence: `output/improvement-program/atomic-message-edits/`.

Message edits now acquire an authorized database write lock, snapshot the actual
preceding content, and update the body plus encryption nonce/header/flags in one
transaction. Competing edits record each committed predecessor once. A failed
snapshot or update rolls back both operations. Rejected edits cannot add history,
and an edit losing a race to deletion returns not found rather than an internal
error. The unused standalone snapshot writers were removed so the production
edit path cannot silently ignore snapshot failures.

Full edit authorization is shared between the API preflight and the core write.
It checks channel access, membership, timeout status and author/moderator rights
before AutoMod can record hits or alerts. SQL retains the author predicate. This
closes the previous gap where a member who could view a channel but could not
edit the target could still drive moderation side effects through an edit.
Authorized edits continue to pass through AutoMod.

The new history checks exposed an existing SQLx Any timestamp decoding failure.
The history query now explicitly selects the timestamp as text on both engines,
allowing the API to return its normal RFC3339 field and the real UI to display
prior versions. No schema migration is needed for this correction.

Verification:

- All 38 selected API tests pass separately on SQLite and PostgreSQL: 24 channel
  message cases, eight delivery identity cases and six new edit atomicity cases.
  The new cases cover concurrent edits, deletion races, unauthorized edits,
  snapshot/update failure injection, ciphertext metadata rollback, AutoMod
  authorization and readable history timestamps.
- All 287 core/database library tests pass (105 core and 182 database).
- The locked production release build passes. All four real-server browser tests
  pass against the release binary and a temporary SQLite database. The new test
  registers/logs in, dismisses the actual onboarding screens, sends through the
  composer, edits twice through the context menu/editor, reloads, opens Edit
  History and verifies both preceding versions. It uses no API response mocks.
  The inspected screenshot is `edit-history.png` in the evidence directory.
- Lint passes for the updated browser spec; the CRLF-aware diff check passes.
  Temporary PostgreSQL and release-server processes were stopped.

This fixes the shipped server edit/history path; it does not complete durable
prepared-message editing. That workflow still needs persisted edit intent, nonce
resolution, idempotent remote edits that cannot replay over a later edit, and
coordinated encrypted preparation/reconciliation. The production outbox,
composer/timeline integration, prekey/session migration, encrypted attachments,
complete recovery and full two-user/two-server scenarios remain unfinished.
History UI error presentation and request ownership also remain to be brought
under the account-scoped async lifecycle; the current dialog still treats a
fetch failure as an empty history. No full review requirement is marked complete
by this checkpoint.


### Owned edit-history dialog checkpoint

Evidence: `output/improvement-program/owned-edit-history/`.

The edit-history dialog is now a separate component that owns its request and
account lifetime. MessageList retains only the selected message and position.
The dialog captures the originating server/account, uses the domain API through
that context, and cancels its request on close, replacement or unmount. Different
accounts, channels or message IDs remount the dialog so preceding data cannot
flash or overwrite a newer result. Account revocation closes it even after a
successful load; local disposal removes the revocation listener before aborting.

A failed request now shows an explicit error and Retry, rather than the previous
false empty-history claim. Retry retains the original account/server regardless
of current selection. Successful empty responses have a truthful availability
message. Response status, row shape, matching message IDs, unique history IDs and
parseable timestamps are checked before display. Missing/unverified account
contexts cannot fall through to another server. Close and Retry provide 44px
controls; Escape, focus containment and return to the invoking control remain
available. Padding keeps the close button focus outline inside the narrow panel.

Verification:

- All 1,431 client tests across 198 files pass, including 14 new dialog cases for
  HTTP failure/retry, malformed or mismatched responses, duplicate IDs, empty
  success, overlapping loads, colliding server/account/entity IDs, revocation,
  closure/cancellation/focus restoration, StrictMode cleanup and invalid account
  contexts. These use the real operation context/domain client with controlled
  Axios transport responses.
- All 55 default browser tests pass. TypeScript, full client lint (zero errors,
  101 existing warnings), the production client build and locked release server
  build pass.
- All four real-server browser tests pass. The existing real composer/editor/
  reload/history test now takes the browser offline, checks the explicit error
  at 320px, reconnects, retries successfully against the real server, and closes
  the dialog. No API response mocks are used. The desktop history and narrow
  offline screenshots were inspected; both are saved with the evidence.
- The CRLF-aware diff check passes. Temporary browser servers are stopped.

The history dialog's empty-on-error and request ownership gaps from the preceding
checkpoint are addressed. This does not complete the broader account-lifetime,
history or UI decomposition requirements. Prepared-message editing still needs
persisted edit intent, delivery resolution and idempotent remote editing, followed
by the production outbox/composer/timeline and prekey/session cutover. Encrypted
attachments, full recovery, native/call work and the complete two-user/two-server
scenarios remain unfinished, as do the other open review items. No additional
review requirement is marked complete by this checkpoint.


### Message edit replay and moderation checkpoint

Evidence: `output/improvement-program/edit-replay/`.

PATCH supports a caller-supplied immutable edit nonce. Receipts bind it to the
actor, channel, target message and original payload hash. Matching retries return
the current message without applying the old edit again, preserving later edits
and avoiding duplicate history, moderation hits or alerts. Reusing an operation
identity for a different payload or target conflicts. Receipts survive message
deletion; a deleted target returns not found. Existing callers without a nonce
retain their ordinary edit behavior.

History, message content/cipher metadata, allowed moderation hits and the edit
receipt commit together. Failures at any persistence stage roll back the entire
mutation. Moderation evaluation is read-only until the write is authorized;
invalid stored rules and moderation storage failures now propagate through
message sends, edits and webhooks. They can no longer silently bypass filtering.
A committed replay requires current visibility, while fresh changes additionally
require edit authority and pass timeout checks. This permits acknowledgement
after a timeout without granting another write. Blocked operations record their
moderation verdict but do not receive successful-edit receipts. Existing
post-commit gateway, audit, alert and federation delivery is still not a durable
event dispatcher.

The client has an immutable edit transport that reuses committed JSON bytes,
captures account/request lifetime and validates the operation acknowledgement.
It accepts a replay response containing a newer message version. This transport
is not yet integrated with durable edit intent, encryption preparation, the
delivery driver or production UI.

Both engines have the receipt migration. The existing released-schema upgrade
fixture verifies replay after upgrade. Library verification caught the missing
SQLite-to-PostgreSQL export table registration; that registration is now included
in FK-safe order and its schema completeness test passes.

Verification:

- 92 selected API cases pass on PostgreSQL. The same SQLite cases pass across
  the complete 91-case run and the subsequent 11-case replay rerun after adding
  the final rollback scenario. Coverage includes concurrent identical edits,
  competing targets, invalid identities, lost responses, later edits, deletion,
  permissions/timeouts, malformed moderation rules and injected persistence
  failures. The initial PostgreSQL attempt exhausted temporary disk space;
  only inactive test-harness databases were removed before the successful run.
- All 105 core and 182 database library cases pass. The initial DB run caught
  the export registration error described above; its full rerun passes.
- 1,444 client tests across 199 files pass, including 13 edit transport cases.
  TypeScript, full client lint (zero errors, 101 existing warnings), production
  client build, all 55 default browser cases and release server build pass.
- All four real-server browser cases pass against the release binary and a
  disposable SQLite database. The replay case applies two edits and retries
  the first, checking that the latest content, timestamp and two history entries
  remain intact. The real composer/editor/history/offline/retry UI case passes.
  These release-server cases do not mock API responses. Temporary servers stopped.

No additional full review requirement is completed here. Durable edit intent and
crypto reconciliation, production outbox/composer/timeline and prekey cutover,
encrypted attachments/history, full recovery, account lifecycle coverage, native
calls and the complete two-user/two-server scenarios remain open with the other
unfinished review items.


### Dependency hardening completion checkpoint

Evidence: `output/improvement-program/dependency-hardening/`.

The Windows toast dependency is updated from tauri-winrt-notification 0.7.2 to
0.7.3, a compatible patch that removes quick-xml from that path. The locked graph
contains only quick-xml 0.41.0 through plist. The two expired XML exceptions
(RUSTSEC-2026-0194 and RUSTSEC-2026-0195) and their comments were removed. The
existing h2 0.4.16 patch remains in the graph. No unrelated packages were updated.

Rust and client npm audits now run as independent jobs in main CI as well as the
scheduled audit workflow. The existing Security Gate depends on both results,
retaining its role as the prerequisite for downstream checks. Release and
scheduled Rust audits now run the existing exception review-date check too.
Dependabot remains configured for weekly Cargo, npm and GitHub Actions updates.

Verification:

- Cargo audit passes after removing both expired XML ignores. Its one remaining
  RSA exception is within its documented review window, ending September 30.
  Fifteen existing unsound/unmaintained/yanked dependency warnings remain visible;
  this is not a claim that every dependency has a clean advisory history. npm
  audit reports zero vulnerabilities. Exception-date enforcement passes.
- The actual notify-rust -> tauri-winrt-notification Windows dependency path
  passes `cargo check --locked -p notify-rust --target x86_64-pc-windows-gnu`.
  Locked dependency trees confirm the new toast dependency, the remaining XML
  version and h2's server/client paths. This cross-compilation check does not
  claim a live Windows notification or full native-client test.
- The locked release server build passes with the final lockfile. All five
  real-server cases pass. A new HTTP/2 test uses Node's HTTP/2 client directly,
  multiplexes requests over one connection, registers through a JSON POST and
  confirms authenticated and unauthenticated streams remain separate. The other
  four real auth, identity, replay and edit-history UI cases still pass.
- Updated browser-spec lint passes. All four workflow files pass actionlint
  1.7.12, downloaded from its official release and verified against its published
  archive checksum. The pinned Docker invocation did not return, so that owned
  client process was stopped before running the standalone linter. Python
  syntax, release line-ending checks and the CRLF-aware diff check pass.
  Temporary application servers are stopped.

Review item 10 is complete: the HTTP patch, expired exception resolution,
independent audit jobs, dependency-update configuration and HTTP/release checks
are present. Native runtime and call verification remain under their own open
requirements. The broader improvement program remains active.


### Prepared-message editing and cancellation checkpoint

Evidence: `output/improvement-program/prepared-message-editing/`.

The server can now resolve an uncertain edit before its replacement is sent.
The new actor-owned POST endpoint reports applied or deleted successful edits,
or atomically seals an absent edit as cancelled. A delayed PATCH cannot apply a
cancelled operation; a live target returns `410 EDIT_CANCELLED`. Resolution does
not change content, history or moderation hits. It requires channel visibility,
remains available during a timeout, and cannot cancel another actor's operation.
A nonce bound to a different target conflicts. The new migration adds a
cancellation flag while preserving existing successful receipts on both engines.
The SQLite upgrade fixture explicitly seeds a receipt before this migration and
verifies that it remains replayable afterward.

The durable delivery driver now implements prepared-message editing. Edit intent
and the latest draft commit immediately, including while the original POST is
in flight. Revision checks prevent a stale editor from replacing a newer draft.
Before preparing an edit, the driver resolves the original delivery. An original
send sealed before creation becomes a new intent with a fresh nonce while
retaining its channel, reply metadata and queue order. A delivered message gets
an immutable PATCH prepared in the same encrypted transaction as its keys and
plaintext cache. Retries and reloads reuse that exact request. Deleted targets
remain failed drafts available for recovery; editing does not silently recreate
a deleted message.

When another edit replaces an already prepared PATCH, the latest requested text
is saved alongside the existing immutable request. The driver resolves/seals the
preceding edit before preparing the replacement. This works after lost replies,
permanent rejections and rate limits; manual edits still respect Retry-After.
Late success or failure cannot erase a newer edit/discard intent. A discard can
also commit while PATCH is in flight, then resolves and deletes the original
message through the normal authorized endpoint.

DM edits use independent X3DH generations which remain archived for decryption
but cannot become a sending dependency for later messages. The original sending
generation is retired, and unattempted eager followers are restored to intents
without losing their latest draft or order. Tests decrypt a follower before its
edited predecessor to prove the follower does not depend on reading that edit.
Storage failures roll back retirement, new crypto state and the prepared request
together before any PATCH can be transmitted.

Release verification caught a separate live UI bug: an open history dialog used
window dimensions captured during a React render, so shrinking the viewport could
leave it far off-screen. Its bounds now use CSS clamp/min expressions, responding
to viewport changes independently of React renders. The real browser test cycles
320 -> 768 -> 320px and checks all four edges. The narrow screenshot was inspected
and is saved with the evidence. The global offline toast still overflows this
narrow screenshot; broader mobile layout work remains open.

Verification:

- All 100 selected API cases pass separately on SQLite and PostgreSQL: 24
  channel-message, 31 coverage-gap, eight delivery identity, six atomicity,
  19 replay/resolution and 12 authorization-scope cases. Eight new server cases
  cover cancellation, edit/resolve races, actor isolation, target conflicts,
  deletion, failed persistence, timeout/revocation and malformed identities.
- All 288 core/database library cases pass (105 core, 183 database), including
  the new existing-receipt upgrade fixture.
- All 1,455 client tests across 199 files pass; 11 new resolution transport cases
  join the existing immutable-edit tests. The 14 history-dialog component tests
  pass again after the CSS fix. TypeScript, full client lint (zero errors and
  101 existing warnings), final changed-module lint and production build pass.
- All 65 default browser cases pass, including ten new prepared-edit scenarios
  using real Web Crypto, IndexedDB and Web Locks with controlled HTTP routes.
  The final 33-case delivery rerun verifies the last draft-view adjustment.
  An initial run concurrently with the full unit suite timed out in two broad
  smoke cases; the full browser rerun passed without increasing timeouts.
- The final locked release build and all five real-server browser cases pass.
  The release API test cancels an edit, applies its replacement and verifies a
  delayed original returns 410 without overwriting the replacement. The auth,
  identity, real editor/history/offline/retry and HTTP/2 scenarios still pass.
  These release cases do not mock API responses. The initial history resize
  failure is retained as evidence of the corrected UI bug.
- Release line-ending and CRLF-aware diff checks pass. Temporary application and
  PostgreSQL servers are stopped; only inactive test-harness databases were
  removed from the dedicated PostgreSQL cluster.

No additional full review item is complete. The durable driver's prepared-edit
workflow is now present, but the shipped messageStore/composer/timeline still
need to adopt it. Post-acknowledgement edit/delete handoff, encrypted draft and
legacy queue migration, account-owned prekey startup, matching receive-session
migration and the group/attachment producers must accompany that production
cutover. The existing production writer still uses the legacy queue and crypto
entry points. Full encrypted history, first-DM recovery, native/call work and the
complete two-user/two-server scenarios remain open with the other unfinished
requirements. The program remains at three completed items (#9, #10 and #12).


## Home attention checkpoint (2026-09-09)

- Home now leads with attention-ranked conversations, including pinned unread
  conversations and sidebar overflow. Rows show ranking reasons, space and server,
  latest-message previews and explicit conversation actions. Additional rows are
  revealed six at a time, keeping initial preview requests bounded.
- Hover/focus holds the current row order while counts/content update. New rows
  append during interaction; removed/revoked entries disappear immediately. Stable
  account/server/channel keys preserve keyboard targets across reordering.
- Preview reads capture the row's verified account and server, cancel on replacement
  and unmount, reject mismatched channel results, ignore stale replies, and expose
  retry on failure. Encrypted messages expose no message body or attachment metadata
  through this surface and do not advance a ratchet in the background.
- Quiet copy requires known read state, loaded channel visibility, and no actionable
  conversations or requests.
  Loading/failure states no longer imply quietness; failed activity reads expose
  refresh. Resume stays available, and its space card is omitted from the separate
  rail while urgent conversations exist. Home space maps and selection now match
  the full account/server/guild key, including unread and member-count context.
- Narrow Home headers wrap long names without horizontal overflow. Preview authors
  are bounded, preview text gets two lines, and the server name has a separate line.
- Verification: 1,465 client tests in 200 files; typecheck and production build;
  changed-component lint with zero errors or warnings. Focused coverage includes
  colliding space IDs, pinned/overflow attention, loading/failure quiet-state guards,
  account-owned preview requests, encrypted preview redaction, stale responses,
  retry, keyboard/hover order and revoked-row removal. A final 34-test focused run
  also covers channel-loading failure and activity refresh availability.
- Item 11 remains in progress: latest-message previews are deliberately labeled as
  such. Exact mention/reply selection and message-specific navigation still require
  completion. The broader account-isolation and durable-outbox cutovers remain open;
  no new review item is declared complete by this checkpoint.

- Final browser verification: both desktop and touch smoke flows pass with three
  active spaces. Home checks cover previews, space labels, truthful attention count,
  correct channel activation and no horizontal overflow at 320/390/768/1280px.
  Desktop and 320px screenshots were visually inspected and saved under
  `output/improvement-program/home-attention/`. The initial multi-space fixture
  omitted visibility responses; after adding them the verified run passes without
  timeout changes. Build and changed-component lint also pass after the final guard.

## Exact Home attention and durable mentions (2026-09-09)

- Added permission-checked, account-owned attention targets using the effective
  local/server read cursor. Home selects the first actual unread mention or thread
  message and navigates to its message link; unrelated latest chatter is excluded.
- Added SQLite/PostgreSQL migration 20260909000008 for message mention recipients.
  The audience, message, channel pointer and delivery receipt commit together.
  Read-state counts derive from these records while retaining legacy aggregates;
  deletion cascades and stale/partial reads cannot clear newer recorded mentions.
- Direct, role, and permitted mass mentions resolve against guild membership and
  channel visibility. Delivered audiences survive later edits and role changes.
  Mention storage failure rolls back creation and reservation.
- Realtime mention attention now comes from recipient-targeted server events.
  The client refreshes authoritative counts instead of inferring notification
  permission from message text. Event refreshes coalesce, retain account ownership,
  refetch after older snapshots, and stop queued work on reset.
- Home reserves preview/action height during loading and failures, retaining stable
  row positions. Unknown pre-migration mention targets remain explicit; no unrelated
  message is relabeled as a mention. API contracts document the migration boundary.
- Verified 112 API tests on each of SQLite and PostgreSQL, 362 core/database/util
  library tests, all 1,472 client tests, and 71 focused Home/read-state/gateway tests.
  Client typecheck, production build, changed-module lint and release server build
  pass. The PostgreSQL run caught and verified the correction of SQLite-style bulk
  placeholders to numbered bound parameters.
- Both desktop and touch smoke tests pass serially without timeout changes;
  inspected 320px and 1280px screenshots show the exact-target labels and stable
  rows. An earlier concurrent run exceeded the overall smoke deadline and is
  retained as evidence alongside the passing serial run.
- All six real-server tests pass. The new two-account test observes an actual
  authenticated READY and recipient-only MESSAGE_MENTION frame, verifies the
  original mention preview ahead of later chatter, and opens its exact message
  link. It uses the release binary, embedded client and a disposable SQLite DB.
  Logs and screenshots are saved in `output/improvement-program/exact-home-attention/`.
  Test listeners and the dedicated PostgreSQL cluster are stopped.
- Item 11 remains open while scheduled messages, webhook/interaction/built-in bot
  messages and federation are audited for the same durable audience and live-event
  behavior. The main authenticated send path is verified; this checkpoint does not
  claim the broader durable-outbox or first-DM production cutovers are complete.


### Live Home preview mutation follow-through (2026-09-09)

- A gateway audit found that MESSAGE_DELETE and MESSAGE_DELETE_BULK updated the
  timeline without refreshing the now-derived mention counts. MESSAGE_UPDATE also
  left the Home preview cached while the channel tail stayed unchanged.
- Added account/channel-owned preview revisions. Edits invalidate only that
  channel's preview; single and bulk deletion also coalesce an authoritative
  read-state refresh. Count changes invalidate the selected target even when the
  ranking reason remains "mention". Reset clears these revisions.
- Own-user mention tokens display as `@you` in plaintext previews using the row's
  authenticated account identity. Other users' tokens retain their identity; Home
  still never advances a DM ratchet or exposes encrypted attachment metadata.
- Remaining audit: the current DB deletion helpers leave `channels.last_message_id`
  pointing at a deleted tail. A channel whose last unread message was deleted can
  therefore remain ranked as unread even with zero mention count and a truthful
  null attention target. Repair must preserve concurrent sends/deletes on both DBs
  and propagate the corrected channel tail through realtime; do not mark item 11
  complete until this and the alternative message producers are handled.

- Final verification passes: 75 focused client tests across four modules, client
  production build, changed-file ESLint, and a freshly embedded release build.
  All six real-server tests pass, including actual live creation of two mentions,
  replacement of the original preview after editing, reduction from two to one
  after deletion, exclusion of later chatter, and navigation to the surviving
  message. The receiving account renders as `@you`. The final screenshot was
  visually inspected. Logs and `home-surviving-mention.png` are saved alongside
  the preceding checkpoint. Test listeners are stopped and the CRLF-aware
  worktree whitespace check passes. Item 11 remains in progress for the gaps above.


### Atomic channel message tails (2026-09-09)

- All DB message creation and deletion helpers now serialize a channel's message
  mutations before changing its message set. The lock is a non-key row update,
  compatible with both SQL engines. Tail repair runs as a subsequent statement
  within the deletion transaction, so it sees preceding committed sends.
- Single authorized deletion, unscoped single deletion, channel-scoped bulk deletion
  and multi-channel retention deletion recompute the surviving maximum message ID.
  Empty channels receive NULL. Multi-channel deletion takes sorted channel locks;
  resolved channel IDs remain in the DELETE predicate. A tail-repair failure rolls
  back the deletion and cascaded mention records together.
- Migration 20260909000009 repairs pre-existing stale tails without moving read
  cursors. A populated SQLite upgrade test covers both a surviving earlier message
  and an emptied channel. Existing creation idempotency and deletion ownership checks
  remain inside their transactions.
- Added real multi-connection integration fixtures. Default tests still use one
  connection; tests requesting more connections use a shared SQLite file or their
  isolated PostgreSQL database. Tail/delete and mention/read races request three
  connections, avoiding a false concurrency claim from a serialized pool.
- Realtime propagation remains open. It needs an authoritative channel activity
  revision or equivalent ordering proof across creation/deletion events and channel
  snapshots; a bare corrected tail in a delete event is insufficient because late
  creation events could restore deleted activity. Item 11 remains in progress, as
  do the alternative message producers and the broader improvement program.

- Verified 116 selected API tests on each DB engine, with the final 16-case
  attention suite separately rerun on SQLite after enabling multiple connections
  for both races. All 290 core/database library tests pass, including the populated
  SQLite upgrade fixture. Logs are saved in
  `output/improvement-program/channel-message-tails/`. The dedicated PostgreSQL
  cluster is stopped after removing 124 inactive test databases.
- No new client/release-server verification is claimed by this database checkpoint.
  Existing live clients still need the ordered activity-state integration described
  above. The SQLite-to-PostgreSQL data-copy path also migrates its target before
  importing rows; it must reconcile derived tails after copying legacy data as
  part of the remaining restore/upgrade work in item 16.


## Ordered activity, deletion receipts and recovery boundaries (2026-09-12)

Evidence: `output/improvement-program/history-restore/` and
`output/improvement-program/ordered-channel-activity/`.

- Channel activity revisions now order committed sends/deletes and authoritative
  tail snapshots across HTTP, realtime and in-flight client journals. Empty tails
  propagate without a later stale create resurrecting unread activity. Early
  activity is bounded per account, preserved across older snapshots and removed
  only by a sufficiently recent authoritative visibility list; overflow cancels
  its owning snapshot and requires a fresh load.
- Durable deletion binds actor/channel/nonce/message. The deletion, mention
  cascade, tail repair and receipt commit atomically. Resolution distinguishes a
  proven receipt from an existing pending target and an unproven missing target.
  Replays require current visibility and do not republish events. Strict nonempty
  body parsing prevents omitted Content-Type from downgrading invalid requests to
  legacy deletion. Former DM members cannot delete or resolve private messages.
- Webhooks, interactions, scheduled sends, forum starters, crossposts, quarantine
  approval, built-in bots and federation use committed or explicitly intended
  mention audiences. Copied text does not invent recipients. Scheduled replay
  recognizes its stable receipt before creating duplicate message attention.
- Database histories have a persistent UUID shared by server instances. Import
  and isolated restore repair derived tails and rotate this epoch. Authenticated
  gateway handshakes publish it; stale owned HTTP requests fail before mutation.
  Current clients expire operations before clearing only the restored account's
  projections. Same-history resumes and other accounts remain intact. A changed
  RESUMED requires a new READY; late HTTP replies cannot adopt a new epoch or
  refresh/clear credentials for the wrong history. Corrupt local metadata has an
  explicit reconnect state instead of crashing Home or dispatching owned requests.
- Offline restore stages a new SQLite database or fresh isolated PostgreSQL target,
  verifies attachments and encrypted secrets, preserves TLS/federation identity and
  original JWT settings, and publishes activation config last. It retains original
  DB/media/config/archive. Bounded archive extraction rejects links, traversal,
  malformed compression trailers and recursive media-copy destinations. Verified
  legacy plaintext attachments are encrypted only in staged media. SQLite URLs
  encode literal path bytes and require an existing file. Live HTTP restore returns
  offline instructions instead of replacing an open database. Operator docs and CI
  archive recovery verification are included.
- Current verification: 450 SQLite and 451 PostgreSQL API tests pass, including
  41 focused alternate-mention/deletion/attention/epoch cases; 296 core/DB library
  tests and 100 util/WebSocket tests pass. Final restore changes pass 10 focused
  core and 27 server tests. All 1,560 client tests pass; the subsequent final
  corrupt-metadata refinement passes 39 focused tests. Owned HTTP/refresh checks
  separately pass 33 tests. Build/typecheck, changed-module lint and whitespace
  checks pass. These broad client checks used the source before the production
  encrypted messaging cutover and durable client dispatch lane; their subsequent
  integration requires fresh verification.

The encrypted outbox/delivered-mutation runtime has isolated storage, lifecycle
and crypto verification. Production writers are now switched in source; the
complete integrated build and two-account browser journey remain in progress.
Persisted legacy queues require explicit recovery after history changes. Remaining
unowned API workflows, durable event-publication recovery, first-DM and encrypted
attachment completion, call ownership/diagnostics, generated contracts and the
other open requirements retain their full scope.


### Verified history and offline recovery checkpoint

- The final release binary passes all seven actual-server browser scenarios,
  including two already-open browser sessions across a real backup/restore at the
  same URL. Both accept the new history without reload; post-backup channels and
  messages disappear; the lower restored activity revision is accepted. Requests
  bearing the old epoch receive 409 before mutation. Subsequent deletes update
  both clients and clear Home's attention row and quiet-state contradiction.
- This browser exercise found a real SSE resume defect: a cursor from before a
  process restart could exceed the new event counter and suppress later live
  updates. Future cursors now require resynchronization. Seven SSE integration
  tests pass. WebSocket RESUMED acknowledges the requested checkpoint before
  replay; a future checkpoint requires fresh identification. Sixteen actual
  WebSocket integration tests pass.
- Actual SQLite-to-PostgreSQL migration verifies 91 tables, including a populated
  27-row fixture, repaired tails, unchanged read cursors and a fresh epoch. Failure
  injection verifies transactional rollback. The smoke exposed SQLx Any decoding
  gaps; source reads now use native SQLite types, preserving nulls, booleans,
  timestamps and blobs and rejecting lossy integer-to-float conversion. All eight
  focused import type tests pass.
- Actual SQLite and PostgreSQL archive recovery passes source preservation,
  media/config/TLS/federation/JWT retention, activation guards and refusal cases.
  A PostgreSQL failure after pg_restore proves tail/epoch rollback and preserves
  the populated staging database for inspection without publishing activation
  artifacts. SQLCipher still needs a compatible build and real encrypted-database
  exercise; these checks do not claim it.
- Frozen-client desktop and touch browser checks both pass at 320/390/768/1280px,
  with zoom, keyboard navigation, composer width and three active spaces. The
  attention surface has stable ordering while focused or hovered, contextual
  previews, exact-message navigation and explicit ranking reasons. Home item 11
  is complete. This includes controlled concurrency/unit coverage and actual
  server mention/edit/delete/restore checks; it does not close broader replay
  recovery, native keyboard or two-server encryption requirements.
- The production cutover's new client dispatch lane separately passes 54 focused
  tests, full type checking and changed-file lint. Durable event completion owns
  the resume checkpoint; queued work is bounded, heartbeat controls stay prompt,
  stale transports cannot acknowledge, and native SSE handlers precede startup.
  The frozen browser artifacts above predate that lane and are not proof of its
  integrated browser behavior. Forced resync after server replay eviction still
  requires authoritative message/deletion recovery under item 5.

Logs, inspected screenshots and SHA-256 provenance are in
`output/improvement-program/history-restore/README.md`. First-owner setup, a real
released encrypted SQLite fixture and the remaining operational requirements keep
item 16 in progress. The rest of the program remains active.


## Guild wire-contract foundation (2026-09-12)

- A small `paracord-contracts` crate owns actual guild summary/detail, settings,
  mutation request and ownership-transfer wire types. List/detail/create/update/
  public-join/transfer handlers now return these types. Summary and detail are
  distinct; detail includes persisted feature flags, banner, system channel and
  vanity settings. IDs remain decimal strings. Required nullable response fields
  are distinct from optional request fields.
- Lists obtain actual member counts in bounded grouped queries over visible guild
  IDs. Count-query errors propagate. Public joins insert idempotently and read
  COUNT in one transaction, avoiding an inferred +1 during duplicate joins. Only
  a new membership produces member-add side effects. A failed owner-update count
  read prevents the rename from committing. Five actual route tests pass on both
  SQLite and PostgreSQL. The direct idempotent insert/count helper test also passes.
- Schemars derives JSON Schema from these wire types using explicit serialization
  or deserialization contracts. Checked-in TypeScript and standalone Ajv validators
  are generated from that schema. Browser code needs no schema compiler or
  unsafe-eval. Thirteen validator/boundary tests pass, including missing counts,
  malformed metadata, numeric overflow, null/omission distinctions and preserving
  transport errors. Changed-file lint passes. Root/client-working-directory
  generation is deterministic; CI checks both Rust export and client generation.
- OpenAPI embeds the same schemas with rebased local references, actual 201/204
  success statuses and typed JSON request bodies for these routes. The server base
  URL no longer duplicates `/api/v1` in documented paths. Three OpenAPI tests pass,
  including resolution of every nested schema reference. Unconverted operations
  remain explicitly labeled route inventory; error response conversion and the
  remaining API domains are still open.
- The client space projection now derives its known fields from generated
  `GuildDetail`, while allowing the smaller READY projection to omit detail-only
  fields. Removed the fabricated `features` array and corrected nullable settings
  types. Full client type checking and 46 focused contract/store/welcome/settings
  tests pass; changed-file lint has zero errors and three existing Compiler
  warnings. The standalone boundary helper is not yet wired into production
  `guildApi`, pending the combined current-backend browser run. No claim is made
  that the client welcome-count journey or all shared contracts are complete.
  Item 8 remains in progress.

Evidence and generator commands: `docs/shared-api-contracts.md` and
`output/improvement-program/guild-contracts/`. This checkpoint compiles the first
server recovery-feed changes but does not verify or activate that unfinished feed.

### Production guild validation and identity notifications (2026-09-12)

- Guild list/detail/create/update/public-join and ownership transfer now use the
  generated validators at the production HTTP boundary. Mutation request types
  come from the Rust schemas. A malformed list cannot replace valid cached
  spaces; partial gateway changes still merge into the app projection after a
  validated snapshot. Browser guild mocks now use complete summary/detail
  fixtures and validate their own responses against the generated contracts.
- Fifty-one focused client tests pass, including actual Axios/domain-client
  validation, account-owned mutations, invalid-cache preservation, welcome and
  settings screens. Changed-file lint passes. The current whole-client typecheck
  is pending the concurrent call owner refactor; no new build/browser proof is
  claimed for this production parsing checkpoint.
- Identity attach and explicit detach publish one public USER_UPDATE per observer
  session after commit. A transactional, deduplicated observer query covers self,
  actual shared-guild members, current DM/group-DM peers and accepted friends.
  It excludes outsiders and stale gateway membership indexes. Failed audience
  reads roll back the identity change and session rotation together.
- Five new notification route tests and eighteen existing credential-hardening
  tests pass on both SQLite and PostgreSQL. Logs and exact scope are in
  `output/improvement-program/identity-notifications/`. Password-change/reset
  identity invalidation and the combined current-runtime browser test remain
  required. Items 3, 8 and the broader improvement program remain open.

### Registration guidance and import-cycle verification (2026-09-12)

- Registration describes the server's complete current password requirements
  before submission and validates UTF-8 bytes/ASCII classes without changing the
  password. It rejects malformed Unicode, preserves whitespace and accepts short
  Unicode strings that satisfy the actual byte rule. Confirmation remains
  separate. The local encryption-password policy is unaffected.
- Help and confirmation errors now have explicit accessible descriptions on
  their inputs. Twenty-eight focused tests and changed-file lint pass. Current
  Vite previews at320/390/1280px show the guidance without horizontal overflow;
  screenshots at390/1280 were inspected. These are unauthenticated UI previews
  with health/auth options stubbed, not real registration or keyboard proof.
- The preview caught and fixed a real initialization cycle in the gateway alias:
  the singleton is re-exported as a live ESM binding instead of read eagerly
  while connection dispatch imports call state. All three preview widths boot
  without page errors after the fix. Evidence is in
  `output/improvement-program/registration-guidance/`.
- Added a real-server welcome-count scenario covering actual create/public join,
  schema-validated list/detail and displayed two-member count across reload.
  The scenario is prepared but has not run against the new combined release.
  First-owner setup and the remaining program requirements stay open.

### Atomic password credential recovery (2026-09-12)

- Password change/reset now publish the same targeted public identity invalidation
  after commit. Password replacement, key removal, required session revocation
  and observer lookup commit together. Reset-token consumption is conditional,
  rechecks expiry under the account lock and rolls back on failure. Password
  change revalidates its session and previously verified hash under that lock.
- Eight notification/credential route tests and eighteen existing hardening tests
  pass on both SQLite and PostgreSQL. A real multi-connection same-link reset race
  has one winner and one notification. Forced revocation/audience failures preserve
  password, key, sessions and the unused reset link; retry succeeds after repair.
  Evidence: `output/improvement-program/identity-notifications/` final logs.
- USER_UPDATE remains an unversioned hint. Owned authoritative peer metadata and
  vault identity pins, not event order alone, must determine encryption readiness.
  This does not close the integrated first-DM/reconnect requirements.
- Final registration previews also verified Continue fully reachable after scroll
  at320/390/1280px. Visual inspection found duplicate SVG gradient IDs causing the
  mobile logo to lose its background; unique IDs fix it. Final mobile initial and
  scrolled screenshots were inspected. The live re-export/call source still needs
  the combined client build and real backend journeys after concurrent integration.

## READY metadata and outage checkpoint (2026-09-12)

Evidence: `output/improvement-program/ready-snapshots/`.

- SSE session/stream establishment propagates guild lookup failures. Both
  transports propagate failed guild/voice/presence snapshot reads instead of
  publishing authoritative empty state. Post-authentication WebSocket snapshot
  failure closes with 1011 so reconnect can retry.
- READY member counts use bounded database count batches. WebSocket counts and
  presence membership no longer depend on a process-local member cache. Both
  transports carry the persisted guild creation time.
- Client READY processing validates the required metadata and updates only that
  metadata, preserving confirmed REST settings. Missing fields no longer become
  an invented zero count, current timestamp, name or default channel.
- SSE integration passes 11 cases on each database; WebSocket integration passes
  18 cases on SQLite, including real upgrade with stale member cache and injected
  snapshot-query failure. A shared generated READY core is the next integration
  step; a combined current-release browser test remains required for item 8.


## 2026-09-12 — takeover checkpoint (Claude, after the Codex session was interrupted)

The Codex session stopped at 12:38 EDT mid-flight (relay connection fencing,
combined messaging verification, READY contract). This checkpoint records the
work done afterwards by parallel sub-agents in the same worktree. Each package's
own evidence, exact commands and honest gaps are in
`output/improvement-program/<package>/CHECKPOINT.md` (local, not versioned).

- **Baseline repair.** The relay and desktop test targets did not compile
  (`ConnectionHandle::new`/`CallEventSink` signature drift); two stale client
  test mocks and one lint error were fixed. `paracord-util` clippy failures on
  the current toolchain fixed. The PostgreSQL test harness now drops per-test
  databases and uses one advisory-locked template per migration set (the leak
  filled the 16 GB `/tmp` twice during the day).
- **Item 14 (server/relay) — `relay-voice-lifecycle`.** Completed the
  per-connection lease + per-call receipt fence in `paracord-relay`
  (117 tests), fixed E2EE track-key delivery to peers that had not yet
  connected, corrected four DM voice tests that were silently 404-ing, aligned
  `leave_dm_voice` with `leave_voice` (mutation-checked regression). 119 voice
  API tests on SQLite and PostgreSQL.
- **Item 4 — `dm-attachment-e2ee`.** Per-file AES-256-GCM keys carried inside
  the Signal envelope, opaque ciphertext uploads, vault-encrypted outbox,
  server-enforced opacity for DM channels, README/known-limitations rewritten;
  real-server confidentiality e2e (marker absent from upload body, message body,
  on-disk objects and localStorage). Group DMs and edits of delivered
  attachment messages fail closed.
- **Item 16 — `first-owner-setup`.** Permanent `instance_setup` state, one-time
  hashed claim token (config/env override for harnesses), `POST /setup/claim`
  atomic owner + space creation, registration refused while unclaimed,
  `/setup-server` UI; 10 integration tests on both engines, real-server UI e2e,
  release smoke script updated. `require_claim = false` is a loud, documented
  opt-out for unattended deployments.
- **Item 8 — `contracts-expansion` (SWE-2).** Users, relationships, invites and
  emojis now use `paracord-contracts` wire types, generated validators at the
  client boundary, OpenAPI schemas; wire-shape tests on both engines.
- **Items 1/3/5 — `messaging-integration`.** All three Playwright suites run
  against a fresh release build; four product defects found only by the live
  run were fixed (false history-changed after reload, replaced session keeping
  the revoked stream, self-rejecting first handshake, prekey publication not
  notifying peers); new real-server scenarios for lost-response-across-restart
  and reconnect-after-replay-eviction; the never-run restart-recovery scenario
  passes. Pending/failed rows sit above the composer, not interleaved.
- **One-click install (SWE-2) — `one-click-install`.** `scripts/install.sh`
  (curl | sh, systemd unit, upgrade-in-place), `scripts/install.ps1`
  (scheduled task; the original `sc.exe` service path was wrong for a
  non-service-aware binary and was replaced), no-clone Docker path, CI installer
  smoke (`scripts/ci_install_smoke.sh`), docs.
- **Item 13 — `voice-diagnostics`.** Eight-step guided check with a redacted
  export, entry points in settings and on join failure, real blocked-UDP e2e.
  Its transport step exposed that **no browser had ever been able to reach
  native voice**: the media certificate was generated with rcgen's default
  1975→4096 validity while Chromium pins only ≤14-day ECDSA P-256 certs.
- **Browser voice (follow-ups `media-cert-rotation`, `browser-voice-join`).**
  13-day certificate with live rotation (`MediaEndpoint::set_certificate`,
  ArcSwap'd pin, clients refetch on reconnect); WebTransport CONNECT answered
  and held; CSP `connect-src https:`; HTTP/3 session-header framing on bridged
  streams and quarter-stream-id datagrams; immediate leave on CONNECT close;
  `Permissions-Policy` allowing mic/camera; the audio worklet referenced as an
  asset (it was inlined as `data:` TypeScript in every production build);
  per-connection relay media counters + `GET /voice/{channel}/media-stats`.
  Proven by a Chromium join with fake audio (≥10 datagrams under the join's
  own receipt, leave within 15 s) and a two-browser audio exchange.
- **Lint/format.** Workspace clean under CI's pinned Rust 1.91 clippy with
  `-D warnings` and under the local 1.98 toolchain; rustfmt clean.

Final gate on this branch (2026-09-13): rustfmt · clippy 1.91 · 83 test
binaries / 1,481 tests on SQLite · `paracord-api` + `paracord-db` +
`paracord-core` on PostgreSQL · client typecheck, eslint, 2,0xx unit tests,
static a11y, contrast, production build, contracts check · release server build
· Playwright mocked 84, real-server 13, production messaging, DM attachment
confidentiality · installer smoke, shellcheck, Python syntax, migration sanity —
all green. One workspace test link failed once with SIGBUS from btrfs checksum
errors on the development machine's volume (hardware, not code) and passed on
re-run.

Not complete: items 2 (remaining unowned API workflows, connection lifetime),
6 (real device keyboard), 7 (encrypted scheduling), 13, 14 (client voiceStore
decomposition), 15 (two servers, revoked permission, unsupported poll, mobile
width), 16 (released SQLite upgrade fixture, encrypted-media recovery evidence).


## 2026-09-13 — Lantern Stage + motion merged; release candidate 3.0.0

- `design/lantern-stage` (WP0–WP8 UI overhaul, WP9a–d motion layer; spec
  `docs/lantern-stage-spec.md`, per-package notes `docs/design/wp*-checkpoint.md`,
  motion inventory `docs/design/wp9-summary.md`) merged at `1f54b40`.
- framer-motion removed; every overlay runs on `lib/motion`.
- HTTP rate-limiter tiers are now env-overridable (`PARACORD_HTTP_RATE_LIMIT_*`,
  defaults unchanged); the loopback e2e harness raises them because the suite's
  own traffic exceeded the product ceiling (13 cases ≈ 700 requests, 77 auth).
- Release plumbing: `release.yml` creates **draft** releases; versions bumped to
  3.0.0; `RELEASE_NOTES.md` skeleton.
- Gate at merge: 2,374 client unit tests, 84 mocked e2e, 13/13 real-server ×3,
  messaging 6/6, DM-attachments 1/1, motion gate 22 cases, all Rust suites,
  fmt, clippy 1.91.
- Next: live multi-agent QA across every domain, then tag `v3.0.0` (draft).
