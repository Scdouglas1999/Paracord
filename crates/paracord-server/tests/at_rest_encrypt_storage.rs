//! `encrypt-storage` on a populated plaintext server, its resume after an
//! interruption, and `restore-backup --escrow-key-stdin` with the owner's
//! escrow key (docs/setup-spec.md §4.7, §4.8).

mod support;

use paracord_util::at_rest::{derive_escrow_key, derive_sqlite_key_hex, FileCryptor};
use std::path::Path;
use support::*;

/// Attachment bodies; ids 101.. in order.
const BODIES: [&[u8]; 4] = [
    b"the first attachment, in plain text",
    b"a second one",
    b"third: \x00\x01\x02 binary bytes",
    b"fourth",
];
const FED_BODY: &[u8] = b"a cached file from another server";

/// A plaintext server with migrations applied, attachments on disk, one
/// attachment row whose file is gone, and a cached federated file.
async fn populate(scratch: &Scratch) {
    scratch.init_plaintext();
    let uploads = scratch.path().join("data/uploads");
    std::fs::create_dir_all(uploads.join("attachments")).unwrap();
    std::fs::create_dir_all(uploads.join("fed-cache/peer.example")).unwrap();
    // The directories a server that has run always has.
    std::fs::create_dir_all(scratch.path().join("data/files")).unwrap();
    std::fs::create_dir_all(scratch.path().join("data/backups")).unwrap();
    let pool = paracord_db::create_pool(&scratch.db_url(), 1)
        .await
        .unwrap();
    paracord_db::run_migrations(&pool).await.unwrap();
    for (index, body) in BODIES.iter().enumerate() {
        let id = 101 + index as i64;
        sqlx::query("INSERT INTO attachments (id, filename, size, url) VALUES ($1, $2, $3, $4)")
            .bind(id)
            .bind(format!("note-{id}.txt"))
            .bind(body.len() as i64)
            .bind(format!("/api/v1/attachments/{id}"))
            .execute(&pool)
            .await
            .unwrap();
        std::fs::write(uploads.join(format!("attachments/{id}.txt")), body).unwrap();
    }
    // Listed, but its file is not on disk.
    sqlx::query(
        "INSERT INTO attachments (id, filename, size, url) VALUES (199, 'gone.png', 3, '/x')",
    )
    .execute(&pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO federation_file_cache (origin_server, origin_attachment_id, content_hash, filename, size, storage_key) VALUES ('peer.example', '77', 'h', 'f.bin', $1, 'fed-cache/peer.example/77')",
    )
    .bind(FED_BODY.len() as i64)
    .execute(&pool)
    .await
    .unwrap();
    std::fs::write(uploads.join("fed-cache/peer.example/77"), FED_BODY).unwrap();
    pool.close().await;
}

async fn table_counts(url: &str, key_hex: Option<String>) -> Vec<(String, i64)> {
    let pool = paracord_db::create_pool_with_sqlite_key(url, 1, key_hex)
        .await
        .unwrap();
    let names: Vec<String> = sqlx::query_scalar(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut counts = Vec::new();
    for name in names {
        let count: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM \"{name}\""))
            .fetch_one(&pool)
            .await
            .unwrap();
        counts.push((name, count));
    }
    pool.close().await;
    counts
}

fn encrypt_storage(scratch: &Scratch, stop_after: Option<&str>) -> std::process::Output {
    let mut command = scratch.server();
    command.args(["encrypt-storage", "--key-source", "file"]);
    // Ports nothing listens on, so the running-server check passes.
    command
        .env("PARACORD_BIND_ADDRESS", "127.0.0.1:18228")
        .env("PARACORD_TLS_ENABLED", "false");
    if let Some(step) = stop_after {
        command.env("PARACORD_ENCRYPT_STORAGE_STOP_AFTER", step);
    }
    command.output().expect("encrypt-storage")
}

fn assert_files_encrypted_once(scratch: &Scratch, key: &[u8; 32]) {
    let cryptor = FileCryptor::from_master_key(key, false);
    let uploads = scratch.path().join("data/uploads");
    for (index, body) in BODIES.iter().enumerate() {
        let id = 101 + index;
        let stored = std::fs::read(uploads.join(format!("attachments/{id}.txt"))).unwrap();
        assert!(
            stored.starts_with(b"PRCENC02"),
            "attachment {id} is encrypted"
        );
        let plain = cryptor
            .decrypt_with_aad(&stored, format!("attachment:{id}").as_bytes())
            .expect("decrypts with its own AAD");
        assert_eq!(
            &plain[..],
            *body,
            "attachment {id} was encrypted exactly once"
        );
        assert!(cryptor.decrypt_with_aad(&stored, b"attachment:1").is_err());
    }
    let cached = std::fs::read(uploads.join("fed-cache/peer.example/77")).unwrap();
    assert_eq!(
        cryptor
            .decrypt_with_aad(&cached, b"federation-cache:peer.example:77")
            .unwrap(),
        FED_BODY
    );
    let leftovers: Vec<_> = walk(&uploads)
        .into_iter()
        .filter(|p| p.to_string_lossy().ends_with(".encrypting"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
}

fn walk(dir: &Path) -> Vec<std::path::PathBuf> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.is_dir() {
            out.extend(walk(&path));
        } else {
            out.push(path);
        }
    }
    out
}

