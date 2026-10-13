//! Instance status and hosting controls (docs/setup-spec.md §4.7, §5.5, §8.5,
//! §9.1): the same `HostStatus` the desktop app reads over the loopback
//! control channel (`routes/host.rs`), for headless installs and
//! Admin › Settings.
//!
//! This file also holds the logic both route families share: the status
//! collector, the backup runner (the loopback `backup-now`, the scheduled
//! backup in `paracord-server` and the "Back up now" the app asks for before an
//! update all go through [`run_backup`]) and the escrow pre-checks.
//!
//! # Seams
//!
//! Facts that belong to other packages of the setup program and are not
//! known to this crate. They are isolated in [`seams`]:
//!
//! Storage (`seams::storage`, `seams::write_escrow`) is S4's and is wired to
//! `paracord_core::storage_key`. Reachability (`seams::reachability`,
//! `seams::request_reachability_retry`) is S5's and is wired to
//! `paracord_core::reachability::hub()`.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use axum::{
    extract::{ConnectInfo, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use base64::Engine as _;
use paracord_contracts::host::{
    BackupStatus, HostStatus, Reachability, ReachabilityState, StorageKeyEscrowRequest,
    StorageStatus, TlsStatus, UpdateBackupsRequest,
};
use paracord_core::AppState;
use serde_json::json;
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::middleware::AdminUser;
use crate::routes::security;

/// `server_settings` key that overrides `[backup] auto_backup_enabled`
/// (spec §8.5). Values: `"true"` / `"false"`.
pub const SETTING_AUTO_BACKUP_ENABLED: &str = "auto_backup_enabled";
/// `server_settings` key: RFC 3339 time of the last successful backup.
pub const SETTING_BACKUP_LAST_AT: &str = "backup_last_at";
/// `server_settings` key: what the last failed backup said; empty after a
/// success.
pub const SETTING_BACKUP_LAST_ERROR: &str = "backup_last_error";

/// A route failed in a way the plain `ApiError` set cannot say.
pub enum StatusError {
    Api(ApiError),
}

impl From<ApiError> for StatusError {
    fn from(err: ApiError) -> Self {
        StatusError::Api(err)
    }
}
impl From<paracord_core::error::CoreError> for StatusError {
    fn from(err: paracord_core::error::CoreError) -> Self {
        StatusError::Api(err.into())
    }
}
impl From<paracord_db::DbError> for StatusError {
    fn from(err: paracord_db::DbError) -> Self {
        StatusError::Api(err.into())
    }
}

impl IntoResponse for StatusError {
    fn into_response(self) -> Response {
        match self {
            StatusError::Api(err) => err.into_response(),
        }
    }
}

// ── The seams ───────────────────────────────────────────────────────────────

/// Facts and actions that belong to S4 and S5. Replace the bodies, keep the
/// signatures.
pub mod seams {
    use super::*;

    /// `StorageStatus` as the running server observed it at start (spec §4.5,
    /// `paracord_core::storage_key`): `sqlite_encrypted` from the live pool,
    /// the key source and protection the key was resolved from. `escrowed`
    /// is whether the escrow file is on disk now.
    pub fn storage(_state: &AppState, escrowed: bool) -> StorageStatus {
        StorageStatus {
            escrowed,
            ..paracord_core::storage_key::status()
        }
    }

    /// The reachability state machine's current value (S5,
    /// `paracord_core::reachability`). `off` on the bound port when nothing is
    /// asking a router (forwarding disabled, a loopback bind, or a server
    /// that never started the state machine).
    pub fn reachability(state: &AppState) -> Reachability {
        let mut current = paracord_core::reachability::hub().current();
        if current.port == 0 {
            current.port = bound_port(&state.config.bind_address);
        }
        current
    }

    /// Run a router attempt now. There is no one to ask when forwarding is off:
    /// a retry that did nothing would be a silent no-op, so say so.
    pub async fn request_reachability_retry(_state: &AppState) -> Result<(), StatusError> {
        let hub = paracord_core::reachability::hub();
        if hub.current().state == ReachabilityState::Off {
            return Err(StatusError::Api(ApiError::Conflict(
                "Paracord isn't asking your router to let friends in, so there is nothing to \
                 try again."
                    .to_string(),
            )));
        }
        hub.request_retry();
        Ok(())
    }

    /// Wrap the storage key under `wrapping_key` (AES-256-GCM, AAD
    /// `"paracord/host-storage-escrow/v1|" + instance_id`, spec §4.7) and write
    /// the escrow JSON to `path` (`paracord_core::storage_key`), naming
    /// `owner_public_key` (already checked against the owner by
    /// [`super::store_escrow`]). With `replace`, a stale escrow at `path` is
    /// swapped for the new one by a rename, so a failure keeps the old file.
    pub async fn write_escrow(
        wrapping_key: &[u8; 32],
        owner_public_key: &str,
        path: &Path,
        replace: bool,
    ) -> Result<(), StatusError> {
        use paracord_core::storage_key::EscrowWriteError;
        let runtime = paracord_core::storage_key::current();
        let map = |error: EscrowWriteError| {
            StatusError::Api(match error {
                EscrowWriteError::AlreadyEscrowed => super::already_escrowed(),
                EscrowWriteError::NotEncrypted | EscrowWriteError::NotConfigured => {
                    ApiError::Conflict(error.to_string())
                }
                EscrowWriteError::BadRequest(message) => ApiError::BadRequest(message),
                EscrowWriteError::Io(message) => {
                    ApiError::Internal(anyhow::anyhow!("escrow write failed: {message}"))
                }
            })
        };
        if !replace {
            runtime
                .write_escrow_at(path, wrapping_key, owner_public_key)
                .map_err(map)?;
        } else {
            let mut staged = path.as_os_str().to_owned();
            staged.push(".replacing");
            let staged = PathBuf::from(staged);
            let _ = std::fs::remove_file(&staged);
            runtime
                .write_escrow_at(&staged, wrapping_key, owner_public_key)
                .map_err(map)?;
            if let Err(error) = std::fs::rename(&staged, path) {
                let _ = std::fs::remove_file(&staged);
                return Err(map(EscrowWriteError::Io(error.to_string())));
            }
        }
        paracord_core::storage_key::notify_changed();
        Ok(())
    }
}

fn bound_port(bind_address: &str) -> u16 {
    bind_address
        .rsplit_once(':')
        .and_then(|(_, port)| port.parse().ok())
        .unwrap_or(0)
}

// ── TLS identity ────────────────────────────────────────────────────────────

struct TlsIdentitySource {
    cert_path: PathBuf,
    self_signed: bool,
}

static TLS_IDENTITY: OnceLock<TlsIdentitySource> = OnceLock::new();

/// Called once at startup by the server when it serves TLS. The fingerprint is
/// computed from the file on every status request, so a renewed certificate is
/// reported as soon as it is on disk.
pub fn set_tls_identity(cert_path: impl Into<PathBuf>, self_signed: bool) {
    let _ = TLS_IDENTITY.set(TlsIdentitySource {
        cert_path: cert_path.into(),
        self_signed,
    });
}

/// SHA-256 of the first certificate's DER in a PEM file, lowercase hex.
pub fn certificate_fingerprint(pem: &str) -> Option<String> {
    const BEGIN: &str = "-----BEGIN CERTIFICATE-----";
    const END: &str = "-----END CERTIFICATE-----";
    let start = pem.find(BEGIN)? + BEGIN.len();
    let end = start + pem[start..].find(END)?;
    let body: String = pem[start..end]
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect();
    let der = base64::engine::general_purpose::STANDARD
        .decode(body)
        .ok()?;
    let digest = Sha256::digest(der);
    Some(digest.iter().map(|b| format!("{b:02x}")).collect())
}

/// `TlsStatus`. With TLS off the fingerprint is empty and `self_signed` false
/// (the contract has no "off" value; an empty fingerprint is it).
async fn tls_status() -> Result<TlsStatus, ApiError> {
    let Some(source) = TLS_IDENTITY.get() else {
        return Ok(TlsStatus {
            fingerprint_sha256: String::new(),
            self_signed: false,
        });
    };
    let pem = tokio::fs::read_to_string(&source.cert_path)
        .await
        .map_err(|err| {
            ApiError::Internal(anyhow::anyhow!(
                "cannot read the TLS certificate {}: {err}",
                source.cert_path.display()
            ))
        })?;
    let fingerprint_sha256 = certificate_fingerprint(&pem).ok_or_else(|| {
        ApiError::Internal(anyhow::anyhow!(
            "{} does not contain a readable certificate",
            source.cert_path.display()
        ))
    })?;
    Ok(TlsStatus {
        fingerprint_sha256,
        self_signed: source.self_signed,
    })
}

// ── Backups ─────────────────────────────────────────────────────────────────

/// The effective "back up automatically" switch: the saved choice wins over
/// `[backup] auto_backup_enabled`, like `registration_mode` (spec §8.5).
pub async fn auto_backup_enabled(state: &AppState) -> bool {
    match paracord_db::server_settings::get_setting(&state.db, SETTING_AUTO_BACKUP_ENABLED).await {
        Ok(Some(value)) => match value.as_str() {
            "true" => true,
            "false" => false,
            other => {
                tracing::warn!(
                    "server_settings.{SETTING_AUTO_BACKUP_ENABLED} is '{other}', which is neither \"true\" nor \"false\"; using [backup] auto_backup_enabled from the config instead"
                );
                state.config.auto_backup_enabled
            }
        },
        Ok(None) => state.config.auto_backup_enabled,
        Err(err) => {
            tracing::warn!(
                "could not read server_settings.{SETTING_AUTO_BACKUP_ENABLED} ({err}); using [backup] auto_backup_enabled from the config instead"
            );
            state.config.auto_backup_enabled
        }
    }
}

async fn record_backup_outcome(state: &AppState, outcome: Result<(), &str>) {
    let writes = match outcome {
        Ok(()) => vec![
            (SETTING_BACKUP_LAST_AT, chrono::Utc::now().to_rfc3339()),
            (SETTING_BACKUP_LAST_ERROR, String::new()),
        ],
        Err(message) => vec![(SETTING_BACKUP_LAST_ERROR, message.to_string())],
    };
    for (key, value) in writes {
        if let Err(err) = paracord_db::server_settings::set_setting(&state.db, key, &value).await {
            tracing::warn!("could not record {key}: {err}");
        }
    }
}

/// Create one backup archive, keep the newest `max_backups` and record the
/// outcome for `HostStatus.backups`. Returns the archive's file name.
pub async fn run_backup(
    state: &AppState,
    include_media: bool,
    max_backups: u32,
) -> Result<String, paracord_core::error::CoreError> {
    let created = paracord_core::backup::create_backup_from_pool(
        &state.db,
        &state.config.database_url,
        &state.config.backup_dir,
        &state.config.storage_path,
        &state.config.media_storage_path,
        include_media,
        matches!(
            state.storage_backend.as_ref(),
            paracord_media::Storage::Local(_)
        ),
        state.config.file_cryptor.as_ref(),
        state.config.totp_cryptor.as_ref(),
    )
    .await;
    let name = match created {
        Ok(name) => name,
        Err(err) => {
            record_backup_outcome(state, Err(&err.to_string())).await;
            publish_backups(state).await;
            return Err(err);
        }
    };
    record_backup_outcome(state, Ok(())).await;

    // Never prune to nothing: a configured 0 would delete the backup just made.
    let keep = max_backups.max(1) as usize;
    if let Ok(backups) = paracord_core::backup::list_backups(&state.config.backup_dir).await {
        for old in backups.into_iter().skip(keep) {
            let path = Path::new(&state.config.backup_dir).join(&old.name);
            match tokio::fs::remove_file(&path).await {
                Ok(()) => tracing::info!("Pruned old backup: {}", old.name),
                Err(err) => tracing::warn!("Could not prune old backup {}: {err}", old.name),
            }
        }
    }
    publish_backups(state).await;
    Ok(name)
}

/// Report the current backup status to the reachability hub, which announces
/// any change to admins as `INSTANCE_STATUS_UPDATE` (spec §5.5). Called once at
/// startup and after every backup and every change of the switch.
pub async fn publish_backups(state: &AppState) {
    paracord_core::reachability::hub().set_backups(backup_status(state).await);
}

async fn backup_status(state: &AppState) -> BackupStatus {
    let setting = |key: &'static str| {
        let db = state.db.clone();
        async move {
            paracord_db::server_settings::get_setting(&db, key)
                .await
                .ok()
                .flatten()
                .filter(|value| !value.is_empty())
        }
    };
    let last_error = setting(SETTING_BACKUP_LAST_ERROR).await;
    let last_backup_at = match setting(SETTING_BACKUP_LAST_AT).await {
        Some(at) => Some(at),
        // A backup taken before this server recorded its own: the newest
        // archive's time is still the truth.
        None => paracord_core::backup::list_backups(&state.config.backup_dir)
            .await
            .ok()
            .and_then(|backups| backups.into_iter().next())
            .map(|backup| backup.created_at),
    };
    BackupStatus {
        enabled: auto_backup_enabled(state).await,
        interval_seconds: state.config.auto_backup_interval_seconds,
        keep: state.config.max_backups,
        last_backup_at,
        last_error,
    }
}

