# Paracord Security Audit and Release Decision — 2026-07-10

## Decision

**Conditional GO for the server, web client, and Linux-tested source tree.** No
known open first-party Critical or High vulnerability remains in the audited
tree after the remediations below. The source meets a reasonable senior-engineer
security bar for release, subject to the release conditions at the end of this
document.

**Do not publish cross-platform desktop binaries yet** until signed Windows,
macOS, and Linux packages are built and smoke-tested in their native CI
environments. The Windows cross-check attempted on this Linux host stopped in a
native dependency build because the MSVC `lib.exe` toolchain was unavailable;
macOS-specific code cannot be compiled here. A live PostgreSQL upgrade/migration
smoke is also still required. These are verification gaps, not known exploitable
defects.

This audit reviewed the effective working tree, including extensive in-flight
changes, rather than assuming the earlier July report still described current
code. It is a source review, dependency review, regression exercise, and local
DAST pass—not a claim of formal verification or a substitute for an independent
penetration test.

## Scope and method

- Authentication, session revocation, MFA, cookies, CSRF, login abuse controls,
  reset/verification links, proxy trust, and secret handling.
- Guild/channel/message/role/bot authorization, IDOR boundaries, interaction
  callbacks, federation, uploads, storage paths, and outbound SSRF surfaces.
- HTTP/SSE/WebSocket/QUIC trust boundaries, rate limits, replay handling,
  malformed input, resource caps, and security logging.
- React rendering and URL handling, Tauri CSP/IPC/native networking, certificate
  pinning, updater configuration, camera/screen/system-audio capture, secure
  storage, diagnostics, and deep links.
- Cargo/npm dependency advisories, build reproducibility, migrations, release
  compilation, static checks, unit/integration tests, and release-binary DAST.
- The prior 42-finding July 5 audit was used as an inventory, but important
  controls were re-read and re-tested against the current tree. New and changed
  media/desktop/interaction code received additional review.

## Findings closed in this pass

| Severity | Finding | Resolution |
| --- | --- | --- |
| High | Windows WebView2 accepted any certificate error for an approved origin, bypassing the native TOFU leaf pin for WSS/LiveKit traffic. | Certificate-error overrides now require the exact stored SHA-256 leaf fingerprint for non-loopback hosts. Missing/corrupt pins require fresh native approval, and a new pin must persist before the origin is activated. |
| High | Any member who could read a bot-authored message could forge an arbitrary component `custom_id`; modal submissions could name any installed bot/action without proof that the bot issued the modal. | Component type, ID, enabled state, select cardinality/options, and selected guild entities are bound to the persisted message. Issued modal definitions are persisted, user/app/guild/channel-bound, validated, atomically consumed, and single-use. |
| High | New renderer-callable native camera and screen APIs could enumerate devices/windows, capture thumbnails, and start broadcasting without a trusted native consent boundary. | Camera access and non-portal screen capture require an OS-owned confirmation that the renderer cannot answer. Consent is short-lived, revoked on teardown, and all privileged native prompts are serialized to prevent dialog stacking. Linux screen capture remains mediated by its OS portal. |
| High | Proxy documentation allowed CIDRs, but code matched only exact IP strings; trusted proxies selected the attacker-controlled leftmost `X-Forwarded-For` value. This broke shared-client limits in CIDR deployments and allowed spoofed rate-limit/security-event addresses when proxies appended incoming XFF. | A shared IPv4/IPv6 exact/CIDR resolver now verifies the socket peer, walks XFF from the trusted right edge, fails closed on malformed chains, and normalizes IPv6 `/64` abuse buckets. API auth, rate limiting, security events, and WebSocket pre-auth all use it. Edge-proxy examples overwrite incoming XFF. |
| Medium | A common browser user-agent could become a hard login lock, allowing five bad attempts to deny service to unrelated users with the same UA. Raw account/device/UA values were also stored as guard keys. | Only IP/device keys can hard-block. UA and account keys are signal-only, and all guard values are SHA-256-derived before persistence. |
| Medium | A legacy Base32 TOTP secret that was syntactically valid Base64 was misclassified as ciphertext after at-rest encryption was enabled, locking users out of MFA. Enabling at-rest protection without SQLite/file targets also failed to construct the TOTP cryptor. | Decryption now requires Paracord's authenticated envelope marker after Base64 decoding; otherwise the original legacy secret is preserved. Any enabled at-rest master key now derives the TOTP cryptor independently of file/SQLite target selection. |
| Medium | Changing guild visibility to `roles` while omitting `allowed_roles` could retain an empty list, which the read path interpreted as visible to everyone. | Core computes and validates the effective role list; role-gated visibility cannot be persisted without at least one valid role. |
| Medium | Native JSON/download/SSE responses and diagnostics had unbounded accumulation paths, allowing a malicious trusted server or renderer to consume memory/disk. | JSON, upload, download, SSE event/buffer, diagnostic line/file, trusted-server-list, and pending stream/download ticket limits are enforced. Diagnostics rotate and use private directory/file modes. |
| Low | Invite bearer tokens were written verbatim to desktop diagnostics; renderer log input allowed multiline/control-character injection. | Deep-link URLs are redacted before logging. Diagnostic input is single-line, control-sanitized, bounded, sensitive-pattern-redacted, serialized, and rotated. |
| Low | Wire tracing logged raw query strings (including download tickets), and slow-request tracing used concrete paths that could contain interaction webhook tokens. | Wire tracing records only query presence. Slow-request and rate-class tracing prefer matched route templates. |
| Low | Scheduled-event cover images accepted arbitrary URL schemes and rendered the stored value without the shared client URL sanitizer. | The API now accepts only bounded HTTPS URLs, rejects credentials and local-file/script/plain-HTTP schemes, and the client independently sanitizes the stored value before rendering. |
| High (dependency/dev tooling) | The complete npm graph reported a critical Vitest advisory and high Vite/Undici advisories even though the production-only audit was clean. | The lockfile was refreshed within declared version ranges (including Vitest 4.1.10, Vite 6.4.3, and Undici 7.28.0); full `npm audit --audit-level=low` now reports zero vulnerabilities. |

