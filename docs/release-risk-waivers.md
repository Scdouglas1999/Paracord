# Release Risk Waivers

Date: 2026-05-18

This file records known dependency and platform risks that are not fixed in-tree
for the current release-readiness pass. These are not automatic approvals. A
release owner should explicitly accept or reject each waiver before publishing a
GitHub release.

## Cargo Audit

Current command:

```bash
cargo audit
```

Current result after the May 18 rerun: `cargo audit` exits 0 with no
unignored vulnerability failures. It reports 23 allowed warnings and one
explicit ignore in `.cargo/audit.toml`.

`cargo audit -D warnings` fails with those same 23 warnings, which is expected
until the release owner accepts or rejects the waivers below.

### Explicit Ignore

| Advisory | Crate | Rationale | Recheck |
| --- | --- | --- | --- |
| `RUSTSEC-2023-0071` | `rsa` via `sqlx-mysql` | Carried through SQLx internals. Paracord documents SQLite/PostgreSQL support, not MySQL runtime usage. | Remove when upstream SQLx no longer brings this path into the graph or if MySQL support is added. |

### Warning Waivers

| Advisory | Crate | Kind | Source | Release rationale | Recheck |
| --- | --- | --- | --- | --- | --- |
| `RUSTSEC-2024-0411` | `gdkwayland-sys 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Transitive desktop packaging dependency. Server release path is unaffected. Linux desktop release still requires CI/package smoke. | Recheck when Tauri/Wry migrates away from GTK3 bindings. |
| `RUSTSEC-2024-0412` | `gdk 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0413` | `atk 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0414` | `gdkx11-sys 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0415` | `gtk 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0416` | `atk-sys 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0417` | `gdkx11 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0418` | `gdk-sys 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0419` | `gtk3-macros 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0420` | `gtk-sys 0.18.2` | unmaintained | Tauri/Wry Linux desktop stack | Same as above. | Same as above. |
| `RUSTSEC-2024-0370` | `proc-macro-error 1.0.4` | unmaintained | GTK/glib macros | Build-time/transitive macro dependency. No direct runtime use in first-party code. | Recheck with Tauri/Wry and gtk-rs updates. |
| `RUSTSEC-2024-0375` | `atty 0.2.14` | unmaintained | `nnnoiseless` through `paracord-codec` | Native audio noise-suppression dependency. Replacing it is non-trivial and should not be rushed before release. | Re-evaluate RNNoise/noise-suppression dependency strategy before a media-focused stable release. |
| `RUSTSEC-2025-0057` | `fxhash 0.2.1` | unmaintained | Tauri HTML/CSS parsing stack | Transitive dependency through Tauri/Wry utilities. No first-party hash-table use. | Recheck with Tauri/Wry updates. |
| `RUSTSEC-2025-0075` | `unic-char-range 0.9.0` | unmaintained | Tauri URL pattern utilities | Transitive desktop tooling dependency. | Recheck with Tauri updates. |
| `RUSTSEC-2025-0080` | `unic-common 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0081` | `unic-char-property 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0098` | `unic-ucd-version 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0100` | `unic-ucd-ident 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2021-0145` | `atty 0.2.14` | unsound | `nnnoiseless` through `paracord-codec` | RustSec issue is an unaligned read in `atty`; current path is transitive through audio/noise-suppression CLI dependency graph. | Track replacement or upstream removal. |
| `RUSTSEC-2024-0429` | `glib 0.18.5` | unsound | Tauri/Wry Linux desktop stack | Unsound iterator implementation in transitive GTK/glib stack. Server release path is unaffected. | Recheck when Tauri/Wry updates GTK/glib dependencies. |
| `RUSTSEC-2026-0097` | `rand 0.7.3` | unsound | Tauri HTML/CSS parsing stack | Advisory requires custom logger interaction with `rand::rng()`. This version is transitive through generated/parser tooling. | Recheck after upstream parser/Tauri updates. |
| `RUSTSEC-2026-0097` | `rand 0.8.5` | unsound | SQLx/scap/parser utilities plus first-party workspace rand | Advisory requires custom logger interaction with `rand::rng()`. Keep monitoring because this version is also used directly by first-party crates. | Upgrade when patched rand or dependency graph guidance is available. |
| `RUSTSEC-2026-0097` | `rand 0.9.2` | unsound | Tokio/Tauri/quinn/gateway stack | Advisory requires custom logger interaction with `rand::rng()`. | Upgrade when patched rand or dependency graph guidance is available. |

## Release Conditions

- Do not treat these waivers as approval for a final public release by
  themselves.
- Re-run `cargo audit` on the final branch after dependency updates and before
  tagging.
- If any warning becomes an unignored vulnerability failure, stop the release
  until it is fixed or explicitly waived with a tighter rationale.
- If Linux desktop packages are included, perform a real Linux package smoke
  because many current warnings are in the Linux desktop stack.
