# Security audit — 2026-09-19

This audit reviews the Rust server, HTTP and QUIC federation, account and permission boundaries, realtime delivery, attachment storage, browser cryptography, and native media/file handling. Confirmed defects are patched in the accompanying working-tree changes. The UI work being performed separately is outside this patch.

Review baseline: commit `a2c2c256d2a80a9ee7aa71fe33f28e859ca4786d` plus this audit's uncommitted security changes. No deployment or Git commit is performed by this audit.

The objective is to preserve legitimate features while rejecting unauthorized operations, malformed inputs, stale credentials, and replayed traffic. This is source review plus executable regression testing, not a claim that every possible vulnerability has been eliminated. Severity below is a qualitative assessment of the affected boundary; it is not a CVSS score or evidence of exploitation in a deployed server.

Additional inspected boundaries included backup archive extraction and expansion limits, proxy-derived client IP trust, dynamic SQL construction, gateway frame/session limits, HTTP security headers, LiveKit proxy path/token checks, and production relay room/session/SSRC ownership. These did not produce another confirmed repair in this pass; their inclusion is not a blanket certification.

## Deployment and compatibility

- Apply the normal database migrations on both SQLite and PostgreSQL. The new MFA high-water mark makes consumed TOTP steps durable across restarts and shared-server processes.
- The federation history cursor migration adds an optional event-ID tie-breaker. This preserves catch-up progress when events share a depth or earlier events become private. The extra query/JSON fields are compatible additions, but older peers ignore them: both ends need updating to progress through long hidden runs and preserve tied-depth page tails.
- Federation file GET requests now require the intended peer's HTTP transport signature in addition to their short-lived capability. Updated peers interoperate, including deployments whose federation identity differs from their endpoint hostname. An updated sender can download from an older receiver, but an older unsigned sender must be upgraded to download from an updated receiver. An unsigned fallback would retain the vulnerability.
- Previously configured manual peers whose keys never reached the verifier registry must be saved again. Missing historical keys are not blindly backfilled: old rows do not distinguish explicit pins from discovered or deliberately retired keys.
- QUIC federation handshakes bind their signatures to the TLS connection and protocol role. Both ends of that helper must be updated together. It currently has no production startup caller. Ordinary browser/desktop media framing and encryption remain interoperable.
- Strict at-rest configurations now reject plaintext local files as configured. Explicitly enabled legacy plaintext migration still works. Federation cache entries that do not satisfy the configured encryption policy are refetched; valid encrypted cache hits remain usable.
- Configured TLS startup failures terminate the server instead of exposing its API over plaintext HTTP. Explicit HTTP configurations still work, and successful HTTPS startup still redirects HTTP to HTTPS.

## Findings and repairs

### Accounts, permissions, and moderation

