# Security Dependency Policy

## Scope
- Rust workspace dependencies (`Cargo.lock`)
- Desktop lockfile (`client/src-tauri/Cargo.lock`)
- Web dependencies (`client/package-lock.json`)

## Required Controls
1. Run `cargo audit` and `npm audit` before every release.
2. Run scheduled dependency audit workflow weekly.
3. Block release when:
   - new critical/high vulnerabilities are introduced,
   - a P0 security task remains open,
   - an advisory exception has expired.

## Advisory Exception Rules
- Exceptions must be documented in `.cargo/audit.toml`.
- Every exception must include:
  - explicit advisory ID,
  - rationale,
  - fixed review/expiry date.
- Exceptions are temporary and must be revisited at each release.

## Current Exceptions
- `RUSTSEC-2023-0071` (`rsa` via `sqlx-mysql` in sqlx macro internals, SQLite-only deployment path).
- `RUSTSEC-2026-0194` and `RUSTSEC-2026-0195` (`quick-xml 0.37.5` through the
  Tauri Windows notification helper). The reachable code uses only
  `quick_xml::escape` to construct outbound toast XML, not the vulnerable
  `Reader`/`NsReader` parsing APIs. Re-review by 2026-08-10.

Review dates are tracked per exception in `.cargo/audit.toml` and enforced by
`scripts/check_audit_exceptions.py`.