fn assert_config_records_the_file_key(scratch: &Scratch) -> std::path::PathBuf {
    let config = scratch.config_toml();
    let at_rest = &config["at_rest"];
    assert_eq!(at_rest["enabled"].as_bool(), Some(true));
    assert_eq!(at_rest["encrypt_sqlite"].as_bool(), Some(true));
    assert_eq!(at_rest["encrypt_files"].as_bool(), Some(true));
    assert_eq!(at_rest["key_source"].as_str(), Some("file"));
    assert_eq!(at_rest["protection"].as_str(), Some("same_disk"));
    assert!(config["host"]["instance_id"].as_str().is_some());
    std::path::PathBuf::from(at_rest["key_file"].as_str().unwrap())
}

#[tokio::test(flavor = "multi_thread")]
async fn at_rest_encrypt_storage_converts_a_plaintext_server_and_its_escrow_restores_the_key() {
    let scratch = Scratch::new();
    populate(&scratch).await;
    let before = table_counts(&scratch.db_url(), None).await;
    assert!(before
        .iter()
        .any(|(name, count)| name == "attachments" && *count == 5));

    let output = encrypt_storage(&scratch, None);
    assert_success(&output, "encrypt-storage");
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("Stored data is now encrypted."), "{stdout}");
    assert!(stdout.contains("5 encrypted now"), "{stdout}");
    assert!(
        stdout.contains("1 listed in the database but not on disk"),
        "{stdout}"
    );

    let key_file = assert_config_records_the_file_key(&scratch);
    let key = read_key_file(&key_file);
    let key_hex = derive_sqlite_key_hex(&key);

    // The database: encrypted on disk, the same rows in every table, no
    // plaintext copy or journal left.
    assert!(!paracord_db::sqlite_file_has_plaintext_header(&scratch.db()).unwrap());
    let bytes = std::fs::read(scratch.db()).unwrap();
    assert!(!bytes.windows(10).any(|w| w == b"note-101.t"));
    assert_eq!(
        table_counts(&scratch.db_url(), Some(key_hex.clone())).await,
        before
    );
    for leftover in [
        "data/paracord.db.plaintext",
        "data/paracord.db.encrypting",
        "data/.encrypt-storage.journal",
    ] {
        assert!(!scratch.path().join(leftover).exists(), "{leftover}");
    }
    assert_files_encrypted_once(&scratch, &key);
    let backups: Vec<_> = std::fs::read_dir(scratch.path().join("data/backups"))
        .unwrap()
        .collect();
    assert_eq!(backups.len(), 1, "one backup taken before the change");

    // A second run has nothing to do and says so.
    let again = encrypt_storage(&scratch, None);
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("already on"));

    // The server starts on the converted data.
    let port = 18230;
    stop(start_until_healthy(
        listen_env(&mut scratch.server(), port),
        port,
    ));

    // Escrow under the S1 vector identity, then a backup carrying it.
    let config = scratch.config_toml();
    let instance_id = config["host"]["instance_id"].as_str().unwrap().to_string();
    let escrow_file = std::path::PathBuf::from(config["host"]["escrow_file"].as_str().unwrap());
    let escrow_key = derive_escrow_key(&unhex(VECTOR_IDENTITY_PRIVATE_KEY), &instance_id);
    let runtime = paracord_core::storage_key::StorageKeyRuntime {
        enabled: true,
        sqlite_encrypted: true,
        files_encrypted: true,
        instance_id: Some(instance_id.clone()),
        escrow_file: Some(escrow_file.clone()),
        master_key: Some(key),
        ..Default::default()
    };
    runtime
        .write_escrow(&b64url(&escrow_key), VECTOR_IDENTITY_PUBLIC_KEY)
        .expect("escrow");
    paracord_core::storage_key::init(runtime);
    let pool = paracord_db::create_pool_with_sqlite_key(&scratch.db_url(), 1, Some(key_hex))
        .await
        .unwrap();
    // A restore verifies every attachment; drop the one whose file is gone.
    sqlx::query("DELETE FROM attachments WHERE id = 199")
        .execute(&pool)
        .await
        .unwrap();
    let uploads = scratch.path().join("data/uploads");
    let backup_dir = scratch.path().join("escrow-backups");
    let name = paracord_core::backup::create_backup_from_pool(
        &pool,
        &scratch.db_url(),
        backup_dir.to_str().unwrap(),
        uploads.to_str().unwrap(),
        scratch.path().join("data/files").to_str().unwrap(),
        true,
        true,
        Some(&FileCryptor::from_master_key(&key, false)),
        Some(&FileCryptor::from_master_key_with_context(
            &key, b"totp", true,
        )),
    )
    .await
    .expect("backup");
    pool.close().await;
    let archive = backup_dir.join(&name);
    let manifest = paracord_core::backup::read_archive_manifest(&archive).unwrap();
    let recovery = manifest.recovery.expect("recovery metadata");
    assert!(
        recovery.sqlite_encrypted,
        "the backup's database is SQLCipher too"
    );
    assert_eq!(
        recovery.key_escrow.as_ref().unwrap().instance_id,
        instance_id
    );

    // The key is lost.
    std::fs::remove_file(&key_file).unwrap();

    // A wrong phrase does not unlock it.
    let wrong = derive_escrow_key(&[7u8; 32], &instance_id);
    let mut restore = scratch.server();
    restore
        .env("PARACORD_TLS_ENABLED", "false")
        .args(["restore-backup", "--archive"])
        .arg(&archive)
        .arg("--output-dir")
        .arg(scratch.path().join("recovered-wrong"))
        .arg("--escrow-key-stdin");
    let output = run_with_stdin(&mut restore, &format!("{}\n", b64url(&wrong)));
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("does not unlock"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!key_file.exists());

    // The owner's escrow key restores it.
    let mut restore = scratch.server();
    restore
        .env("PARACORD_TLS_ENABLED", "false")
        .args(["restore-backup", "--archive"])
        .arg(&archive)
        .arg("--output-dir")
        .arg(scratch.path().join("recovered"))
        .arg("--escrow-key-stdin");
    let output = run_with_stdin(&mut restore, &format!("{}\n", b64url(&escrow_key)));
    assert_success(&output, "restore-backup --escrow-key-stdin");
    assert_eq!(
        read_key_file(&key_file),
        key,
        "the same key is back in its file"
    );
    assert!(scratch.path().join("recovered/paracord.toml").is_file());
}