| Boundary / severity | Confirmed defect | Repair and regression evidence |
| --- | --- | --- |
| Channel authorization — High | The `@everyone` channel overwrite could be applied again as a member-role overwrite, undoing a restrictive role denial. | Apply the baseline overwrite once and exclude the baseline role from the role aggregate. Single and batch permission regressions cover precedence. |
| Bot authorization — High | The batch administrator shortcut returned unrestricted channel permissions before applying the installed bot's permission cap. | Apply the cap on every path, with parity tests against single-channel evaluation. |
| Guild membership — High | A channel overwrite could grant a nonmember access when a caller relied on permission computation without a separate membership check. | Both single and batch computations deny nonmembers, retaining the legitimate owner path. |
| Permission revocation — High | An in-flight permission calculation could repopulate a cache after invalidation, reinstating a revoked grant. Deferred eviction could also remove the replacement entry's reverse index. | A generation barrier rejects stale fills; a short lock makes generation check/insertion atomic with invalidation. Reverse indexes distinguish entry generations. No database await occurs while holding the lock. |
| Alternate moderation paths — High | Template kicks/bans, report-driven bans, and bot removal did not consistently invalidate cached permissions. | Invalidate the affected user on each removal path; nonmember checks also prevent an old cache entry from authorizing a removed member. |
| OAuth bot reauthorization — High | Reducing an installed bot's grant left its previous permissions cached for the cache TTL. | Invalidate the bot's guild permissions immediately on reauthorization. |
| Automatic role grants — High | Onboarding/economy configuration checked permission bits but allowed a moderator to select a superior zero-permission role, gaining rank over otherwise protected members. | Require assigned roles to be strictly below the configuring actor, preserving the owner exception. Route regressions cover both mechanisms. |
| MFA replay — High | TOTP consumption was process-local, allowing reuse after restart or against another process. Enrollment could authorize a replacement secret using a code checked against an older secret. | Store and atomically claim the step in the database, bound to the expected stored secret. Enrollment and replay tests exercise concurrent claims and replacement. |
| Pending MFA logins — High | A first-factor login ticket could survive password/key, email, or MFA-secret changes. | Bind tickets to the verified credential and secret, recheck under the credential transaction, and consume completion once. Tests cover credential changes, reenrollment, and simultaneous completions. |
| Concurrent primary login — High | Password/key revocation or MFA enrollment could race the interval between a successful login check and inserting its session, leaving a newly inserted session authorized by stale credentials. | Recheck the verified primary credential and current login gates under the account lock through session commit. Registration retains its existing onboarding behavior. |
| Recovery and email verification — High | Old-address recovery/verification links and delayed token issuance could cross an email change. A previously issued reset link also survived an ordinary password change. | Serialize address-sensitive issuance, consumption, and email changes; invalidate old links transactionally. Password changes invalidate outstanding reset links. Positive recovery flows remain covered. |
| Invite anti-raid accounting — Medium | Repeated invite acceptance by an existing member, rejected verification attempts, or concurrent retries by one account could trigger a guild lockdown. | Validate the invite and verification gate first, exclude current members, and count distinct eligible accounts per guild/window. Deduplication and global counting share a transaction; duplicates still observe the current threshold. |
| Concurrent invite redemption — Medium | Simultaneous first accepts by one account could consume several uses and emit duplicate join events before its membership insert, exhausting a limited-use invitation. | Reserve unique membership and consume a valid invite in one transaction; only the actual insertion emits join effects. Rejected consumption rolls back membership. Concurrent requests, exhausted/expired rollback, another member joining, and ordinary leave/rejoin are covered. |
| Webhook write controls — High | Webhook sends/edits could evade creator visibility or timeout restrictions; edits bypassed AutoMod, and locked threads accepted sends. | Recheck creator access; apply the common timeout guard to sends and edits; evaluate edit content with AutoMod; apply thread locks and normal archived-thread revival. Timeout deletion remains allowed, matching ordinary messages. |
| Rejected webhook edits — Medium | Invalid embeds could return an error after persisting the content edit. | Validate the complete request before mutating content. Tests assert rejected edits leave stored content unchanged and valid combined edits work. |

Primary evidence: `crates/paracord-core/src/permissions.rs`, `crates/paracord-db/src/{mfa,users,password_reset}.rs`, `crates/paracord-api/tests/{auth_key_credential_hardening,security_route_authz_regressions,srv_api6_account_bot_authz,security_webhook_delivery}.rs`.

### Federation and server-side fetching

| Boundary / severity | Confirmed defect | Repair and regression evidence |
| --- | --- | --- |
| Unauthenticated signature parsing — Medium | Signed timestamp subtraction/absolute value could overflow on extreme attacker-supplied integers before authentication. | Use overflow-safe differences and reject out-of-window values. |
| Federation request replay — High | Alternate hexadecimal casing and key IDs for the same key could bypass replay identities. | Canonicalize cryptographic identities and atomically claim the replay key. Concurrent and alternate-encoding requests are covered. |
| Ed25519 verification — High | Permissive verification accepted a small-order identity key with a universal forged signature. | Use strict verification and an explicit small-order-key regression. |
| Incoming event scope — High | The signed envelope's room was not bound to the guild/channel/message identifiers inside its content. Edits/deletes could mutate before checking federation revocation. | Validate origin, room, content, channel ownership, and existing message scope before persistence or mutation. Legitimate local-room replies and established remote mirrors have positive tests. |
| Legacy mirror mapping — High | A numeric fallback could claim unrelated guilds/channels as remote mirrors without proof of the relationship. | Require authoritative local namespace ownership or persisted legacy federation room/message/membership evidence. Existing valid legacy mirrors remain supported. |
| Remote identity materialization — Medium | A local registrant could squat the predictable system/remote username or synthetic email and prevent federation from creating identities. Remote-name hashes were also too short. | Reserve an otherwise invalid local-registration namespace and use a longer digest. Existing mapped IDs remain unchanged; preclaimed old names/emails are tested. |
| Peer revocation — High | Blocked/quarantined peers were denied retries but could still receive the initial outgoing delivery. | Apply current peer restrictions before initial transport. |
| Manual peer pins — Medium, availability | Manually configured peer keys were stored outside the registry used to verify requests, so configured peers could not authenticate without separate discovery/import. | Validate and register explicit operator pins in the verifier's key registry. Rotation/removal retires the old pin; discovered-key expiry policy remains unchanged. |
| Federated file capability — High | A stolen capability identified an intended origin but did not require the requester to prove that origin's identity. | Require the audience peer's signed GET, binding the canonical path and query to the transport signature. A real peer HTTP transfer verifies the positive path. |
| Federated history — High | Stored history could remain available after channel privacy or federation opt-in was revoked. | Reapply current room/channel sharing restrictions. Visibility-aware pagination preserves progress past hidden events and ordering at equal depths. |
| Remote moderation — High | A remote quarantine command could weaken a permanent local block or shorten an existing quarantine. | Permit remote policy changes only when they make the local restriction stricter. |
| Event IDs and quotas — Medium | An origin could squat another origin's event IDs; alternate encodings could fragment per-origin user-creation limits. | Bind event identity to origin and normalize quota subjects. Preserve signed zero-depth envelopes instead of rewriting authenticated bytes. |
| Server-side URL fetching — High | Environment proxies could bypass DNS pinning; some special/translated IP ranges were not rejected; DNS resolution lacked its own timeout. | Disable proxy inheritance on these pinned clients, bound DNS lookup time, reject private/special destinations including embedded IPv4 forms, and retain permitted public destinations. Federation and OpenGraph tests cover the address policy. |

