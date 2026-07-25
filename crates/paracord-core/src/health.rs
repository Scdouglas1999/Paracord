//! Operator health check.
//!
//! v1 gave operators four counters and nothing else: no way to see whether the
//! deployment was actually healthy, backed up, reachable, or up to date. This
//! module answers "is my server OK, and if not what do I do about it" — every
//! finding carries a severity and a concrete fix.

use serde::Serialize;
use std::path::Path;

use crate::{AppConfig, AppState};

/// How serious a finding is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Needs attention now — data loss or outage risk.
    Critical,
    /// Should be fixed, but the server works.
    Warning,
    /// Informational; no action strictly required.
    Info,
}

/// A single actionable finding.
#[derive(Debug, Clone, Serialize)]
pub struct Check {
    /// Stable identifier so the UI can link to a fix.
    pub id: &'static str,
    pub severity: Severity,
    pub title: String,
    /// What to actually do about it.
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct HealthReport {
    pub version: &'static str,
    pub uptime_seconds: i64,
    pub database: DatabaseHealth,
    pub storage: StorageHealth,
    pub backups: BackupHealth,
    pub network: NetworkHealth,
    pub media: MediaHealth,
    pub counts: Counts,
    /// Findings, most severe first. Empty means a clean bill of health.
    pub checks: Vec<Check>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DatabaseHealth {
    /// "sqlite" or "postgres".
    pub engine: String,
    /// On-disk size in bytes; only meaningful for SQLite.
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageHealth {
    pub uploads_bytes: u64,
    pub media_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupHealth {
    pub auto_enabled: bool,
    pub interval_seconds: u64,
    pub count: usize,
    pub latest_at: Option<String>,
    pub latest_age_hours: Option<i64>,
    pub total_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct NetworkHealth {
    pub bind_address: String,
    pub public_url: Option<String>,
    pub tls_enabled: bool,
    pub tls_self_signed: bool,
    pub registration_open: bool,
    pub federation_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MediaHealth {
    pub native_enabled: bool,
    pub native_port: u16,
    pub livekit_available: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct Counts {
    pub users: i64,
    pub guilds: i64,
    pub messages: i64,
    pub channels: i64,
    pub online_users: usize,
}

/// Recursively sum file sizes under `path`. Returns 0 if unreadable — a
/// health check must never fail the request it is reporting on.
fn dir_size(path: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_dir() {
            total = total.saturating_add(dir_size(&entry.path()));
        } else {
            total = total.saturating_add(meta.len());
        }
    }
    total
}

/// Extract the on-disk path from a `sqlite://` URL.
fn sqlite_path(database_url: &str) -> Option<String> {
    let rest = database_url.strip_prefix("sqlite://")?;
    let path = rest.split('?').next()?;
    if path.is_empty() || path == ":memory:" {
        None
    } else {
        Some(path.to_string())
    }
}

/// Total on-disk footprint of a SQLite database.
///
/// The pool runs in WAL mode, so the main `.db` file can sit at a few KB while
/// megabytes of committed data live in the `-wal` sidecar. Reporting only the
/// main file tells the operator their database is empty when it is not.
fn sqlite_total_size(path: &str) -> Option<u64> {
    let main = std::fs::metadata(path).ok()?.len();
    let sidecars: u64 = ["-wal", "-shm"]
        .iter()
        .filter_map(|suffix| std::fs::metadata(format!("{path}{suffix}")).ok())
        .map(|m| m.len())
        .sum();
    Some(main.saturating_add(sidecars))
}

fn engine_of(database_url: &str) -> String {
    if database_url.starts_with("postgres") {
        "postgres".to_string()
    } else {
        "sqlite".to_string()
    }
}

pub async fn build_report(state: &AppState) -> Result<HealthReport, crate::error::CoreError> {
    let config: &AppConfig = &state.config;
    let stats = crate::admin::get_server_stats(&state.db).await?;

    let engine = engine_of(&config.database_url);
    let db_size = sqlite_path(&config.database_url).and_then(|p| sqlite_total_size(&p));

    let backups = crate::backup::list_backups(&config.backup_dir)
        .await
        .unwrap_or_default();
    // `list_backups` returns newest-first and stamps `created_at` from the
    // filename; an unparsable stamp simply yields no age rather than a bogus one.
    let latest = backups.first();
    let latest_age_hours = latest.and_then(|b| {
        chrono::DateTime::parse_from_rfc3339(&b.created_at)
            .ok()
            .map(|created| {
                (chrono::Utc::now() - created.with_timezone(&chrono::Utc))
                    .num_hours()
                    .max(0)
            })
    });

    let report_counts = Counts {
        users: stats.total_users,
        guilds: stats.total_guilds,
        messages: stats.total_messages,
        channels: stats.total_channels,
        online_users: state.online_users.len(),
    };

    let backup_health = BackupHealth {
        auto_enabled: config.auto_backup_enabled,
        interval_seconds: config.auto_backup_interval_seconds,
        count: backups.len(),
        latest_at: latest.map(|b| b.created_at.clone()),
        latest_age_hours,
        total_bytes: backups.iter().map(|b| b.size_bytes).sum(),
    };

    let network = NetworkHealth {
        bind_address: config.bind_address.clone(),
        public_url: config.public_url.clone(),
        tls_enabled: config.tls_enabled,
        tls_self_signed: config.tls_self_signed,
        registration_open: config.registration_enabled,
        federation_enabled: config.federation_enabled,
    };

    let checks = evaluate_checks(config, &backup_health, &network, &report_counts, db_size);

    Ok(HealthReport {
        version: env!("CARGO_PKG_VERSION"),
        uptime_seconds: (chrono::Utc::now() - config.started_at)
            .num_seconds()
            .max(0),
        database: DatabaseHealth {
            engine,
            size_bytes: db_size,
        },
        storage: StorageHealth {
            uploads_bytes: dir_size(Path::new(&config.storage_path)),
            media_bytes: dir_size(Path::new(&config.media_storage_path)),
        },
        backups: backup_health,
        network,
        media: MediaHealth {
            native_enabled: config.native_media_enabled,
            native_port: config.native_media_port,
            livekit_available: config.livekit_available,
        },
        counts: report_counts,
        checks,
    })
}

/// The actual advice engine. Each rule answers "what should the operator do?".
fn evaluate_checks(
    config: &AppConfig,
    backups: &BackupHealth,
    network: &NetworkHealth,
    counts: &Counts,
    db_size: Option<u64>,
) -> Vec<Check> {
    let mut checks = Vec::new();

    // --- Backups ---------------------------------------------------------
    if !backups.auto_enabled {
        checks.push(Check {
            id: "backups.disabled",
            severity: Severity::Critical,
            title: "Automatic backups are off".into(),
            detail: "Nothing is being backed up on a schedule. Turn on automatic backups so a bad migration or disk failure doesn't lose the server.".into(),
        });
    } else if backups.count == 0 {
        checks.push(Check {
            id: "backups.none_yet",
            severity: Severity::Warning,
            title: "No backup has run yet".into(),
            detail: "Automatic backups are enabled but none have completed. Take one now to confirm the backup directory is writable.".into(),
        });
    } else if let Some(age) = backups.latest_age_hours {
        // Stale means more than two intervals behind, floored at 48h.
        let interval_hours = (backups.interval_seconds / 3600).max(1) as i64;
        let stale_after = (interval_hours * 2).max(48);
        if age > stale_after {
            checks.push(Check {
                id: "backups.stale",
                severity: Severity::Warning,
                title: format!("Last backup was {age} hours ago"),
                detail: "Backups are enabled but the most recent one is old. Check the server log for backup errors and that the backup directory is writable.".into(),
            });
        }
    }

    // --- Transport safety -------------------------------------------------
    let loopback_only =
        network.bind_address.starts_with("127.") || network.bind_address.starts_with("[::1]");

    if !network.tls_enabled && !loopback_only {
        checks.push(Check {
            id: "tls.disabled",
            severity: Severity::Critical,
            title: "TLS is off and the server is not loopback-only".into(),
            detail: "Passwords and tokens are crossing the network in plaintext. Enable TLS, or put a reverse proxy that terminates HTTPS in front of this server. Browsers also block microphone, camera, and screen share without HTTPS.".into(),
        });
    } else if network.tls_self_signed {
        checks.push(Check {
            id: "tls.self_signed",
            severity: Severity::Info,
            title: "Using a self-signed certificate".into(),
            detail: "Browsers show a warning on first visit. The desktop client trusts it automatically. For a public instance, use ACME/Let's Encrypt or a reverse proxy certificate.".into(),
        });
    }

    if network.public_url.is_none() && !loopback_only {
        checks.push(Check {
            id: "network.no_public_url",
            severity: Severity::Warning,
            title: "No public URL is set".into(),
            detail: "Invite links and federation use this address. Set it to the URL people outside your network will use to reach the server.".into(),
        });
    }

    // --- Access -----------------------------------------------------------
    if network.registration_open && counts.users == 0 {
        checks.push(Check {
            id: "auth.no_owner",
            severity: Severity::Warning,
            title: "No account has been created yet".into(),
            detail: "The first account registered becomes the server owner. Register yours before sharing the URL with anyone else.".into(),
        });
    }

    if network.federation_enabled {
        checks.push(Check {
            id: "federation.enabled",
            severity: Severity::Info,
            title: "Federation is enabled".into(),
            detail: "Other servers can exchange messages with this one. Confirm your trusted-peer list and signing keys are what you expect.".into(),
        });
    }

    // --- Capacity ---------------------------------------------------------
    if engine_of(&config.database_url) == "sqlite" {
        if let Some(size) = db_size {
            // SQLite is fine for small instances; flag once it is genuinely large.
            const LARGE_DB: u64 = 2 * 1024 * 1024 * 1024;
            if size > LARGE_DB {
                checks.push(Check {
                    id: "database.sqlite_large",
                    severity: Severity::Warning,
                    title: "SQLite database is over 2 GB".into(),
                    detail: "SQLite is intended for small self-hosted instances. Consider migrating to PostgreSQL with `paracord-server migrate-to-postgres` before the instance grows further.".into(),
                });
            }
        }
        if counts.users > 200 {
            checks.push(Check {
                id: "database.sqlite_users",
                severity: Severity::Info,
                title: "Consider PostgreSQL at this user count".into(),
                detail: "PostgreSQL is recommended for sustained multi-user production use. The offline migrator supports a dry run.".into(),
            });
        }
    }

    // --- Media ------------------------------------------------------------
    if !config.native_media_enabled && !config.livekit_available {
        checks.push(Check {
            id: "media.none",
            severity: Severity::Critical,
            title: "No working voice/video backend".into(),
            detail: "Native media is disabled and no LiveKit server is reachable, so voice and video will fail. Re-enable native media, or configure LiveKit.".into(),
        });
    }

    // Most severe first, so the UI can lead with what matters.
    checks.sort_by_key(|c| match c.severity {
        Severity::Critical => 0,
        Severity::Warning => 1,
        Severity::Info => 2,
    });
    checks
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_backups() -> BackupHealth {
        BackupHealth {
            auto_enabled: true,
            interval_seconds: 86_400,
            count: 3,
            latest_at: None,
            latest_age_hours: Some(2),
            total_bytes: 1024,
        }
    }

    fn base_network() -> NetworkHealth {
        NetworkHealth {
            bind_address: "0.0.0.0:8443".into(),
            public_url: Some("https://chat.example.com".into()),
            tls_enabled: true,
            tls_self_signed: false,
            registration_open: true,
            federation_enabled: false,
        }
    }

    fn base_counts() -> Counts {
        Counts {
            users: 5,
            guilds: 1,
            messages: 100,
            channels: 4,
            online_users: 1,
        }
    }

    fn config_for(database_url: &str) -> AppConfig {
        let mut config = AppConfig::test_default();
        config.database_url = database_url.into();
        config
    }

    fn has(checks: &[Check], id: &str) -> bool {
        checks.iter().any(|c| c.id == id)
    }

    #[test]
    fn healthy_deployment_reports_nothing() {
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &base_network(),
            &base_counts(),
            Some(1024),
        );
        assert!(checks.is_empty(), "expected clean report, got {checks:?}");
    }

    #[test]
    fn disabled_backups_are_critical() {
        let mut backups = base_backups();
        backups.auto_enabled = false;
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &backups,
            &base_network(),
            &base_counts(),
            Some(1024),
        );
        assert!(has(&checks, "backups.disabled"));
        assert_eq!(checks[0].severity, Severity::Critical);
    }

    #[test]
    fn plaintext_on_a_public_bind_is_critical() {
        let mut network = base_network();
        network.tls_enabled = false;
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &network,
            &base_counts(),
            Some(1024),
        );
        assert!(has(&checks, "tls.disabled"));
    }

    #[test]
    fn plaintext_on_loopback_is_fine() {
        let mut network = base_network();
        network.tls_enabled = false;
        network.bind_address = "127.0.0.1:8090".into();
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &network,
            &base_counts(),
            Some(1024),
        );
        assert!(
            !has(&checks, "tls.disabled"),
            "loopback-only dev servers must not be flagged"
        );
    }

    #[test]
    fn stale_backups_are_flagged_relative_to_the_interval() {
        let mut backups = base_backups();
        backups.latest_age_hours = Some(100);
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &backups,
            &base_network(),
            &base_counts(),
            Some(1024),
        );
        assert!(has(&checks, "backups.stale"));
    }

    #[test]
    fn a_fresh_backup_is_not_stale() {
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &base_network(),
            &base_counts(),
            Some(1024),
        );
        assert!(!has(&checks, "backups.stale"));
    }