#[tokio::test(flavor = "multi_thread")]
async fn at_rest_encrypt_storage_resumes_after_an_interruption() {
    let scratch = Scratch::new();
    populate(&scratch).await;
    let before = table_counts(&scratch.db_url(), None).await;
    let journal = scratch.path().join("data/.encrypt-storage.journal");

    // Stopped right after the key was stored: nothing else changed.
    let output = encrypt_storage(&scratch, Some("key"));
    assert!(!output.status.success());
    assert!(journal.exists());
    let key_file = scratch.path().join("config/at-rest.key");
    let key = read_key_file(&key_file);
    assert!(paracord_db::sqlite_file_has_plaintext_header(&scratch.db()).unwrap());
    assert_eq!(
        scratch.config_toml()["at_rest"]["enabled"].as_bool(),
        Some(false)
    );

    // Stopped after one file: the database is already encrypted.
    let output = encrypt_storage(&scratch, Some("files:1"));
    assert!(!output.status.success());
    assert!(journal.exists());
    assert!(!paracord_db::sqlite_file_has_plaintext_header(&scratch.db()).unwrap());
    let stored = std::fs::read(scratch.path().join("data/uploads/attachments/101.txt")).unwrap();
    assert!(stored.starts_with(b"PRCENC02"));
    let untouched = std::fs::read(scratch.path().join("data/uploads/attachments/102.txt")).unwrap();
    assert_eq!(&untouched[..], BODIES[1]);
    // Until the config says so, the server refuses the database it has no key for.
    let mut start = scratch.server();
    listen_env(&mut start, 18232);
    let refused = run_with_timeout(&mut start, std::time::Duration::from_secs(60));
    assert!(!refused.status.success());
    assert!(String::from_utf8_lossy(&refused.stderr).contains("encrypt-storage"));

    // The rerun finishes with the same key, and nothing is encrypted twice.
    let output = encrypt_storage(&scratch, None);
    assert_success(&output, "encrypt-storage (resumed)");
    assert!(String::from_utf8_lossy(&output.stdout).contains("Resuming"));
    assert_eq!(read_key_file(&key_file), key);
    assert!(!journal.exists());
    assert_config_records_the_file_key(&scratch);
    assert_eq!(
        table_counts(&scratch.db_url(), Some(derive_sqlite_key_hex(&key))).await,
        before
    );
    assert_files_encrypted_once(&scratch, &key);
}