Primary evidence: `crates/paracord-federation/src/{client,signing}.rs`, `crates/paracord-api/src/routes/federation.rs`, `crates/paracord-api/src/opengraph.rs`, and `crates/paracord-api/tests/security_federation_deep_audit.rs`.

### Realtime delivery, storage, and TLS

| Boundary / severity | Confirmed defect | Repair and regression evidence |
| --- | --- | --- |
| WebSocket/SSE replay — High | Buffered events could be delivered after guild removal or channel visibility revocation; replay could rely on stale live permission caches or omit the original event-bus scope. | Preserve original audience metadata and check current persisted authorization before replay. A denied item triggers the existing fresh-state recovery flow rather than exposing content or silently creating a sequence gap. Positive unchanged-access replay remains tested. |
| Targeted moderator events — High | The original target-user list could keep a demoted moderator eligible for buffered confidential guild reports. | Recheck current report-moderator permissions, including the bot cap, for queued live delivery and replay of privileged targeted events. |
| Local attachment encryption policy — High | A download exception served plaintext and then encrypted it despite `allow_plaintext_reads = false`. | Let the cryptor enforce the configured policy. Tests cover strict rejection, explicit legacy migration, valid encryption, and AAD relocation failure. |
| Federated cache encryption — Medium | Downloaded federation files were cached in plaintext despite attachment at-rest encryption. | Encrypt cached blobs with scope-bound AAD and decrypt authenticated cache hits. Legacy policy violations trigger refetching. |
| TLS startup — High | Certificate setup failure silently changed configured HTTPS into HTTP. | Fail startup with an explicit error. Process-level tests cover missing certificates, malformed certificates, successful CA-verified HTTPS, and redirects. |

Primary evidence: `crates/paracord-core/src/events.rs`, `crates/paracord-ws/tests/gateway_integration.rs`, `crates/paracord-api/tests/{realtime_sse_resume,security_attachment_encryption}.rs`, and `crates/paracord-server/src/main.rs`.

### Browser and native cryptography/media