    #[test]
    fn empty_instance_prompts_to_claim_the_owner_account() {
        let mut counts = base_counts();
        counts.users = 0;
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &base_network(),
            &counts,
            Some(1024),
        );
        assert!(has(&checks, "auth.no_owner"));
    }

    #[test]
    fn large_sqlite_suggests_postgres() {
        let checks = evaluate_checks(
            &config_for("sqlite://./data/paracord.db"),
            &base_backups(),
            &base_network(),
            &base_counts(),
            Some(3 * 1024 * 1024 * 1024),
        );
        assert!(has(&checks, "database.sqlite_large"));
    }

    #[test]
    fn postgres_deployments_skip_the_sqlite_advice() {
        let checks = evaluate_checks(
            &config_for("postgres://localhost/paracord"),
            &base_backups(),
            &base_network(),
            &base_counts(),
            Some(3 * 1024 * 1024 * 1024),
        );
        assert!(!has(&checks, "database.sqlite_large"));
        assert!(!has(&checks, "database.sqlite_users"));
    }

    #[test]
    fn sqlite_path_is_parsed_from_the_url() {
        assert_eq!(
            sqlite_path("sqlite://./data/paracord.db?mode=rwc").as_deref(),
            Some("./data/paracord.db")
        );
        assert_eq!(sqlite_path("sqlite://:memory:"), None);
        assert_eq!(sqlite_path("postgres://localhost/x"), None);
    }
}
