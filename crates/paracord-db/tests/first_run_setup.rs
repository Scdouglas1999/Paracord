//! The first-run setup migration (`20261013000001_first_run_setup.sql`) and
//! the `credentials` / `key_backups` modules.
//!
//! Runs on in-memory SQLite by default, and on PostgreSQL instead when
//! `PARACORD_TEST_POSTGRES_URL` is set (each test gets its own database, dropped
//! afterwards). One engine per process: the pool records the active engine once.

use std::borrow::Cow;
use std::path::Path;

use chrono::Utc;
use paracord_db::{credentials, key_backups, DatabaseEngine, DbPool};
use sqlx::Row;

const SETUP_MIGRATION: i64 = 20261013000001;
const ARGON2: &str = "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNo";

struct TestDb {
    pool: DbPool,
    engine: DatabaseEngine,
    drop_target: Option<(String, String)>,
}

impl TestDb {
    async fn close(self) {
        self.pool.close().await;
        if let Some((admin_url, name)) = self.drop_target {
            let admin = paracord_db::create_pool(&admin_url, 1).await.unwrap();
            sqlx::query(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
                .execute(&admin)
                .await
                .unwrap();
            admin.close().await;
        }
    }
}

fn with_database(base: &str, name: &str) -> String {
    let (prefix, rest) = base.split_once("://").expect("postgres URL");
    let (authority, query) = match rest.split_once('/') {
        Some((authority, path)) => (
            authority,
            path.split_once('?')
                .map(|(_, q)| format!("?{q}"))
                .unwrap_or_default(),
        ),
        None => (rest, String::new()),
    };
    format!("{prefix}://{authority}/{name}{query}")
}

/// A fresh, empty database on the engine this run tests.
async fn empty_db() -> TestDb {
    match std::env::var("PARACORD_TEST_POSTGRES_URL") {
        Ok(base) if !base.trim().is_empty() => {
            let base = base.trim();
            let admin_url = with_database(base, "postgres");
            let name = format!("pc_first_run_{}", uuid::Uuid::new_v4().simple());
            let admin = paracord_db::create_pool(&admin_url, 1).await.unwrap();
            sqlx::query(&format!("CREATE DATABASE {name}"))
                .execute(&admin)
                .await
                .unwrap();
            admin.close().await;
            let pool = paracord_db::create_pool(&with_database(base, &name), 2)
                .await
                .unwrap();
            TestDb {
                pool,
                engine: DatabaseEngine::Postgres,
                drop_target: Some((admin_url, name)),
            }
        }
        _ => TestDb {
            pool: paracord_db::create_pool("sqlite::memory:", 1)
                .await
                .unwrap(),
            engine: DatabaseEngine::Sqlite,
            drop_target: None,
        },
    }
}

/// A database at the schema just before the first-run setup migration.
async fn db_before_setup_migration() -> TestDb {
    let db = empty_db().await;
    let dir = match db.engine {
        DatabaseEngine::Sqlite => "migrations",
        DatabaseEngine::Postgres => "migrations_pg",
    };
    let mut migrator =
        sqlx::migrate::Migrator::new(Path::new(env!("CARGO_MANIFEST_DIR")).join(dir))
            .await
            .unwrap();
    assert!(
        migrator.iter().any(|m| m.version == SETUP_MIGRATION),
        "{dir} has the first-run setup migration"
    );
    let earlier: Vec<_> = migrator
        .iter()
        .filter(|m| m.version < SETUP_MIGRATION)
        .cloned()
        .collect();
    migrator.migrations = Cow::Owned(earlier);
    migrator.run(&db.pool).await.unwrap();
    db
}

async fn migrated_db() -> TestDb {
    let db = empty_db().await;
    paracord_db::run_migrations_for_engine(&db.pool, db.engine)
        .await
        .unwrap();
    db
}

async fn insert_user(pool: &DbPool, id: i64, username: &str, password_hash: &str) {
    sqlx::query(
        "INSERT INTO users (id, username, discriminator, email, password_hash)
         VALUES ($1, $2, 1, $3, $4)",
    )
    .bind(id)
    .bind(username)
    .bind(format!("{username}@example.test"))
    .bind(password_hash)
    .execute(pool)
    .await
    .unwrap();
}

async fn version_of(pool: &DbPool, id: i64) -> i32 {
    credentials::get(pool, id)
        .await
        .unwrap()
        .expect("account exists")
        .version
}

#[tokio::test]
async fn the_migration_classifies_existing_accounts_and_keeps_their_settings() {
    let db = db_before_setup_migration().await;
    let pool = &db.pool;
    insert_user(pool, 1, "legacy", ARGON2).await;
    insert_user(pool, 2, "keyonly", "").await;
    insert_user(pool, 3, "remote", "!federated!").await;
    insert_user(pool, 4, "tombstone", "!deleted!").await;
    sqlx::query("UPDATE users SET public_key = $1 WHERE id = 2")
        .bind("ab".repeat(32))
        .execute(pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO user_settings (user_id, theme) VALUES (1, 'slate')")
        .execute(pool)
        .await
        .unwrap();

    paracord_db::run_migrations_for_engine(pool, db.engine)
        .await
        .unwrap();

    assert_eq!(version_of(pool, 1).await, credentials::VERSION_LEGACY);
    for key_only in [2, 3, 4] {
        assert_eq!(
            version_of(pool, key_only).await,
            credentials::VERSION_KEY_ONLY,
            "user {key_only}"
        );
    }
    let legacy = credentials::get(pool, 1).await.unwrap().unwrap();
    assert_eq!(legacy.epoch, 0);
    assert_eq!(legacy.salt, None);
    assert_eq!(legacy.kdf, None);
    assert_eq!(legacy.password_hash, ARGON2);
    let key_only = credentials::get(pool, 2).await.unwrap().unwrap();
    assert_eq!(key_only.public_key, Some("ab".repeat(32)));

    // Existing settings rows keep their values and get link previews on.
    let row = sqlx::query(
        "SELECT theme, CAST(link_previews AS INTEGER) AS link_previews
         FROM user_settings WHERE user_id = 1",
    )
    .fetch_one(pool)
    .await
    .unwrap();
    assert_eq!(row.try_get::<String, _>("theme").unwrap(), "slate");
    assert_eq!(row.try_get::<i32, _>("link_previews").unwrap(), 1);

    // No backups exist yet, and the version cannot leave 0-2.
    let backups: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM account_key_backups")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(backups, 0);
    assert!(
        sqlx::query("UPDATE users SET credential_version = 3 WHERE id = 1")
            .execute(pool)
            .await
            .is_err(),
        "the CHECK keeps credential_version in 0-2"
    );
    db.close().await;
}

#[tokio::test]
async fn new_accounts_get_the_version_their_password_hash_means() {
    let db = migrated_db().await;
    let pool = &db.pool;
    paracord_db::users::create_user(pool, 10, "legacy", 1, "legacy@x.test", ARGON2)
        .await
        .unwrap();
    paracord_db::users::create_user(pool, 11, "feeds", 0, "feeds@x.test", "")
        .await
        .unwrap();
    paracord_db::users::create_user_as_first_admin(pool, 12, "owner", 2, "o@x.test", ARGON2, 8)
        .await
        .unwrap();
    paracord_db::users::create_user_from_pubkey(pool, 13, &"cd".repeat(32), "keyed", None)
        .await
        .unwrap();
    paracord_db::users::create_user_from_pubkey_as_first_admin(
        pool,
        14,
        &"ef".repeat(32),
        "keyed2",
        None,
        8,
    )
    .await
    .unwrap();
    assert_eq!(version_of(pool, 10).await, credentials::VERSION_LEGACY);
    assert_eq!(version_of(pool, 11).await, credentials::VERSION_KEY_ONLY);
    assert_eq!(version_of(pool, 12).await, credentials::VERSION_LEGACY);
    assert_eq!(version_of(pool, 13).await, credentials::VERSION_KEY_ONLY);
    assert_eq!(version_of(pool, 14).await, credentials::VERSION_KEY_ONLY);
    db.close().await;
}

#[tokio::test]
async fn the_first_one_password_credential_is_conditional_on_the_version() {
    let db = migrated_db().await;
    let pool = &db.pool;
    insert_user(pool, 20, "mover", ARGON2).await;
    let now = Utc::now();

    assert!(credentials::set_first_one_password(
        pool,
        20,
        1,
        "$argon2id$auth",
        "salt",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());
    let moved = credentials::get(pool, 20).await.unwrap().unwrap();
    assert_eq!(moved.version, credentials::VERSION_ONE_PASSWORD);
    assert_eq!(moved.epoch, 1);
    assert_eq!(moved.salt.as_deref(), Some("salt"));
    assert_eq!(moved.kdf.as_deref(), Some("scrypt:17:8:1"));
    assert_eq!(moved.password_hash, "$argon2id$auth");

    // A replay, or a racing second upgrade, changes nothing.
    assert!(!credentials::set_first_one_password(
        pool,
        20,
        1,
        "$argon2id$other",
        "s2",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());
    assert_eq!(
        credentials::get(pool, 20).await.unwrap().unwrap(),
        moved,
        "the losing upgrade left the account alone"
    );
    // Nothing can ask to move from version 2.
    assert!(credentials::set_first_one_password(
        pool,
        20,
        2,
        "$argon2id$x",
        "s",
        "scrypt:17:8:1",
        now
    )
    .await
    .is_err());
    // An unknown account is not updated.
    assert!(!credentials::set_first_one_password(
        pool,
        999,
        1,
        "$argon2id$x",
        "s",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());
    assert!(credentials::get(pool, 999).await.unwrap().is_none());
    db.close().await;
}

#[tokio::test]
async fn a_change_bumps_the_epoch_only_from_the_epoch_it_started_at() {
    let db = migrated_db().await;
    let pool = &db.pool;
    insert_user(pool, 30, "changer", ARGON2).await;
    insert_user(pool, 31, "legacy", ARGON2).await;
    let now = Utc::now();
    assert!(credentials::set_first_one_password(
        pool,
        30,
        1,
        "$argon2id$a",
        "s1",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());

    let epoch =
        credentials::replace_one_password(pool, 30, 1, "$argon2id$b", "s2", "scrypt:18:8:1", now)
            .await
            .unwrap();
    assert_eq!(epoch, Some(2));
    // A concurrent change that also started at epoch 1 loses.
    assert_eq!(
        credentials::replace_one_password(pool, 30, 1, "$argon2id$c", "s3", "scrypt:17:8:1", now)
            .await
            .unwrap(),
        None
    );
    let changed = credentials::get(pool, 30).await.unwrap().unwrap();
    assert_eq!(changed.epoch, 2);
    assert_eq!(changed.password_hash, "$argon2id$b");
    assert_eq!(changed.kdf.as_deref(), Some("scrypt:18:8:1"));
    // A legacy account has no one-password credential to replace.
    assert_eq!(
        credentials::replace_one_password(pool, 31, 0, "$argon2id$d", "s", "scrypt:17:8:1", now)
            .await
            .unwrap(),
        None
    );
    assert_eq!(version_of(pool, 31).await, credentials::VERSION_LEGACY);
    db.close().await;
}

#[tokio::test]
async fn key_backups_round_trip_and_keep_the_confirmation_for_the_same_identity() {
    let db = migrated_db().await;
    let pool = &db.pool;
    insert_user(pool, 40, "backed", ARGON2).await;
    let now = Utc::now();
    let key_a = "aa".repeat(32);
    let key_b = "bb".repeat(32);

    assert!(key_backups::get(pool, 40).await.unwrap().is_none());
    assert!(!key_backups::set_recovery_confirmed(pool, 40, now)
        .await
        .unwrap());

    key_backups::put(pool, 40, &key_a, "wrapped-1", "aes256gcm-v2", 1, now)
        .await
        .unwrap();
    let first = key_backups::get(pool, 40).await.unwrap().unwrap();
    assert_eq!(first.public_key, key_a);
    assert_eq!(first.wrapped_key, "wrapped-1");
    assert_eq!(first.wrap_alg, "aes256gcm-v2");
    assert_eq!(first.credential_epoch, 1);
    assert!(!first.recovery_confirmed);

    assert!(key_backups::set_recovery_confirmed(pool, 40, now)
        .await
        .unwrap());
    assert!(
        key_backups::get(pool, 40)
            .await
            .unwrap()
            .unwrap()
            .recovery_confirmed
    );

    // A password change re-wraps the same identity: still confirmed.
    key_backups::put(pool, 40, &key_a, "wrapped-2", "aes256gcm-v2", 2, now)
        .await
        .unwrap();
    let rewrapped = key_backups::get(pool, 40).await.unwrap().unwrap();
    assert_eq!(rewrapped.wrapped_key, "wrapped-2");
    assert_eq!(rewrapped.credential_epoch, 2);
    assert!(rewrapped.recovery_confirmed);

    // Start over makes a new identity, with a new phrase to write down.
    key_backups::put(pool, 40, &key_b, "wrapped-3", "aes256gcm-v2", 3, now)
        .await
        .unwrap();
    let replaced = key_backups::get(pool, 40).await.unwrap().unwrap();
    assert_eq!(replaced.public_key, key_b);
    assert!(!replaced.recovery_confirmed);

    assert!(key_backups::delete(pool, 40).await.unwrap());
    assert!(!key_backups::delete(pool, 40).await.unwrap());
    db.close().await;
}

#[tokio::test]
async fn a_backup_goes_with_its_account() {
    let db = migrated_db().await;
    let pool = &db.pool;
    insert_user(pool, 50, "leaving", ARGON2).await;
    key_backups::put(
        pool,
        50,
        &"aa".repeat(32),
        "w",
        "aes256gcm-v2",
        1,
        Utc::now(),
    )
    .await
    .unwrap();
    sqlx::query("DELETE FROM users WHERE id = 50")
        .execute(pool)
        .await
        .unwrap();
    assert!(key_backups::get(pool, 50).await.unwrap().is_none());
    db.close().await;
}

#[tokio::test]
async fn credential_and_backup_writes_share_one_transaction() {
    let db = migrated_db().await;
    let pool = &db.pool;
    insert_user(pool, 60, "atomic", ARGON2).await;
    let now = Utc::now();

    let mut tx = pool.begin().await.unwrap();
    assert!(credentials::set_first_one_password(
        &mut *tx,
        60,
        1,
        "$argon2id$a",
        "s",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());
    key_backups::put(&mut *tx, 60, &"aa".repeat(32), "w", "aes256gcm-v2", 1, now)
        .await
        .unwrap();
    tx.rollback().await.unwrap();
    assert_eq!(version_of(pool, 60).await, credentials::VERSION_LEGACY);
    assert!(key_backups::get(pool, 60).await.unwrap().is_none());

    let mut tx = pool.begin().await.unwrap();
    assert!(credentials::set_first_one_password(
        &mut *tx,
        60,
        1,
        "$argon2id$a",
        "s",
        "scrypt:17:8:1",
        now
    )
    .await
    .unwrap());
    key_backups::put(&mut *tx, 60, &"aa".repeat(32), "w", "aes256gcm-v2", 1, now)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        version_of(pool, 60).await,
        credentials::VERSION_ONE_PASSWORD
    );
    assert!(key_backups::get(pool, 60).await.unwrap().is_some());
    db.close().await;
}