// ── Escrow ──────────────────────────────────────────────────────────────────

/// Where `storage-key.escrow` lives: `[host] escrow_file`, or for a headless
/// install without a `[host]` section, next to the data directory.
pub fn escrow_path(state: &AppState) -> PathBuf {
    match &state.config.host.escrow_file {
        Some(path) => PathBuf::from(path),
        None => Path::new(&state.config.storage_path)
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("storage-key.escrow"),
    }
}

/// 409 `escrow_exists`: this owner's escrow for this instance is on disk.
fn already_escrowed() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "escrow_exists",
        message: "the storage key is already escrowed".into(),
    }
}

/// 409 `escrow_owner_mismatch`: the wrapping key was derived from an identity
/// that is not the owner's current one.
fn escrow_owner_mismatch() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "escrow_owner_mismatch",
        message: "That recovery phrase isn't the server owner's current one (the owner started \
                  over with a new phrase), so it can't protect the storage key. Use the owner's \
                  current recovery phrase."
            .into(),
    }
}

/// Shared by `POST /host/storage-key/escrow` and `POST /admin/storage-key/escrow`.
///
/// An escrow is always sealed for the owner's *current* identity key: the
/// request names the public key its wrapping key was derived from, and a key
/// that is not the owner's `users.public_key` is refused
/// (`escrow_owner_mismatch`), since the escrow file would name one key while
/// only another phrase could open it. One escrow per instance and owner key:
/// the wrapping key is never stored, so a second call could only replace a good
/// escrow (`escrow_exists`). An escrow left from before the owner started over
/// (another owner key) or for another instance is stale and is replaced.
pub async fn store_escrow(
    state: &AppState,
    request: &StorageKeyEscrowRequest,
) -> Result<(), StatusError> {
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(request.wrapping_key.trim_end_matches('='))
        .map_err(|_| ApiError::BadRequest("wrapping_key must be base64url".into()))?;
    let wrapping_key: [u8; 32] = decoded
        .try_into()
        .map_err(|_| ApiError::BadRequest("wrapping_key must be 32 bytes".into()))?;
    let claimed_key = request.owner_public_key.trim().to_ascii_lowercase();
    if paracord_util::hex::hex_decode(&claimed_key).is_none_or(|key| key.len() != 32) {
        return Err(ApiError::BadRequest("owner_public_key must be hex of 32 bytes".into()).into());
    }
    let path = escrow_path(state);
    let existing = if tokio::fs::try_exists(&path).await.unwrap_or(false) {
        // An escrow that cannot be read is never overwritten: it may be good.
        Some(
            paracord_core::storage_key::read_escrow_file(&path)
                .map_err(|_| StatusError::Api(already_escrowed()))?,
        )
    } else {
        None
    };
    let owner_key = owner_public_key(state).await?;
    if claimed_key != owner_key {
        return Err(escrow_owner_mismatch().into());
    }
    let replace = match existing {
        None => false,
        Some(escrow) => {
            let instance_id = paracord_core::storage_key::current().instance_id;
            if Some(escrow.instance_id.as_str()) == instance_id.as_deref()
                && escrow
                    .owner_public_key
                    .trim()
                    .eq_ignore_ascii_case(&owner_key)
            {
                return Err(already_escrowed().into());
            }
            true
        }
    };
    seams::write_escrow(&wrapping_key, &owner_key, &path, replace).await
}

