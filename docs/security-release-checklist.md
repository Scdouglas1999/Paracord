# Security Release Checklist

## Pre-Release Gate
- [ ] All `P0` tasks are `DONE` in `docs/security-release-gate.md`; `SECURITY_REMEDIATION_TRACKER.md` is only a private developer fallback and must not be the public release authority.
- [ ] `cargo audit` passes with no unignored vulnerabilities; warning waivers are documented in `docs/release-risk-waivers.md` and explicitly accepted by the release owner.
- [ ] `npm audit` reports no unresolved high/critical findings.
- [ ] Security regression tests pass.
- [ ] HTTP->HTTPS redirect and HSTS verified in staging.
- [ ] CORS allowlist and proxy trust settings verified for deployment profile.
- [ ] Endpoint checklist reviewed for new/changed APIs (`docs/security-endpoint-checklist.md`).
- [ ] UI security checklist reviewed for new/changed client features (`docs/security-ui-checklist.md`).

## Key Security Validation
- [ ] LiveKit webhook signature validation verified.
- [ ] Federation ingest signature validation verified (if enabled).
- [ ] WS typing/voice unauthorized payloads rejected.
- [ ] Attachment upload/link/download restrictions validated.
- [ ] Admin restart-update endpoint disabled in production profile.

## Operational Controls
- [ ] Incident runbook reviewed.
- [ ] TLS certificate/key rotation plan confirmed.
- [ ] Backup/rollback plan confirmed.
- [ ] On-call owner sign-off captured.