| Boundary / severity | Confirmed defect | Repair and regression evidence |
| --- | --- | --- |
| Media replay — High | Authenticated encrypted packets could be replayed and rendered repeatedly. | Add matching per-stream/per-epoch sliding receive windows in Rust and TypeScript. Commit only after authentication; browser decrypt completion checks current state to handle concurrency. Reordering and rollover remain supported. |
| Typed-array encryption bounds — High | Passing a sliced typed array's entire backing buffer to WebCrypto could encrypt surrounding bytes or authenticate the wrong range. | Copy exactly the array's byte offset/length for payloads, AAD, and imported keys. Byte-range tests exercise surrounding sentinel data. |
| Media key rotation — Medium | Reusing an 8-bit epoch with a new key retained obsolete counters; repeated delivery could reopen receive state. | Wrap epochs deliberately, reset state only for new key material, and make identical key delivery idempotent. Cross-language vectors, reorder tests, and repeated-key tests remain green. |
| Ratchet resource bounds — Medium | Repeated individually permitted message gaps accumulated skipped keys without a cumulative limit; malformed counters/keys could reach derivation. | Validate counters and key/nonce lengths; retain the newest bounded set of delayed-message keys. Existing direct/group DM and ratchet integration tests cover legitimate traffic. |
| FFmpeg input memory — High | Decoder packets borrowed an unpadded Rust allocation despite libavcodec's required readable zero-padding, permitting out-of-bounds native reads. | Allocate owned reference-counted AVPackets through FFmpeg and unref them after submission. Tests inspect payload ownership and required zero padding. |
| Decoder allocation limits — High | Output dimension checks ran after native reference-frame allocation, including later resolution-change frames with false outer metadata. | Enforce libavcodec's allocation budget and inspect VP9 bitstream dimensions before decoding, including subsequent keyframes and software fallback. |
| Native transfer filesystem access — High | Transfer IPC allowed the whole app-data directory, including native trust records and fallback encryption keys. | Restrict it to transfer staging plus the existing Downloads boundary. Canonical-path tests verify secret files are outside the permitted scope. |
| Transfer resource/integrity checks — Medium | Malformed peer sizes, offsets, chunk sizes, IDs, and premature endings could consume unbounded memory/disk or falsely report success. | Bound browser framing and native downloads, verify transfer identities and exact sizes, cancel failed streams, and accept legitimate progress acknowledgments. |
| QUIC federation authentication — High | Signed Hello messages were reusable on another connection/destination because they omitted role and channel binding. | Sign a domain-separated canonical transcript containing role and the TLS exporter binding; reject out-of-window future timestamps and malformed Unicode hex safely. Real pinned QUIC handshakes and bidirectional datagrams are tested. |
| Reusable transfer helpers — Medium, dormant | Shared helper filesystem names and incomplete upload completion were insufficiently constrained. | Validate filesystem identifiers, reserve active transfers atomically, bound resume/size accounting, require complete uploads, and drain buffered frames. Bind download IDs and ranges to supplied data. The download helper explicitly requires caller authorization; it does not define a new token scheme. |

Primary evidence: `client/src/lib/{media/senderKeys,crypto/doubleRatchet,media/transport/fileTransfer}.ts`, `client/src-tauri/src/native_media/{commands,file_transfer}.rs`, `crates/paracord-codec/src/{crypto,video/decoder,video/lavc/decoder}.rs`, and `crates/paracord-transport/src/{federation,file_transfer}.rs`.

## Dependencies