/// The claiming owner's identity public key (lowercase hex): an escrow names
/// it, so there has to be one.
async fn owner_public_key(state: &AppState) -> Result<String, StatusError> {
    let setup = paracord_db::instance_setup::get(&state.db)
        .await
        .map_err(ApiError::from)?;
    let owner_id = setup.claimed_by_user_id.ok_or_else(|| {
        ApiError::Conflict(
            "this server has no owner yet, so there is no recovery phrase to escrow the key under"
                .into(),
        )
    })?;
    let owner = paracord_db::users::get_user_by_id(&state.db, owner_id)
        .await
        .map_err(ApiError::from)?
        .ok_or_else(|| ApiError::Conflict("the server's owner account no longer exists".into()))?;
    let public_key = owner
        .public_key
        .map(|key| key.trim().to_ascii_lowercase())
        .filter(|key| !key.is_empty())
        .ok_or_else(|| {
            ApiError::Conflict("the owner has no identity key yet; finish the account first".into())
        })?;
    Ok(public_key)
}

// ── Status ──────────────────────────────────────────────────────────────────

/// The one `HostStatus` both route families return.
pub async fn collect(state: &AppState) -> Result<HostStatus, ApiError> {
    let setup_required = paracord_db::instance_setup::is_pending(&state.db).await?;
    let escrowed = tokio::fs::try_exists(escrow_path(state))
        .await
        .unwrap_or(false);
    Ok(HostStatus {
        version: env!("CARGO_PKG_VERSION").to_string(),
        started_at: state.config.started_at.to_rfc3339(),
        setup_required,
        storage: seams::storage(state, escrowed),
        reachability: seams::reachability(state),
        backups: backup_status(state).await,
        tls: tls_status().await?,
        instance_id: paracord_core::storage_key::current().instance_id,
    })
}

