//! Offline recovery stages a new generation and publishes an explicit activation
//! configuration. It never replaces files referenced by the original config.
use crate::{cli::RestoreBackupArgs, config};
use anyhow::{bail, Context, Result};
use paracord_core::backup::{
    prepare_restore, recovery_sqlite_url, write_private_file, RestoreOptions,
};
use std::path::Path;

pub async fn run(args: &RestoreBackupArgs, config_path: &str) -> Result<()> {
    if !Path::new(config_path).is_file() {
        bail!("restore requires the existing recovery configuration; refusing to generate replacement secrets");
    }
    let mut recovered = config::Config::load(config_path)?;
    let profile = crate::build_at_rest_profile(&recovered)?;
    let engine = crate::map_db_engine(recovered.database.engine);
    let postgres = engine == paracord_db::DatabaseEngine::Postgres;
    let target_url = args
        .postgres_url_env
        .as_ref()
        .map(|name| {
            if !valid_environment_name(name) {
                bail!("invalid PostgreSQL URL environment variable name");
            }
            std::env::var(name).with_context(|| {
                format!("PostgreSQL target URL environment variable {name} is unset")
            })
        })
        .transpose()?;
    if postgres {
        let target = target_url.as_deref().context(
            "PostgreSQL archive requires --postgres-url-env naming a fresh isolated database",
        )?;
        if paracord_db::detect_database_engine(target)? != engine {
            bail!("recovery target is not PostgreSQL");
        }
        if same_postgres_database(&recovered.database.url, target)? {
            bail!("recovery target identifies the configured database; create a separate empty database first");
        }
    } else if target_url.is_some() {
        bail!("--postgres-url-env is only valid for PostgreSQL recovery");
    }
    if recovered.storage.storage_type != "local"
        && !recovered.storage.storage_type.is_empty()
        && args.media_dir.is_none()
    {
        bail!("S3 recovery requires --media-dir containing a separately exported uploads/ and files/ tree; this command does not download object storage");
    }
    // Read and validate external identity material before any database restore.
    // Never call startup helpers that generate missing TLS/federation keys.
    let tls = if recovered.tls.enabled {
        let certificate = std::fs::read(&recovered.tls.cert_path)
            .context("original TLS certificate is missing")?;
        let private_key = std::fs::read(&recovered.tls.key_path)
            .context("original TLS private key is missing")?;
        axum_server::tls_rustls::RustlsConfig::from_pem(certificate.clone(), private_key.clone())
            .await
            .context("recovery TLS certificate/private key is invalid or mismatched")?;
        Some((certificate, private_key))
    } else {
        None
    };
    let federation_key = if recovered.federation.enabled {
        let path = recovered
            .federation
            .signing_key_path
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("./data/federation_signing_key.hex");
        let bytes = std::fs::read(path).context("original federation signing key is missing")?;
        let key = std::str::from_utf8(&bytes)?.trim();
        paracord_federation::signing::signing_key_from_hex(key)
            .context("recovery federation signing key is invalid")?;
        Some(bytes)
    } else {
        None
    };
    tracing::info!("Preparing isolated recovery; the original database, media and configuration will remain in place.");
    let report = prepare_restore(RestoreOptions {
        archive: &args.archive,
        output_dir: &args.output_dir,
        engine,
        postgres_target_url: target_url.as_deref(),
        external_media: args.media_dir.as_deref(),
        sqlite_key_hex: profile.sqlite_key_hex,
        file_cryptor: profile.file_cryptor,
        secret_cryptor: profile.totp_cryptor,
        max_unpacked_bytes: args.max_unpacked_bytes,
    })
    .await?;
    let output = args.output_dir.canonicalize()?;
    let publish = async {
        recovered.database.url = match target_url {
            Some(url) => url,
            None => recovery_sqlite_url(&output.join("paracord.db"))?,
        };
        recovered.storage.storage_type = "local".into();
        recovered.storage.path = output.join("media/uploads").to_string_lossy().into_owned();
        recovered.media.storage_path = output.join("media/files").to_string_lossy().into_owned();
        recovered.backup.backup_dir = output.join("backups").to_string_lossy().into_owned();
        std::fs::create_dir(output.join("backups"))?;
        std::fs::create_dir(output.join("keys"))?;
        if let Some((certificate, private_key)) = tls {
            let cert_path = output.join("keys/tls-cert.pem");
            let key_path = output.join("keys/tls-key.pem");
            write_private_file(&cert_path, &certificate)?;
            write_private_file(&key_path, &private_key)?;
            recovered.tls.cert_path = cert_path.to_string_lossy().into_owned();
            recovered.tls.key_path = key_path.to_string_lossy().into_owned();
            recovered.tls.auto_generate = false;
        }
        if let Some(key) = federation_key {
            let path = output.join("keys/federation-signing-key.hex");
            write_private_file(&path, &key)?;
            recovered.federation.signing_key_path = Some(path.to_string_lossy().into_owned());
        }
        // ACME work directories must not collide with the retained generation.
        // Certificate renewal stays disabled until the operator installs this
        // recovered generation into the deployment's ACME workflow.
        recovered.tls.acme.enabled = false;
        recovered.tls.acme.auto_renew = false;
        if let Some(web_dir) = &mut recovered.server.web_dir {
            *web_dir = Path::new(web_dir).canonicalize().context("configured web UI directory is missing")?.to_string_lossy().into_owned();
        }
        let config_file = output.join("paracord.toml");
        let working_dir = std::env::current_dir()?;
        let binary = std::env::current_exe()?;
        let environment = activation_environment(&recovered);
        let mut shell = String::from("#!/usr/bin/env sh\nset -eu\n# Stop every old Paracord instance before using this recovery generation.\n");
        shell.push_str(&format!("cd {}\n", shell_quote(&working_dir.to_string_lossy())));
        shell.push_str(&format!("if [ ! -f {} ] || [ -f {} ]; then echo 'Recovery preparation is incomplete; refusing activation' >&2; exit 1; fi\n", shell_quote(&config_file.to_string_lossy()), shell_quote(&output.join("RESTORE_FAILED.txt").to_string_lossy())));
        for (name, value) in &environment { shell.push_str(&format!("export {name}={}\n", shell_quote(value))); }
        if recovered.at_rest.enabled {
            let name = &recovered.at_rest.key_env;
            if !valid_environment_name(name) { bail!("invalid at-rest key environment variable name"); }
            shell.push_str(&format!(": \"${{{name}:?Set the original at-rest master key before activation}}\"\n"));
        }
        shell.push_str(&format!("exec {} --config {}\n", shell_quote(&binary.to_string_lossy()), shell_quote(&config_file.to_string_lossy())));
        write_private_file(&output.join("activate.sh"), shell.as_bytes())?;
        let mut powershell = String::from("$ErrorActionPreference = 'Stop'\n# Stop every old Paracord instance before activation.\n");
        powershell.push_str(&format!("Set-Location {}\n", powershell_quote(&working_dir.to_string_lossy())));
        powershell.push_str(&format!("if (-not (Test-Path -LiteralPath {}) -or (Test-Path -LiteralPath {})) {{ throw 'Recovery preparation is incomplete; refusing activation' }}\n", powershell_quote(&config_file.to_string_lossy()), powershell_quote(&output.join("RESTORE_FAILED.txt").to_string_lossy())));
        for (name, value) in &environment { powershell.push_str(&format!("$env:{name} = {}\n", powershell_quote(value))); }
        if recovered.at_rest.enabled {
            powershell.push_str(&format!("if (-not $env:{}) {{ throw 'Set the original at-rest master key before activation' }}\n", recovered.at_rest.key_env));
        }
        powershell.push_str(&format!("& {} --config {}\nexit $LASTEXITCODE\n", powershell_quote(&binary.to_string_lossy()), powershell_quote(&config_file.to_string_lossy())));
        write_private_file(&output.join("activate.ps1"), powershell.as_bytes())?;
        let instructions = format!("# Verified recovery generation\n\nDatabase: {}. History epoch: {}. Attachments verified: {}. Encrypted secrets verified: {}.\n\n1. Read verification.json and retain the original archive, config, key environment and data. No original database/media files were replaced.\n2. Stop every Paracord instance using the old database. Keep the recovered PostgreSQL database isolated until cutover.\n3. Supply the same at-rest master key environment used during verification. It was deliberately not copied into this directory.\n4. Start with `sh activate.sh` (Unix) or `powershell -File activate.ps1` (Windows), or install paracord.toml in the service together with the environment overrides in those scripts. Do not keep an old PARACORD_DATABASE_URL or storage-path override.\n5. Verify sign-in, spaces, history and an attachment with existing clients before removing any retained data. Reconnect clients.\n6. Reconfigure certificate renewal: recovery retains and validates the existing certificate/key, but disables ACME jobs until their deployment paths are configured. The generated scripts retain the working directory used for restore.\n\nRollback: stop the recovered generation, then restart the old service with its original config/environment and untouched database/media. New writes made after cutover remain in the recovered generation and require deliberate reconciliation before rollback.\n\nThis report verifies server-side stored bytes and at-rest keys. End-to-end encrypted DM/history content still requires the users' client vault/session backups; identity recovery words alone do not restore those session keys.\n", report.database_engine, report.database_history_epoch, report.verified_attachments, report.verified_encrypted_secrets);
        write_private_file(&output.join("ACTIVATE.md"), instructions.as_bytes())?;
        // Publish configuration last: no partial preparation advertises a ready
        // generation. The source configuration and its secret bytes are retained.
        write_private_file(&config_file, toml::to_string_pretty(&recovered)?.as_bytes())?;
        Ok::<(), anyhow::Error>(())
    }.await;
    if let Err(error) = publish {
        let _ = write_private_file(&output.join("RESTORE_FAILED.txt"), b"Database verification completed, but activation configuration preparation failed. Do not activate this directory. Original data remains unchanged.\n");
        return Err(error);
    }
    tracing::info!("Recovery verified: {} attachments, {} encrypted secrets, {} repaired tails. Configuration: {}. Stop all old instances before activating; see ACTIVATE.md.", report.verified_attachments, report.verified_encrypted_secrets, report.repaired_channel_tails, output.join("paracord.toml").display());
    Ok(())
}

