//! Server identity decisions the first run and the identity-changed sheet make
//! (docs/setup-spec.md §7.3, §7.4, §9.5).
//!
//! Stubs registered by S0 so the command names exist for every later package.
//! Each answers `Err("not built")` until S10 builds it next to the pinning
//! verifier; the branch never merges with one left (`rg not_built`).
//!
//! Arguments use Tauri's default camelCase on the JS side
//! (`invoke('accept_changed_identity', { host, presentedFp })`).

fn not_built<T>() -> Result<T, String> {
    Err("not built".to_string())
}

/// Pins `fingerprint` for `url`'s host, only if it is the fingerprint the
/// server presents right now (spec §7.3).
#[tauri::command]
pub async fn trust_server(url: String, fingerprint: String) -> Result<(), String> {
    let _ = (url, fingerprint);
    not_built()
}

/// Re-pins `host` to `presented_fp`, only if that is the recorded mismatch
/// (spec §7.4).
#[tauri::command]
pub async fn accept_changed_identity(host: String, presented_fp: String) -> Result<(), String> {
    let _ = (host, presented_fp);
    not_built()
}
