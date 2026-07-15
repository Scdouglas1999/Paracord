# Release Risk Waivers

Date: 2026-07-10

This file records known dependency and platform risks that are not fixed in-tree
for the current release-readiness pass. These are not automatic approvals. A
release owner should explicitly accept or reject each waiver before publishing a
GitHub release.

## Cargo Audit

Current command:

```bash
cargo audit
```

Current result after the July 10 remediation: `cargo audit` exits 0 with no
unignored vulnerability failures. It reports 21 allowed warnings and three
explicit ignores in `.cargo/audit.toml`.

`cargo audit -D warnings` fails with those same 21 warnings, which is expected
until the release owner accepts or rejects the waivers below.

### Explicit Ignore

| Advisory | Crate | Rationale | Recheck |
| --- | --- | --- | --- |
| `RUSTSEC-2023-0071` | `rsa` via `sqlx-mysql` | Carried through SQLx internals. Paracord documents SQLite/PostgreSQL support, not MySQL runtime usage. | Remove when upstream SQLx no longer brings this path into the graph or if MySQL support is added. |
| `RUSTSEC-2026-0194`, `RUSTSEC-2026-0195` | `quick-xml 0.37.5` via `tauri-winrt-notification` | The advisory affects `Reader`/`NsReader`; the reachable Windows-toast code uses only `quick_xml::escape` for outbound notification text. The separate plist path is updated to quick-xml 0.41.0. | Recheck by 2026-08-10; remove when the Tauri notification graph upgrades or its use reaches XML parsing. |

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
| `RUSTSEC-2026-0150` | `audiopus_sys` | unmaintained | `audiopus` through `paracord-codec` | Required by the Opus media codec. No patched upstream replacement is available in the current codec API. | Re-evaluate when `audiopus` offers a maintained backend or the media codec stack is upgraded. |
| `RUSTSEC-2025-0057` | `fxhash 0.2.1` | unmaintained | Tauri HTML/CSS parsing stack | Transitive dependency through Tauri/Wry utilities. No first-party hash-table use. | Recheck with Tauri/Wry updates. |
| `RUSTSEC-2025-0075` | `unic-char-range 0.9.0` | unmaintained | Tauri URL pattern utilities | Transitive desktop tooling dependency. | Recheck with Tauri updates. |
| `RUSTSEC-2025-0080` | `unic-common 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0081` | `unic-char-property 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0098` | `unic-ucd-version 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2025-0100` | `unic-ucd-ident 0.9.0` | unmaintained | Tauri URL pattern utilities | Same as above. | Same as above. |
| `RUSTSEC-2024-0436` | `paste` | unmaintained | Transitive desktop/media dependency | Build-time macro dependency; no maintained drop-in is available without an upstream dependency update. | Recheck with Tauri/media dependency upgrades. |
| `RUSTSEC-2024-0429` | `glib 0.18.5` | unsound | Tauri/Wry Linux desktop stack | Unsound iterator implementation in transitive GTK/glib stack. Server release path is unaffected. | Recheck when Tauri/Wry updates GTK/glib dependencies. |
| `RUSTSEC-2026-0097` | `rand 0.7.3` | unsound | Tauri HTML/CSS parsing stack | Advisory requires custom logger interaction with `rand::rng()`. This version is transitive through generated/parser tooling. | Recheck after upstream parser/Tauri updates. |

## Release Conditions

- Do not treat these waivers as approval for a final public release by
  themselves.
- Re-run `cargo audit` on the final branch after dependency updates and before
  tagging.
- If any warning becomes an unignored vulnerability failure, stop the release
  until it is fixed or explicitly waived with a tighter rationale.
- Build and smoke signed Windows, macOS, and Linux desktop packages in their
  native CI environments. In particular, exercise certificate-pin mismatch,
  updater signature rejection, secure storage, and camera/screen/audio consent.
  The Windows cross-check on the Linux audit host could not pass the native
  dependency build because the MSVC `lib.exe` toolchain was unavailable.
- If Linux desktop packages are included, perform a real package smoke because
  many current warnings are in the Linux desktop stack.
