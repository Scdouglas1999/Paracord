//! First-run key generation and the exit-78 refusals (docs/setup-spec.md
//! §4.2-§4.4), driven through the real binary.

mod support;

use paracord_util::at_rest::{derive_sqlite_key_hex, format_master_key, generate_master_key};
use std::time::Duration;
use support::*;

const EXIT_KEY_UNAVAILABLE: i32 = 78;

/// Linux only: elsewhere the probe would reach the developer's real keychain.
#[cfg(target_os = "linux")]
#[tokio::test(flavor = "multi_thread")]
async fn at_rest_first_run_without_a_keychain_stores_the_key_in_a_private_file() {
    let scratch = Scratch::new();
    let output = scratch.server().arg("init").output().expect("init");
    assert_success(&output, "init");

    let config = scratch.config_toml();
    let at_rest = &config["at_rest"];
    assert_eq!(at_rest["enabled"].as_bool(), Some(true));
    assert_eq!(at_rest["encrypt_sqlite"].as_bool(), Some(true));
    assert_eq!(at_rest["encrypt_files"].as_bool(), Some(true));
    assert_eq!(at_rest["key_source"].as_str(), Some("file"));
    assert_eq!(at_rest["protection"].as_str(), Some("same_disk"));
    let key_file = std::path::PathBuf::from(at_rest["key_file"].as_str().expect("key_file"));
    assert!(key_file.is_absolute());
    assert_eq!(
        key_file.canonicalize().unwrap(),
        scratch
            .path()
            .join("config/at-rest.key")
            .canonicalize()
            .unwrap()
    );
    let instance_id = config["host"]["instance_id"].as_str().expect("instance_id");
    assert!(uuid::Uuid::parse_str(instance_id).is_ok());
    assert_eq!(config["host"]["enabled"].as_bool(), Some(false));
    assert!(config["host"]["escrow_file"]
        .as_str()
        .unwrap()
        .ends_with("storage-key.escrow"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&key_file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let key = read_key_file(&key_file);

    // The server starts on that key and the database it creates is SQLCipher.
    let port = 18222;
    let child = start_until_healthy(listen_env(&mut scratch.server(), port), port);
    stop(child);
    assert!(!paracord_db::sqlite_file_has_plaintext_header(&scratch.db()).unwrap());
    assert_eq!(
        paracord_db::check_sqlite_key(&scratch.db_url(), Some(&derive_sqlite_key_hex(&key)))
            .await
            .unwrap(),
        paracord_db::SqliteKeyCheck::Opens
    );
    assert_eq!(
        paracord_db::check_sqlite_key(&scratch.db_url(), None)
            .await
            .unwrap(),
        paracord_db::SqliteKeyCheck::Rejected
    );
}

/// Installers choose the source (docs/setup-spec.md §4.2): `init --key-source
/// file --key-file <path>` puts the key exactly there, 0600, and records it.
#[cfg(unix)]
#[test]
fn init_key_source_puts_the_key_where_the_installer_says() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = Scratch::new();
    let key_file = scratch.path().join("elsewhere/storage.key");
    std::fs::create_dir_all(key_file.parent().unwrap()).unwrap();
    let output = scratch
        .server()
        .args(["init", "--key-source", "file", "--key-file"])
        .arg(&key_file)
        .output()
        .expect("init");
    assert_success(&output, "init --key-source file");
    let config = scratch.config_toml();
    assert_eq!(config["at_rest"]["enabled"].as_bool(), Some(true));
    assert_eq!(config["at_rest"]["key_source"].as_str(), Some("file"));
    assert_eq!(config["at_rest"]["protection"].as_str(), Some("same_disk"));
    assert_eq!(
        std::path::PathBuf::from(config["at_rest"]["key_file"].as_str().unwrap())
            .canonicalize()
            .unwrap(),
        key_file.canonicalize().unwrap()
    );
    assert_eq!(
        std::fs::metadata(&key_file).unwrap().permissions().mode() & 0o777,
        0o600
    );
    assert!(!scratch.path().join("config/at-rest.key").exists());

    // The config exists now: the flag refuses instead of being ignored.
    let again = scratch
        .server()
        .args(["init", "--key-source", "file"])
        .output()
        .expect("init again");
    assert!(!again.status.success());
    let said = String::from_utf8_lossy(&again.stderr);
    assert!(said.contains("encrypt-storage"), "{said}");
}

#[test]
fn at_rest_first_run_leaves_encryption_to_an_explicit_environment_choice() {
    let scratch = Scratch::new();
    scratch.init_plaintext();
    let config = scratch.config_toml();
    assert_eq!(config["at_rest"]["key_source"].as_str(), Some("env"));
    assert!(!scratch.path().join("config/at-rest.key").exists());
    assert!(config["host"].get("instance_id").is_none());
}

#[test]
fn at_rest_first_run_never_encrypts_over_an_existing_database() {
    let scratch = Scratch::new();
    std::fs::create_dir_all(scratch.path().join("data")).unwrap();
    std::fs::write(scratch.db(), b"SQLite format 3\0 pretend there is data").unwrap();
    let output = scratch.server().arg("init").output().expect("init");
    assert_success(&output, "init");
    assert_eq!(
        scratch.config_toml()["at_rest"]["enabled"].as_bool(),
        Some(false)
    );
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(said.contains("encrypt-storage"), "{said}");
}

fn expect_exit_78(scratch: &Scratch, envs: &[(&str, &str)], says: &str) {
    let mut command = scratch.server();
    listen_env(&mut command, 18224);
    for (key, value) in envs {
        command.env(key, value);
    }
    let output = run_with_timeout(&mut command, Duration::from_secs(60));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert_eq!(
        output.status.code(),
        Some(EXIT_KEY_UNAVAILABLE),
        "expected exit 78\nstderr:\n{stderr}"
    );
    let line = stderr
        .lines()
        .find(|l| l.starts_with("at-rest key: "))
        .unwrap_or_else(|| panic!("no 'at-rest key:' line\nstderr:\n{stderr}"));
    assert!(line.contains(says), "{line}");
}

#[tokio::test(flavor = "multi_thread")]
async fn at_rest_an_unavailable_or_wrong_key_stops_the_server_with_78() {
    let scratch = Scratch::new();
    scratch.init_plaintext();
    let key_file = scratch.path().join("config/at-rest.key");
    let key_file_text = toml::Value::String(key_file.to_string_lossy().into_owned()).to_string();
    scratch.set_config("at_rest", "enabled", "true");
    scratch.set_config("at_rest", "encrypt_sqlite", "true");
    scratch.set_config("at_rest", "encrypt_files", "true");
    scratch.set_config("at_rest", "key_source", "\"file\"");
    scratch.set_config("at_rest", "key_file", &key_file_text);

    // No key file.
    expect_exit_78(&scratch, &[], "does not exist");

    // A key file other users can read.
    let right = generate_master_key();
    std::fs::write(&key_file, format_master_key(&right)).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o644)).unwrap();
        expect_exit_78(&scratch, &[], "chmod 600");
        std::fs::set_permissions(&key_file, std::fs::Permissions::from_mode(0o600)).unwrap();
    }

    // A plaintext database the key cannot open.
    std::fs::create_dir_all(scratch.path().join("data")).unwrap();
    let pool = paracord_db::create_pool(&scratch.db_url(), 1)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    expect_exit_78(&scratch, &[], "not encrypted yet");
    std::fs::remove_file(scratch.db()).unwrap();

    // A database encrypted with a different key.
    let other = generate_master_key();
    let pool = paracord_db::create_pool_with_sqlite_key(
        &scratch.db_url(),
        1,
        Some(derive_sqlite_key_hex(&other)),
    )
    .await
    .unwrap();
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    pool.close().await;
    expect_exit_78(&scratch, &[], "does not open the database");

    // The env source with nothing in the variable.
    scratch.set_config("at_rest", "key_source", "\"env\"");
    expect_exit_78(
        &scratch,
        &[],
        "the environment variable PARACORD_AT_REST_KEY is not set",
    );
    // The keychain source without an account named.
    scratch.set_config("at_rest", "key_source", "\"keychain\"");
    expect_exit_78(&scratch, &[], "keychain_account is not set");
    // systemd-creds outside a unit.
    scratch.set_config("at_rest", "key_source", "\"systemd-creds\"");
    expect_exit_78(&scratch, &[], "CREDENTIALS_DIRECTORY is not set");

    // The right key through the env source opens it.
    scratch.set_config("at_rest", "key_source", "\"env\"");
    let port = 18226;
    let mut command = scratch.server();
    listen_env(&mut command, port).env("PARACORD_AT_REST_KEY", format_master_key(&other));
    stop(start_until_healthy(&mut command, port));
}