fn same_postgres_database(source: &str, target: &str) -> Result<bool> {
    let source = reqwest::Url::parse(source).context("configured PostgreSQL URL is invalid")?;
    let target = reqwest::Url::parse(target).context("target PostgreSQL URL is invalid")?;
    Ok(source.host_str() == target.host_str()
        && source.port().unwrap_or(5432) == target.port().unwrap_or(5432)
        && source.path() == target.path())
}

fn valid_environment_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .enumerate()
            .all(|(i, b)| b == b'_' || b.is_ascii_alphabetic() || (i > 0 && b.is_ascii_digit()))
}
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
fn powershell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
fn activation_environment(config: &config::Config) -> Vec<(&'static str, String)> {
    vec![
        ("PARACORD_DATABASE_URL", config.database.url.clone()),
        (
            "PARACORD_DATABASE_ENGINE",
            match config.database.engine {
                config::DatabaseEngine::Sqlite => "sqlite",
                config::DatabaseEngine::Postgres => "postgres",
            }
            .into(),
        ),
        ("PARACORD_STORAGE_TYPE", "local".into()),
        ("PARACORD_STORAGE_PATH", config.storage.path.clone()),
        (
            "PARACORD_MEDIA_STORAGE_PATH",
            config.media.storage_path.clone(),
        ),
        ("PARACORD_BACKUP_DIR", config.backup.backup_dir.clone()),
        (
            "PARACORD_FEDERATION_SIGNING_KEY_PATH",
            config
                .federation
                .signing_key_path
                .clone()
                .unwrap_or_default(),
        ),
        ("PARACORD_TLS_ENABLED", config.tls.enabled.to_string()),
        (
            "PARACORD_FEDERATION_ENABLED",
            config.federation.enabled.to_string(),
        ),
        (
            "PARACORD_AT_REST_ENABLED",
            config.at_rest.enabled.to_string(),
        ),
        ("PARACORD_AT_REST_KEY_ENV", config.at_rest.key_env.clone()),
        (
            "PARACORD_AT_REST_ENCRYPT_SQLITE",
            config.at_rest.encrypt_sqlite.to_string(),
        ),
        (
            "PARACORD_AT_REST_ENCRYPT_FILES",
            config.at_rest.encrypt_files.to_string(),
        ),
        (
            "PARACORD_AT_REST_ALLOW_PLAINTEXT_FILE_READS",
            config.at_rest.allow_plaintext_file_reads.to_string(),
        ),
        ("PARACORD_TLS_ACME_ENABLED", "false".into()),
        ("PARACORD_TLS_ACME_AUTO_RENEW", "false".into()),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_target_identity_ignores_credentials_and_default_port() {
        assert!(same_postgres_database(
            "postgres://old:secret@localhost/live",
            "postgresql://new:other@localhost:5432/live"
        )
        .unwrap());
        assert!(!same_postgres_database(
            "postgres://localhost/live",
            "postgres://localhost/recovery"
        )
        .unwrap());
    }
    #[test]
    fn activation_quoting_keeps_paths_and_secrets_literal() {
        assert_eq!(shell_quote("a'$(secret)"), "'a'\"'\"'$(secret)'");
        assert_eq!(powershell_quote("a'$(secret)"), "'a''$(secret)'");
        assert!(valid_environment_name("PARACORD_AT_REST_KEY"));
        assert!(!valid_environment_name("1_KEY"));
        assert!(!valid_environment_name("KEY;exit"));
    }
}