The earlier July 5 audit's 42 confirmed findings (1 Critical, 4 High, 18
Medium, 19 Low) remain represented in `security-audit/REPORT.md`. Its previously
partial renderer-driven native-trust finding is materially closed by an
OS-native approval boundary, exact-origin activation, strict health identity,
and durable TOFU pin enforcement. First-use TOFU remains an explicit
architectural residual below.

## Verification evidence

| Control | Result |
| --- | --- |
| `cargo fmt --all -- --check` | Pass |
| `cargo check --workspace --tests` | Pass |
| `cargo test --workspace` | Pass; hardware-only GPU tests ignored as designed |
| `cargo clippy --workspace --all-targets -- -D warnings` | Pass for first-party crates; generated PipeWire/libspa dependency warnings remain outside the lint cap |
| `cargo build --release --bin paracord-server` | Pass |
| Interaction authorization regressions | Pass: forged ID/type rejected, issued modal accepted, replay/unissued modal rejected |
| Proxy resolver regressions | Pass: CIDR, trusted chain, spoofed prefix, malformed input, IPv6 `/64` |
| MFA/visibility/diagnostic/certificate-pin regressions | Pass |
| `npm run build` | Pass (TypeScript + Vite production build) |
| `npm test` | Pass: 150 files, 1,045 tests |
| `npm audit --audit-level=low` | Pass: 0 vulnerabilities |
| `cargo audit` | Exit 0; 21 documented upstream warnings and 3 time-boxed exceptions |
| Audit exception expiry check | Pass: all 3 exceptions inside review window |
| Release server DAST | Pass: headers, CORS, admin auth, LiveKit allowlist, path traversal, auth challenge |
| API malformed-input fuzz | Pass: 160 requests, no 5xx |
| Project P0 security gate | Pass: 10/10 marked done |
| Windows target check | Attempted; blocked before first-party compilation by missing MSVC `lib.exe`/native toolchain on Linux host |
| Live PostgreSQL migration/route smoke | Not run: no PostgreSQL service configured on this host |

## Accepted residual risks

1. **TOFU first contact.** Self-hosted servers often use self-signed
   certificates. The first approved HTTPS contact can therefore still be
   intercepted if the user's network is already hostile; subsequent contacts
   are pinned. Operators needing stronger first-contact identity should use a
   publicly trusted certificate or distribute/verify the server fingerprint out
   of band.
2. **Remote-content privacy.** CSP still permits remote HTTPS images and secure
   WebSockets because chat media and arbitrary self-hosted server connections
   require them. Remote media can reveal a viewer's IP/time/user-agent to the
   remote host. Proxied media would reduce this but changes product architecture
   and server bandwidth requirements.
3. **Process-local controls.** Some rate limits, tickets, and connection budgets
   are per process. A horizontally scaled deployment needs a shared limiter to
   obtain a strict cluster-wide budget.
4. **Upstream desktop dependencies.** Cargo reports 21 allowed warnings,
   principally GTK3/Tauri transitive maintenance warnings plus documented
   `glib`, `rand 0.7`, and codec concerns. Their scope and review dates are in
   `release-risk-waivers.md`; they are not silently accepted here.
5. **Dirty-tree provenance.** The audit covers the effective tree, but the
   repository contains extensive unrelated in-flight changes. A release must be
   cut from a clean, reviewed commit and the gates rerun on that exact revision.

## Mandatory release conditions

1. Build signed Windows, macOS, and Linux desktop packages in native CI and
   smoke: server trust prompts/pin mismatch, updater signature rejection,
   camera/screen/system-audio consent, deep links, secure-store fallback, and
   native voice/video with VP9 enabled.
2. Run both fresh and upgrade migrations plus representative auth,
   interaction/modal, and role-visibility routes against a real PostgreSQL
   service. SQLite migrations and the full SQLite-backed suite already pass.
3. Have the release owner explicitly accept or reject every item in
   `release-risk-waivers.md`; do not infer approval from `cargo audit` exiting
   zero.
4. Create a clean release commit, review its complete diff, and rerun formatting,
   clippy, full Rust/client tests, both audits, the release build, and DAST on
   that exact commit before tagging.

If those four conditions pass without new findings, this audit supports a
senior-engineering declaration that Paracord is reasonably secure enough to
ship. As of this host-local review, the code is ready for that final release
validation, but cross-platform desktop publication remains on hold.