The lockfile updates Rustls to **0.23.45**, the patched version for its CRL enforcement advisory, and `event-listener` to **5.4.2**. Rustls-related `aws-lc` and WebPKI packages update accordingly. The Rustls minimum is also recorded in the workspace manifest. Sources: [Rustls advisory](https://github.com/rustls/rustls/security/advisories/GHSA-2mjx-qc3c-rqvc), [event-listener advisory](https://rustsec.org/advisories/RUSTSEC-2026-0221.html).

`cargo audit` reports **zero non-exempt vulnerabilities**, while retaining **9 unmaintained, 3 conditional soundness, and 2 yanked-package warnings**. `npm audit` reports **zero vulnerabilities**. No new audit exception was added. The existing RSA exception remains restricted to SQLx's unused MySQL graph and has a review deadline of 2026-09-30.

The three soundness warnings are `glib 0.18.5` (GTK/Tauri's `VariantStrIter`), `lru 0.16.3` (the optional S3 dependency graph; panic-safety conditions), and `rand 0.7.3` (the PHF code-generation graph; custom logger/RNG reentrancy). These are not represented as repaired. Updating the S3 SDK far enough to remove its LRU warning would also raise the SDK's Rust requirement beyond the currently configured CI toolchain, so that upgrade was not silently mixed into this security patch. See the [LRU advisory](https://rustsec.org/advisories/RUSTSEC-2026-0253.html).

## Verification

| Check | Result |
| --- | --- |
| Rust workspace `cargo test --workspace -j 2` | 1,675 passed, zero failed across 98 test/doc-test suites; 4 environment-dependent tests ignored (3 GPU, 1 system-audio capture). Final invite-redemption and mechanical iterator edits are verified separately below. |
| Client `npm test` | 284 test files, 2,749 tests passed; TypeScript and literal-color checks passed. |
| Chromium encrypted storage, durable DM, and prekey enrollment | 29 Playwright tests passed using actual browser cryptography/persistence and controlled API fixtures. |
| General/security API suites on PostgreSQL 16 | 35 passed: route smoke 2, realtime/SSE 13, attachment encryption 1, federation deep regressions 16, webhook delivery 3. |
| Federation API suites on SQLite | 51 passed: availability 7, deep regressions 16, regressions 25, scope 3; none ignored. |
| Account and bot API suites on SQLite and disposable PostgreSQL 16 | Current-source suites passed on each engine: 23 credential/account tests and 16 account/bot tests, including the primary-login race, distinct invite threshold, atomic redemption, and rollback regressions. |
| VP9/FFmpeg codec suite with `vpx,lavc` | 145 passed, 3 hardware-only tests ignored; the subsequent video-only run after the final allocation guard passed 63 with the same 3 ignored. |
| Final video-conversion iterator cleanup | 12 tests passed with `vpx,lavc`, covering RGBA/I420 conversion and downscaling after the mechanical Clippy cleanup. |
| Native file-download bounds | 1 focused native test passed with default VP9 enabled. The workspace suite also covers transfer staging path checks. |
| Transport library | 111 tests passed, none ignored. Includes real QUIC upload/download/resume, concurrent transfer rejection, strict signature checks, and federation handshakes/datagrams. |
| Durable MFA and credential locking | 7 DB tests passed, including an isolated PostgreSQL scenario exercising concurrent single-use claims, reopening the pool, secret replacement, enrollment/disable, and stale login snapshots. |
| Invite rate-counter transactions | 4 DB tests passed, including concurrent duplicate accounting and rollback fault injection. |
| Temporary running server HTTP checks | 9 security smoke assertions passed; 300 malformed-request iterations produced no 5xx responses. The tested executable was the debug server build. These probes are not coverage-guided fuzzing. |
| Temporary running server TLS checks | Missing and malformed certificates: nonzero exit and no HTTP/HTTPS listeners. Valid generated certificate: CA-verified HTTPS health and HTTP redirect passed. |
| Final server executable | `cargo build -p paracord-server -j 2` passed after the final invite fix. The HTTP/TLS smoke runs preceded that isolated invite change; its affected suite then passed on both database engines. |
| Migration sanity | 102 SQLite migrations applied; 103 PostgreSQL migrations passed parity checks. Actual PostgreSQL route tests are separate from this static/parity gate. |
| Dependency audit | npm: zero vulnerabilities. Cargo: zero non-exempt vulnerabilities, with the unresolved advisory warnings described above. |
| Rust lint and formatting | Final `cargo clippy --workspace -j 2 -- -D warnings` and `cargo fmt --all -- --check` passed. Whitespace checks passed with the repository's existing CRLF files preserved. |

The final workspace suite preceded the last isolated invite-redemption fix and mechanical constant-size iterator cleanup. The affected invite suites then passed on both database engines; video conversion tests, final workspace Clippy/formatting, and the rebuilt server also passed. Temporary test databases and server processes were shut down after verification.

## Limits and remaining exposure

- This pass includes independent review of the auth, federation, realtime, webhook, media, and storage patches. Tests include both rejection cases and legitimate workflows. It is not a production penetration test, prolonged fuzzing campaign, or proof of cryptographic protocol security.
- GPU-only codec tests, the explicitly ignored system-audio capture test, native Windows/macOS execution, external LiveKit and S3 deployments, and a production multi-server rolling upgrade were not exercised on this Linux host. VP9 remains enabled; it was not disabled to obtain passing builds.
- Short-lived federation file tokens retain their existing bounded capability semantics: the serving peer verifies the signed peer identity and current peer trust, while an already issued token lasts until expiry. Per-file user membership is checked when issuing the capability, not re-evaluated on each remote GET.
- Federation catch-up retains event-time ordering. The new cursor fixes equal-depth pagination and hidden-page progress; it is not a guarantee of recovery for events inserted later with an older depth. A malicious serving peer can still omit its own history under the existing federation trust model.
- Media sender keys use the existing server-authenticated participant roster binding. Adding end-user identity signatures would be a protocol/trust-model change and is not claimed by this patch.
- The development media binary is deliberately unauthenticated and is not equivalent to the production server. Reusable transport helpers require their documented caller authorization before exposing supplied file data.
- Upstream dependency warnings described above remain visible. Future advisories and undiscovered defects remain possible.
