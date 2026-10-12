//! Every build carries SQLCipher (setup spec §4.1): a keyed database is
//! encrypted on disk, opens only with its key, and a plaintext database still
//! opens normally without one. Also run under Wine for the
//! `x86_64-pc-windows-gnu` cross build.

use paracord_db::{
    check_sqlite_key, create_pool_with_sqlite_key, sqlcipher_version,
    sqlite_file_has_plaintext_header, sqlite_main_file, sqlite_storage_encrypted, SqliteKeyCheck,
};
use std::path::Path;

const KEY: &str = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
const OTHER_KEY: &str = "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100";

fn url(path: &Path) -> String {
    format!(
        "sqlite://{}?mode=rwc",
        path.to_str().unwrap().replace('\\', "/")
    )
}

#[tokio::test]
async fn a_keyed_database_is_encrypted_and_opens_only_with_its_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("enc.db");

    let pool = create_pool_with_sqlite_key(&url(&path), 1, Some(KEY.into()))
        .await
        .expect("create encrypted database");
    let version = sqlcipher_version(&pool).await.unwrap();
    assert!(version.is_some(), "SQLCipher is compiled in");
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT NOT NULL)")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO t (body) VALUES ('a secret line')")
        .execute(&pool)
        .await
        .unwrap();
    assert!(sqlite_storage_encrypted(&pool).await.unwrap());
    let main = sqlite_main_file(&pool).await.unwrap().expect("file-backed");
    assert_eq!(main.canonicalize().unwrap(), path.canonicalize().unwrap());
    pool.close().await;

    assert!(!sqlite_file_has_plaintext_header(&path).unwrap());
    let bytes = std::fs::read(&path).unwrap();
    assert!(!bytes.windows(13).any(|w| w == b"a secret line"));

    assert_eq!(
        check_sqlite_key(&url(&path), Some(KEY)).await.unwrap(),
        SqliteKeyCheck::Opens
    );
    assert_eq!(
        check_sqlite_key(&url(&path), Some(OTHER_KEY))
            .await
            .unwrap(),
        SqliteKeyCheck::Rejected
    );
    assert_eq!(
        check_sqlite_key(&url(&path), None).await.unwrap(),
        SqliteKeyCheck::Rejected,
        "an encrypted database does not open without a key"
    );

    let pool = create_pool_with_sqlite_key(&url(&path), 1, Some(KEY.into()))
        .await
        .expect("reopen with the key");
    let body: String = sqlx::query_scalar("SELECT body FROM t")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(body, "a secret line");
    pool.close().await;
}

#[tokio::test]
async fn a_plaintext_database_still_opens_without_a_key() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("plain.db");
    let pool = create_pool_with_sqlite_key(&url(&path), 1, None)
        .await
        .unwrap();
    sqlx::query("CREATE TABLE t (id INTEGER PRIMARY KEY)")
        .execute(&pool)
        .await
        .unwrap();
    assert!(!sqlite_storage_encrypted(&pool).await.unwrap());
    pool.close().await;
    assert!(sqlite_file_has_plaintext_header(&path).unwrap());
    assert_eq!(
        check_sqlite_key(&url(&path), None).await.unwrap(),
        SqliteKeyCheck::Opens
    );
    assert_eq!(
        check_sqlite_key(&url(&path), Some(KEY)).await.unwrap(),
        SqliteKeyCheck::Rejected,
        "a key on a plaintext database is refused, never ignored"
    );
}
