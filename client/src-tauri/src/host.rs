//! "Paracord on this computer": the commands the first run and Settings use
//! to host a server from the desktop app (docs/setup-spec.md §2, §9.5).
//!
//! Stubs registered by S0 so the command names exist for every later package.
//! Each answers `Err("not built")` until S7 builds it on `paracord-hostctl`;
//! the branch never merges with one left (`rg not_built`). Progress for
//! `host_setup_start` arrives as `host://progress` events
//! (`paracord_contracts::host::HostProgress`).
//!
//! Arguments use Tauri's default camelCase on the JS side
//! (`invoke('host_write_escrow', { wrappingKey })`).

use paracord_contracts::credential::NewOwnerClaim;
use paracord_contracts::host::{BackupNowResponse, HostPreflight, HostStatus};

fn not_built<T>() -> Result<T, String> {
    Err("not built".to_string())
}

/// Checks this computer can host (spec §2.3).
#[tauri::command]
pub async fn host_preflight() -> Result<HostPreflight, String> {
    not_built()
}

/// Runs setup rows 1, 2, 4 and 5 (spec §2.6), emitting `host://progress`.
#[tauri::command]
pub async fn host_setup_start(port: u16) -> Result<(), String> {
    let _ = port;
    not_built()
}

/// Claims the hosted instance on loopback; Rust reads the claim token from the
/// claim file. Returns the server's `ClaimResponse` JSON.
#[tauri::command]
pub async fn host_claim(request: NewOwnerClaim) -> Result<serde_json::Value, String> {
    let _ = request;
    not_built()
}

/// Writes the storage-key escrow (spec §4.7). `wrapping_key` is b64url.
#[tauri::command]
pub async fn host_write_escrow(wrapping_key: String) -> Result<(), String> {
    let _ = wrapping_key;
    not_built()
}

#[tauri::command]
pub async fn host_status() -> Result<HostStatus, String> {
    not_built()
}

#[tauri::command]
pub async fn host_retry_reachability() -> Result<(), String> {
    not_built()
}

#[tauri::command]
pub async fn host_backup_now() -> Result<BackupNowResponse, String> {
    not_built()
}

#[tauri::command]
pub async fn host_start() -> Result<(), String> {
    not_built()
}

#[tauri::command]
pub async fn host_stop() -> Result<(), String> {
    not_built()
}

/// "Starts when you sign in to this computer".
#[tauri::command]
pub async fn host_set_autostart(enabled: bool) -> Result<(), String> {
    let _ = enabled;
    not_built()
}

/// Removes the service; deletes the server's data only when asked.
#[tauri::command]
pub async fn host_remove(delete_data: bool) -> Result<(), String> {
    let _ = delete_data;
    not_built()
}

/// The last `lines` lines of the server log.
#[tauri::command]
pub async fn host_logs_tail(lines: u32) -> Result<String, String> {
    let _ = lines;
    not_built()
}

/// Restores a backup archive with the escrowed key (spec §4.8).
#[tauri::command]
pub async fn host_restore(archive_path: String, wrapping_key: String) -> Result<(), String> {
    let _ = (archive_path, wrapping_key);
    not_built()
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn every_stub_says_it_is_not_built() {
        assert_eq!(super::host_preflight().await.unwrap_err(), "not built");
        assert_eq!(super::host_start().await.unwrap_err(), "not built");
        assert_eq!(super::host_logs_tail(10).await.unwrap_err(), "not built");
    }
}
