use std::path::PathBuf;

/// First line of the file `stage-host-sidecar.mjs --placeholder` writes. A
/// placeholder lets compile-only jobs (check, clippy, coverage) build the
/// crate; it must never be bundled.
const PLACEHOLDER_MARKER: &str = "PARACORD-HOST-PLACEHOLDER";

fn main() {
    check_host_sidecar();
    tauri_build::build();
}

/// `bundle.externalBin` lists `binaries/paracord-host` (docs/setup-spec.md
/// §2.1). Tauri would stop on a missing file with a bare "resource path
/// doesn't exist"; say what to do instead, and refuse to ship a placeholder.
fn check_host_sidecar() {
    println!("cargo:rerun-if-changed=binaries");
    let target = std::env::var("TARGET").expect("cargo sets TARGET");
    let ext = if target.contains("windows") {
        ".exe"
    } else {
        ""
    };
    let name = format!("paracord-host-{target}{ext}");
    let dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
            .join("binaries");
    let path = dir.join(&name);
    println!("cargo:rerun-if-changed={}", path.display());

    let Ok(bytes) = std::fs::read(&path) else {
        panic!(
            "\n\nThe host server sidecar is missing: {}\n\
             The desktop app bundles paracord-host (it is what runs a server on this computer).\n\
             Stage it with:  cd client && npm run host:stage\n\
             (a release build: npm run host:stage -- --release --target {target})\n\
             Compile-only jobs (check, clippy) can use:  npm run host:stage -- --placeholder\n",
            path.display()
        );
    };
    let is_placeholder = bytes.starts_with(PLACEHOLDER_MARKER.as_bytes());
    let release = std::env::var("PROFILE").is_ok_and(|p| p == "release");
    if is_placeholder && release {
        panic!(
            "\n\n{} is a placeholder, and a release build would bundle it.\n\
             Stage the real binary:  cd client && npm run host:stage -- --release --target {target}\n",
            path.display()
        );
    }
}
