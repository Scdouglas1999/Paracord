//! Hosting from the desktop app and the instance status an owner sees (setup
//! spec §2, §4.5, §4.7, §5.2, §9.1, §9.2, §9.5).
//!
//! Timestamps are RFC 3339 strings.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// What the router said, or what this computer knows, about whether people
/// outside the home network can reach this server (spec §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum ReachabilityState {
    /// Automatic forwarding is off, or the server binds loopback.
    Off,
    /// An attempt is in flight.
    Asking,
    /// The router accepted both mappings and reported a public IPv4.
    Open,
    /// The router's own external address is private (carrier-grade NAT or
    /// another router in front).
    SharedAddress,
    /// A gateway answered and refused.
    Refused,
    /// No UPnP IGD, NAT-PMP or PCP gateway answered in time.
    NoAnswer,
    /// The bind interface has a public IPv4 itself.
    Direct,
    /// Windows only: the firewall rule is missing.
    FirewallBlocked,
}

/// The current reachability, as the server holds it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Reachability {
    pub state: ReachabilityState,
    /// `"upnp"`, `"nat-pmp"` or `"pcp"`.
    pub method: Option<String>,
    /// Only ever what the router reported.
    pub external_ip: Option<String>,
    pub gateway_ip: Option<String>,
    pub lan_ip: Option<String>,
    pub port: u16,
    pub lease_expires_at: Option<String>,
    pub next_retry_at: Option<String>,
    pub last_error: Option<String>,
    /// When a connection from outside this network was observed.
    pub confirmed_at: Option<String>,
}

/// Where the at-rest storage key lives (`[at_rest] key_source`, spec §4.2).
/// Spelled the same in the config file and on the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    /// The OS credential store of the user the server runs as.
    Keychain,
    /// A `systemd-creds` credential loaded by the unit.
    SystemdCreds,
    /// A 0600 key file.
    File,
    /// An environment variable (`[at_rest] key_env`).
    Env,
}

impl KeySource {
    /// The config and wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            KeySource::Keychain => "keychain",
            KeySource::SystemdCreds => "systemd-creds",
            KeySource::File => "file",
            KeySource::Env => "env",
        }
    }

    /// Parse the config spelling. Anything else is `None`.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim() {
            "keychain" => Some(KeySource::Keychain),
            "systemd-creds" => Some(KeySource::SystemdCreds),
            "file" => Some(KeySource::File),
            "env" => Some(KeySource::Env),
            _ => None,
        }
    }
}

/// What protects the storage key, which decides the copy (spec §4.6).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum Protection {
    /// Unlocked by the user's sign-in (login keychain).
    Login,
    /// Sealed to the machine's TPM.
    Tpm,
    /// Protected by the machine's own credentials.
    Machine,
    /// Stored on the same disk as the data.
    SameDisk,
}

impl Protection {
    /// The config and wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Protection::Login => "login",
            Protection::Tpm => "tpm",
            Protection::Machine => "machine",
            Protection::SameDisk => "same_disk",
        }
    }
}

/// Stored-data encryption as the running server observes it (spec §4.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StorageStatus {
    pub enabled: bool,
    /// From `PRAGMA cipher_version` on the live pool, not from config.
    pub sqlite_encrypted: bool,
    pub files_encrypted: bool,
    pub key_source: Option<KeySource>,
    pub protection: Option<Protection>,
    /// The storage key is escrowed under the owner's recovery phrase (§4.7).
    pub escrowed: bool,
}

/// Automatic backups.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct BackupStatus {
    pub enabled: bool,
    pub interval_seconds: u64,
    /// How many backups are kept.
    pub keep: u32,
    pub last_backup_at: Option<String>,
    pub last_error: Option<String>,
}

/// This server's TLS identity. Trust words are computed from the fingerprint by
/// the client (spec §7.1).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct TlsStatus {
    /// hex SHA-256 of the leaf certificate's DER.
    pub fingerprint_sha256: String,
    pub self_signed: bool,
}

/// `GET /api/v1/host/status` (loopback + host token) and
/// `GET /api/v1/admin/host-status` (admins).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostStatus {
    pub version: String,
    pub started_at: String,
    /// True until the first owner claims the instance.
    pub setup_required: bool,
    pub storage: StorageStatus,
    pub reachability: Reachability,
    pub backups: BackupStatus,
    pub tls: TlsStatus,
    /// `[host] instance_id`: the HKDF info of the owner's escrow key (spec
    /// §4.7), so a headless owner's first-run page can escrow the storage key
    /// after the claim (§2.11). Absent on a server that has none (and on
    /// servers older than this field).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
}