// ── Admin handlers ──────────────────────────────────────────────────────────

/// `GET /api/v1/admin/host-status` — admin → `HostStatus`.
pub async fn get_host_status(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<Json<HostStatus>, ApiError> {
    Ok(Json(collect(&state).await?))
}

/// `POST /api/v1/admin/reachability/retry` — admin → 202.
pub async fn retry_reachability(
    State(state): State<AppState>,
    _admin: AdminUser,
) -> Result<StatusCode, StatusError> {
    seams::request_reachability_retry(&state).await?;
    Ok(StatusCode::ACCEPTED)
}

/// `POST /api/v1/admin/storage-key/escrow` — the owner → 204; 409 when the
/// key is already escrowed.
pub async fn write_escrow(
    State(state): State<AppState>,
    admin: AdminUser,
    Json(body): Json<StorageKeyEscrowRequest>,
) -> Result<StatusCode, StatusError> {
    let setup = paracord_db::instance_setup::get(&state.db)
        .await
        .map_err(ApiError::from)?;
    if setup.claimed_by_user_id != Some(admin.user_id) {
        return Err(ApiError::Forbidden.into());
    }
    store_escrow(&state, &body).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// `PATCH /api/v1/admin/backups` — admin, `UpdateBackupsRequest` → 204.
pub async fn update_backups(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    admin: AdminUser,
    headers: HeaderMap,
    Json(body): Json<UpdateBackupsRequest>,
) -> Result<StatusCode, ApiError> {
    let peer_ip = addr.ip().to_string();
    paracord_db::server_settings::set_setting(
        &state.db,
        SETTING_AUTO_BACKUP_ENABLED,
        if body.enabled { "true" } else { "false" },
    )
    .await?;
    publish_backups(&state).await;
    security::log_security_event(
        &state,
        "admin.backups.update",
        Some(admin.user_id),
        None,
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "enabled": body.enabled })),
    )
    .await;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_is_sha256_of_the_der() {
        // DER "abc" -> base64 "YWJj"; sha256("abc") is the well-known vector.
        let pem = "-----BEGIN CERTIFICATE-----\nYWJj\n-----END CERTIFICATE-----\n";
        assert_eq!(
            certificate_fingerprint(pem).as_deref(),
            Some("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        );
        assert_eq!(certificate_fingerprint("no certificate here"), None);
    }

    #[test]
    fn bound_port_reads_the_last_segment() {
        assert_eq!(bound_port("0.0.0.0:8443"), 8443);
        assert_eq!(bound_port("[::]:9000"), 9000);
        assert_eq!(bound_port("nonsense"), 0);
    }
}
