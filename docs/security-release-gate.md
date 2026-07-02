# Security Release Gate

Date: 2026-05-17

This public gate records the P0 security remediation status required by
`scripts/security_gate_check.py`. It intentionally excludes private audit notes
and lower-priority working details from the local security tracker.

## Public Deployment Exit Gate

- [x] All `P0` tasks are `DONE`.
- [x] No unauthenticated high-impact mutation endpoints remain.
- [x] Desktop client does not globally bypass TLS verification.
- [x] External traffic defaults to HTTPS/WSS with redirect and HSTS.
- [x] CORS/rate-limit policy is deployment-aware and anti-spoof.
- [x] Attachment serving cannot execute attacker-controlled active content in origin.
- [x] Auth/token storage posture is updated for web and desktop threat model.
- [x] Security regression tests exist for fixed vulnerabilities.

## P0 Task Board

| ID | Pri | Task | Depends On | Status | Validation Notes |
|---|---|---|---|---|---|
| P0-01 | P0 | Restore TLS certificate validation in desktop app | - | DONE | Removed global TLS ignore paths from Tauri runtime; WebView2 certificate overrides plus Rust-side `probe_server` and `native_fetch` self-signed TLS paths are restricted to loopback or exact trusted server origins, and non-loopback origins must pass `/health` verification before renderer sync can store them. |
| P0-02 | P0 | Authenticate LiveKit webhook requests | - | DONE | Signed webhook JWT verification checks issuer, signature, and expiry before processing. |
| P0-03 | P0 | Fix registration-disable bypass in `/auth/verify` | - | DONE | Verification auto-registration enforces runtime `registration_enabled`. |
| P0-04 | P0 | Enforce permission checks for WS typing/voice opcodes | - | DONE | Channel membership/permission checks guard typing and voice WebSocket opcodes. |
| P0-05 | P0 | Add attachment ownership/binding model | DB migration | DONE | Attachments carry uploader/channel binding plus expiry metadata and stale cleanup. |
| P0-06 | P0 | Enforce moderation permission for member timeout updates | - | DONE | Timeout updates require moderation-equivalent permission and hierarchy checks. |
| P0-07 | P0 | Fix member DB scoping (`guild_id` ignored in updates) | DB migration | DONE | Member updates restore `(user_id, guild_id)` scoping in DB and query layer. |
| P0-08 | P0 | Prevent attachment-based script execution | P0-05 | DONE | Active content is forced to download/octet-stream with `nosniff`; attachment open flow hardened; upload policy checks use the downgraded MIME type before allowlist/denylist decisions; custom emoji/sticker image assets use authenticated image loading and `nosniff`. |
| P0-09 | P0 | Enforce HTTPS/WSS-first serving, redirect HTTP, add HSTS | - | DONE | HTTP redirects to HTTPS when TLS is enabled; secure URL generation and HSTS headers are in place. |
| P0-10 | P0 | Lock down CORS and anti-spoof rate limiting | - | DONE | Explicit CORS allowlist and proxy-aware IP rate limiting with stricter auth throttles are in place. |