/// Gateway `INSTANCE_STATUS_UPDATE`, sent to admins whenever any of these
/// changes (spec §5.5).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct InstanceStatusUpdate {
    pub reachability: Reachability,
    pub storage: StorageStatus,
    pub backups: BackupStatus,
}

/// `POST /api/v1/host/storage-key/escrow` and
/// `POST /api/v1/admin/storage-key/escrow`: the key that wraps the storage key
/// (spec §4.7). Never stored.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct StorageKeyEscrowRequest {
    /// b64url of the 32-byte `escrow_key`.
    pub wrapping_key: String,
    /// Hex of the identity public key `wrapping_key` was derived from. It must
    /// be the owner's current key (`users.public_key`), else 409
    /// `escrow_owner_mismatch`: an escrow is always sealed for the owner's
    /// current recovery phrase.
    pub owner_public_key: String,
}

/// `PATCH /api/v1/admin/backups` (spec §8.5).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct UpdateBackupsRequest {
    pub enabled: bool,
}

/// `POST /api/v1/host/backup-now` response.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct BackupNowResponse {
    /// The archive's file name.
    pub name: String,
}

/// `storage-key.escrow` and `BackupManifest.recovery.key_escrow` (spec §4.7):
/// the storage key under AES-256-GCM with
/// `aad = "paracord/host-storage-escrow/v1|" + instance_id`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct StorageKeyEscrow {
    /// Always 1.
    pub version: u8,
    pub instance_id: String,
    /// hex of the owner's identity public key.
    pub owner_public_key: String,
    /// b64url of the 12-byte IV.
    pub iv: String,
    /// b64url of ciphertext + tag.
    pub ciphertext: String,
}

/// Why the desktop app cannot host on this computer (spec §2.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostPreflightReason {
    NoUserServices,
    NoKeychain,
    ExistingServer,
    /// Never blocks: setup resumes at the first incomplete row.
    AlreadyHosting,
    NoPort,
    NoSpace,
}

/// Tauri `host_preflight()`: `{ ok: true, port }` or
/// `{ ok: false, reason, detail?, existing_url? }`; `already_hosting` comes
/// with `ok: true`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostPreflight {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<HostPreflightReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// With `existing_server`: the URL to sign in to instead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub existing_url: Option<String>,
}

/// A step of `host_setup_start` (spec §2.6). Row 3 (the account) runs in JS.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostSetupStep {
    Install,
    Init,
    Service,
    Start,
    Storage,
    Reach,
    Backup,
}

/// The state a setup row is in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum HostProgressState {
    Run,
    Ok,
    Warn,
    Fail,
}

/// Tauri event `host://progress`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct HostProgress {
    /// The setup row, 1-5.
    pub row: u8,
    pub step: HostSetupStep,
    pub state: HostProgressState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    /// A machine-readable reason, e.g. a reachability state or exit code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn spellings_match_the_config_and_spec() {
        for source in [
            KeySource::Keychain,
            KeySource::SystemdCreds,
            KeySource::File,
            KeySource::Env,
        ] {
            assert_eq!(
                serde_json::to_value(source).unwrap(),
                json!(source.as_str())
            );
            assert_eq!(KeySource::parse(source.as_str()), Some(source));
        }
        assert_eq!(KeySource::parse("systemd_creds"), None);
        for protection in [
            Protection::Login,
            Protection::Tpm,
            Protection::Machine,
            Protection::SameDisk,
        ] {
            assert_eq!(
                serde_json::to_value(protection).unwrap(),
                json!(protection.as_str())
            );
        }
        assert_eq!(
            serde_json::to_value(ReachabilityState::SharedAddress).unwrap(),
            json!("shared_address")
        );
        assert_eq!(
            serde_json::to_value(ReachabilityState::FirewallBlocked).unwrap(),
            json!("firewall_blocked")
        );
        assert_eq!(
            serde_json::to_value(HostPreflightReason::NoUserServices).unwrap(),
            json!("no_user_services")
        );
    }

    #[test]
    fn preflight_and_progress_leave_out_what_is_absent() {
        let ok = HostPreflight {
            ok: true,
            port: Some(8443),
            reason: None,
            detail: None,
            existing_url: None,
        };
        assert_eq!(
            serde_json::to_value(ok).unwrap(),
            json!({ "ok": true, "port": 8443 })
        );
        let progress = HostProgress {
            row: 1,
            step: HostSetupStep::Install,
            state: HostProgressState::Run,
            detail: None,
            code: None,
        };
        assert_eq!(
            serde_json::to_value(progress).unwrap(),
            json!({ "row": 1, "step": "install", "state": "run" })
        );
    }
}
