//! One-shot SQLite → PostgreSQL data migration.
//!
//! Copies every application table from a source SQLite database into a freshly
//! migrated PostgreSQL database inside a single target transaction. Either the
//! whole copy commits or none of its source rows are written: after each table the
//! source `COUNT(*)` is compared against the number of rows inserted, and any
//! mismatch rolls the entire copy transaction back. Target schema migrations and
//! their seed rows run beforehand and remain applied if copying fails.
//! Derived channel tails are repaired and a new database history epoch is minted
//! after copying all rows, inside the same transaction.
//!
//! The table list ([`MIGRATION_TABLE_ORDER`]) is FK-safe (parents precede
//! children) so inserts satisfy PostgreSQL's immediate foreign-key checks, and
//! within each table rows are streamed in ascending primary-key order so
//! self-referential foreign keys (e.g. `channels.parent_id`, `messages
//! .reference_id`) are always inserted after their parent — snowflake IDs are
//! monotonic with creation time, so a parent's id is always smaller.

use crate::{DatabaseEngine, DbError, DbPool};
use sqlx::Row;

/// Every application table, ordered so that a table only appears after all of
/// the tables it has foreign keys into. Kept in sync with the schema by
/// [`tests::migration_table_order_matches_schema`], which fails CI whenever a
/// new table is added to the migrations but not listed here.
///
/// Internal/derived tables are intentionally excluded (see
/// [`is_internal_table`]): the SQLx migration bookkeeping table, SQLite's
/// `sqlite_sequence`, and the SQLite-only `messages_fts*` full-text shadow
/// tables (PostgreSQL maintains search state through a `tsvector` trigger
/// instead, so those rows are regenerated on insert).
pub const MIGRATION_TABLE_ORDER: &[&str] = &[
    // Roots (no FK dependencies on other application tables).
    "auth_guard_state",
    "channel_follows",
    // Each day's answer; no FKs.
    "daily_word_puzzles",
    "federated_servers",
    "federation_delivery_attempts",
    "federation_events",
    "federation_file_cache",
    "federation_moderation_subscriptions",
    "federation_outbound_queue",
    "federation_peer_trust_state",
    "federation_room_sync_cursors",
    "federation_server_keys",
    "federation_transport_replay_cache",
    "guild_templates",
    // No FK into `users`: the claimed-owner id is recorded, not enforced, so
    // deleting the owner can never reopen setup by cascading this row away.
    "instance_setup",
    // No FKs: see the invite_signups migration.
    "invite_signups",
    "rate_limit_counters",
    "server_keypair",
    "server_settings",
    "stage_instances",
    "users",
    // Depend on users.
    "auth_sessions",
    "bot_applications",
    "bot_reviews",
    "daily_word_results",
    "email_verification_tokens",
    "federation_remote_users",
    "interaction_tokens",
    "mfa_backup_codes",
    "mfa_configs",
    "one_time_prekeys",
    "prekey_publication_receipts",
    "password_reset_tokens",
    "relationships",
    "security_events",
    "signed_prekeys",
    "spaces",
    "stickers",
    "user_achievements",
    "user_activity_streaks",
    "user_settings",
    "user_xp",
    // Depend on users/spaces (guilds).
    "soundboard_sounds",
    "user_xp_daily",
    "application_commands",
    "audit_log_entries",
    "automod_hits",
    "automod_rules",
    "bans",
    "bot_guild_installs",
    "bot_metric_events",
    "channels",
    "dm_recipients",
    "emojis",
    "federation_channel_map",
    "federation_room_memberships",
    "federation_space_map",
    "forum_tags",
    "group_e2ee_sender_keys",
    "guild_onboarding_settings",
    "guild_sports_settings",
    "guild_storage_policies",
    "invites",
    "member_onboarding_state",
    "members",
    "messages",
    "message_delivery_receipts",
    "message_edit_receipts",
    "message_delete_receipts",
    "message_recovery",
    "message_mentions",
    "moderation_action_templates",
    "polls",
    "reactions",
    "read_states",
    "roles",
    "scheduled_events",
    "scheduled_messages",
    "voice_states",
    "webhooks",
    // Leaf/feature tables (depend on the above).
    "anonymous_channel_aliases",
    "anonymous_messages",
    "attachments",
    "channel_feature_settings",
    // Both depend on users plus their scope (spaces / channels), so they belong
    // with the leaf tables rather than the roots.
    "channel_notification_settings",
    "channel_overwrites",
    "event_rsvps",
    "federation_message_map",
    "guild_daily_word_settings",
    "guild_level_roles",
    "guild_onboarding_role_options",
    "member_roles",
    "message_edits",
    "message_embeds",
    "saved_messages",
    "message_reminders",
    "message_stickers",
    "poll_options",
    "poll_votes",
    "space_notification_settings",
    "webhook_messages",
];

/// Tables that live in `sqlite_master` but must never be copied: migration
/// bookkeeping, SQLite internals, and the FTS5 shadow tables.
pub fn is_internal_table(name: &str) -> bool {
    name == "_sqlx_migrations"
        || name == "sqlite_sequence"
        || name == "messages_fts"
        || name.starts_with("messages_fts_")
}

/// Per-table outcome of a migration run.
#[derive(Debug, Clone)]
pub struct TableMigrationReport {
    pub table: String,
    pub columns: usize,
    /// Rows counted in the source table.
    pub source_rows: i64,
    /// Rows inserted into the target (always 0 on a dry run).
    pub copied_rows: i64,
}

/// Summary returned by [`migrate_sqlite_to_postgres`].
#[derive(Debug, Clone)]
pub struct MigrationReport {
    pub dry_run: bool,
    pub tables: Vec<TableMigrationReport>,
    /// Channels whose imported tail differed from their surviving messages.
    pub repaired_channel_tails: u64,
    /// New history identity committed with the copy; absent on a dry run.
    pub database_history_epoch: Option<String>,
}

impl MigrationReport {
    pub fn total_source_rows(&self) -> i64 {
        self.tables.iter().map(|t| t.source_rows).sum()
    }

    pub fn total_copied_rows(&self) -> i64 {
        self.tables.iter().map(|t| t.copied_rows).sum()
    }
}

/// How a target column's value must be encoded when binding a source row.
#[derive(Debug, Clone, PartialEq, Eq)]
enum TargetKind {
    Bool,
    Int,
    Real,
    Text,
    Blob,
    /// A temporal column; the payload is the SQL cast applied to the bound text
    /// placeholder (e.g. `timestamptz`).
    Temporal(&'static str),
}

impl TargetKind {
    /// SQL suffix appended to the parameter placeholder so PostgreSQL coerces
    /// the bound text into the column's real type.
    fn cast_suffix(&self) -> String {
        match self {
            TargetKind::Temporal(cast) => format!("::{cast}"),
            _ => String::new(),
        }
    }
}

/// Map a PostgreSQL `information_schema.columns.data_type` to a [`TargetKind`].
fn target_kind_for(data_type: &str) -> Option<TargetKind> {
    Some(match data_type {
        "boolean" => TargetKind::Bool,
        "smallint" | "integer" | "bigint" => TargetKind::Int,
        "real" | "double precision" => TargetKind::Real,
        "bytea" => TargetKind::Blob,
        "timestamp with time zone" => TargetKind::Temporal("timestamptz"),
        "timestamp without time zone" => TargetKind::Temporal("timestamp"),
        "date" => TargetKind::Temporal("date"),
        "time with time zone" => TargetKind::Temporal("timetz"),
        "time without time zone" => TargetKind::Temporal("time"),
        "text" | "character varying" | "character" => TargetKind::Text,
        // Unknown/custom types must get an explicit preservation strategy.
        // In particular, arbitrary-precision numeric cannot round through f64.
        _ => return None,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnPlan {
    name: String,
    kind: TargetKind,
    /// 1-based position of this column inside the source table's primary key,
    /// or 0 when it is not part of it (mirrors `PRAGMA table_info.pk`).
    pk: i64,
}

fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Build the parameterised `INSERT` used to copy a single row. Temporal columns
/// get an explicit cast so PostgreSQL accepts the normalised text value.
///
/// The statement upserts on the source primary key rather than plainly
/// inserting. `migrate_sqlite_to_postgres` runs the PostgreSQL migrations
/// against the target first, and several of those migrations seed rows --
/// `server_settings` most obviously. A plain `INSERT` then collided with the
/// seeded keys, and because the whole copy runs in one transaction, that single
/// duplicate-key error rolled everything back: the SQLite-to-PostgreSQL
/// migration tool could never succeed against a freshly migrated target.
/// Upserting keeps the source authoritative, which is what a copy should be.
fn build_insert_sql(table: &str, columns: &[ColumnPlan]) -> String {
    let col_list = columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    let placeholders = columns
        .iter()
        .enumerate()
        .map(|(i, c)| format!("${}{}", i + 1, c.kind.cast_suffix()))
        .collect::<Vec<_>>()
        .join(", ");

    let mut pk_cols: Vec<&ColumnPlan> = columns.iter().filter(|c| c.pk > 0).collect();
    pk_cols.sort_by_key(|c| c.pk);

    let conflict = if pk_cols.is_empty() {
        // No primary key to infer a conflict target from; nothing can collide
        // by key, so a plain INSERT is correct.
        String::new()
    } else {
        let target = pk_cols
            .iter()
            .map(|c| quote_ident(&c.name))
            .collect::<Vec<_>>()
            .join(", ");
        let assignments = columns
            .iter()
            .filter(|c| c.pk == 0)
            .map(|c| {
                let ident = quote_ident(&c.name);
                format!("{ident} = EXCLUDED.{ident}")
            })
            .collect::<Vec<_>>();
        if assignments.is_empty() {
            format!(" ON CONFLICT ({target}) DO NOTHING")
        } else {
            format!(
                " ON CONFLICT ({target}) DO UPDATE SET {}",
                assignments.join(", ")
            )
        }
    };

    format!(
        "INSERT INTO {} ({}) VALUES ({}){}",
        quote_ident(table),
        col_list,
        placeholders,
        conflict
    )
}

fn build_select_sql(table: &str, columns: &[ColumnPlan], keyset_pk: Option<&str>) -> String {
    let col_list = columns
        .iter()
        .map(|c| quote_ident(&c.name))
        .collect::<Vec<_>>()
        .join(", ");
    match keyset_pk {
        Some(pk) => format!(
            "SELECT {col_list} FROM {tbl} WHERE {pk} > $1 ORDER BY {pk} ASC LIMIT $2",
            tbl = quote_ident(table),
            pk = quote_ident(pk),
        ),
        None => {
            // Deterministic total order for OFFSET paging: fall back to the full
            // column list when the table has no primary key.
            let order = col_list.clone();
            format!(
                "SELECT {col_list} FROM {tbl} ORDER BY {order} LIMIT $1 OFFSET $2",
                tbl = quote_ident(table),
            )
        }
    }
}

/// A single column value extracted from the source, already coerced to the
/// target column's category so the bind type matches PostgreSQL's expectation.
#[derive(Debug, PartialEq)]
enum BoundValue {
    Bool(Option<bool>),
    Int(Option<i64>),
    Real(Option<f64>),
    Text(Option<String>),
    Blob(Option<Vec<u8>>),
}

fn normalize_temporal_text(raw: &str) -> String {
    // Canonicalise to UTC, retaining fractional seconds, so the `::timestamp*` cast is
    // unambiguous; PostgreSQL connections are pinned to UTC. If the value isn't
    // a recognised datetime, pass it through untouched and let PostgreSQL judge.
    match crate::datetime_from_db_text(raw) {
        Ok(dt) => dt.format("%Y-%m-%d %H:%M:%S%.f").to_string(),
        Err(_) => raw.to_string(),
    }
}

fn extract_value(
    row: &sqlx::sqlite::SqliteRow,
    column: &str,
    kind: &TargetKind,
) -> Result<BoundValue, DbError> {
    match kind {
        TargetKind::Bool => {
            // SQLite stores booleans as 0/1 integers.
            if let Ok(v) = row.try_get::<Option<i64>, _>(column) {
                Ok(BoundValue::Bool(v.map(|n| n != 0)))
            } else {
                Ok(BoundValue::Bool(row.try_get::<Option<bool>, _>(column)?))
            }
        }
        TargetKind::Int => Ok(BoundValue::Int(row.try_get::<Option<i64>, _>(column)?)),
        TargetKind::Real => {
            // Read integer storage first. Letting SQLite decode an integer as
            // f64 can round it before we can verify that its value survived.
            if let Ok(v) = row.try_get::<Option<i64>, _>(column) {
                let real = v.map(|integer| {
                    let float = integer as f64;
                    // Compare in i128: f64(i64::MAX) is 2^63, and an i64 cast
                    // would saturate back to MAX and incorrectly appear exact.
                    if float as i128 != i128::from(integer) {
                        return Err(protocol_err("source integer is not exactly representable in a floating-point target"));
                    }
                    Ok(float)
                }).transpose()?;
                Ok(BoundValue::Real(real))
            } else {
                Ok(BoundValue::Real(row.try_get::<Option<f64>, _>(column)?))
            }
        }
        TargetKind::Text => Ok(BoundValue::Text(row.try_get::<Option<String>, _>(column)?)),
        TargetKind::Blob => Ok(BoundValue::Blob(row.try_get::<Option<Vec<u8>>, _>(column)?)),
        TargetKind::Temporal(_) => {
            if let Ok(v) = row.try_get::<Option<String>, _>(column) {
                Ok(BoundValue::Text(v.map(|s| normalize_temporal_text(&s))))
            } else {
                // Stored as epoch millis; render as canonical datetime text.
                let millis = row.try_get::<Option<i64>, _>(column)?;
                let text = millis.map(|ms| {
                    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(ms)
                        .map(|dt| dt.format("%Y-%m-%d %H:%M:%S%.f").to_string())
                        .unwrap_or_else(|| ms.to_string())
                });
                Ok(BoundValue::Text(text))
            }
        }
    }
}

type AnyQuery<'q> = sqlx::query::Query<'q, sqlx::Any, sqlx::any::AnyArguments<'q>>;

fn bind_value(query: AnyQuery<'_>, value: BoundValue) -> AnyQuery<'_> {
    match value {
        BoundValue::Bool(v) => query.bind(v),
        BoundValue::Int(v) => query.bind(v),
        BoundValue::Real(v) => query.bind(v),
        BoundValue::Text(v) => query.bind(v),
        BoundValue::Blob(v) => query.bind(v),
    }
}

/// A source column: its name plus SQLite `pk` ordinal (0 when not part of the
/// primary key).
struct SourceColumn {
    name: String,
    pk: i64,
}

async fn fetch_source_columns(
    pool: &sqlx::SqlitePool,
    table: &str,
) -> Result<Vec<SourceColumn>, DbError> {
    // PRAGMA table_info returns rows in column-definition (cid) order.
    let rows = sqlx::query(&format!("PRAGMA table_info({})", quote_ident(table)))
        .fetch_all(pool)
        .await?;
    let mut cols = Vec::with_capacity(rows.len());
    for row in rows {
        cols.push(SourceColumn {
            name: row.try_get::<String, _>("name")?,
            pk: row.try_get::<i64, _>("pk")?,
        });
    }
    Ok(cols)
}

async fn fetch_target_columns(
    pool: &DbPool,
    table: &str,
) -> Result<std::collections::HashMap<String, String>, DbError> {
    let rows = sqlx::query(
        // information_schema identifiers have PostgreSQL NAME/domain types;
        // sqlx::Any supports ordinary TEXT, so normalize both metadata values.
        "SELECT CAST(column_name AS TEXT) AS column_name, \
         CAST(data_type AS TEXT) AS data_type FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1",
    )
    .bind(table)
    .fetch_all(pool)
    .await?;
    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let name: String = row.try_get("column_name")?;
        let data_type: String = row.try_get("data_type")?;
        map.insert(name, data_type);
    }
    Ok(map)
}

fn protocol_err(msg: impl Into<String>) -> DbError {
    DbError::Sqlx(sqlx::Error::Protocol(msg.into()))
}

/// Resolve the copy plan for one table: intersect the source columns with the
/// target schema and decide how each column is bound.
async fn plan_table(
    source: &sqlx::SqlitePool,
    target: &DbPool,
    table: &str,
) -> Result<(Vec<ColumnPlan>, Option<String>), DbError> {
    let source_cols = fetch_source_columns(source, table).await?;
    if source_cols.is_empty() {
        return Err(protocol_err(format!(
            "source table '{table}' has no columns (missing from source database?)"
        )));
    }
    let target_cols = fetch_target_columns(target, table).await?;
    if target_cols.is_empty() {
        return Err(protocol_err(format!(
            "target table '{table}' is missing from the PostgreSQL schema"
        )));
    }

    let mut plan = Vec::with_capacity(source_cols.len());
    for col in &source_cols {
        let Some(data_type) = target_cols.get(&col.name) else {
            // Refuse to silently drop data: a source column absent from the
            // target means the schemas have drifted.
            return Err(protocol_err(format!(
                "column '{}.{}' exists in SQLite but not in the PostgreSQL target",
                table, col.name
            )));
        };
        // Validate only columns copied from SQLite. PostgreSQL-only derived
        // columns (such as a tsvector maintained by a trigger) are not inputs.
        let kind = target_kind_for(data_type).ok_or_else(|| {
            protocol_err(format!(
                "unsupported PostgreSQL target type '{data_type}' for '{table}.{}'",
                col.name
            ))
        })?;
        plan.push(ColumnPlan {
            name: col.name.clone(),
            kind,
            pk: col.pk,
        });
    }

    // Keyset-paginate on a single integer primary key when available; this both
    // streams large tables cheaply and guarantees ascending-PK insert order for
    // self-referential foreign keys.
    let pk_cols: Vec<&SourceColumn> = source_cols.iter().filter(|c| c.pk > 0).collect();
    let keyset_pk = match pk_cols.as_slice() {
        [only]
            if target_cols
                .get(&only.name)
                .and_then(|data_type| target_kind_for(data_type))
                == Some(TargetKind::Int) =>
        {
            Some(only.name.clone())
        }
        _ => None,
    };

    Ok((plan, keyset_pk))
}

async fn count_rows(pool: &sqlx::SqlitePool, table: &str) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", quote_ident(table)))
        .fetch_one(pool)
        .await?;
    Ok(count)
}

/// Copy one table from `source` into the open target transaction. Returns the
/// number of rows inserted.
async fn copy_table(
    source: &sqlx::SqlitePool,
    tx: &mut sqlx::Transaction<'_, sqlx::Any>,
    table: &str,
    plan: &[ColumnPlan],
    keyset_pk: Option<&str>,
    batch_size: i64,
) -> Result<i64, DbError> {
    let select_sql = build_select_sql(table, plan, keyset_pk);
    let insert_sql = build_insert_sql(table, plan);

    let mut inserted: i64 = 0;
    let mut cursor: i64 = i64::MIN; // keyset cursor
    let mut offset: i64 = 0; // offset cursor

    loop {
        let rows = if let Some(pk) = keyset_pk {
            let _ = pk;
            sqlx::query(&select_sql)
                .bind(cursor)
                .bind(batch_size)
                .fetch_all(source)
                .await?
        } else {
            sqlx::query(&select_sql)
                .bind(batch_size)
                .bind(offset)
                .fetch_all(source)
                .await?
        };
        if rows.is_empty() {
            break;
        }
        let page_len = rows.len() as i64;

        for row in &rows {
            let mut query = sqlx::query(&insert_sql);
            for col in plan {
                let value = extract_value(row, &col.name, &col.kind).map_err(|error| {
                    protocol_err(format!(
                        "unsupported source value in '{}.{}': {error}",
                        table, col.name
                    ))
                })?;
                query = bind_value(query, value);
            }
            query.execute(&mut **tx).await?;
            inserted += 1;

            if let Some(pk) = keyset_pk {
                // Rows are ordered ascending, so the last row carries the max PK.
                cursor = row.try_get::<i64, _>(pk)?;
            }
        }

        if keyset_pk.is_none() {
            offset += page_len;
        }
        if page_len < batch_size {
            break;
        }
    }

    Ok(inserted)
}

/// Copy every table from a SQLite database into a PostgreSQL database.
///
/// The target's migrations are applied first, then all data is copied inside a
/// single transaction. Each table's inserted-row count is checked against the
/// source `COUNT(*)`; any mismatch aborts and rolls the whole transaction back,
/// preserving the target's state after schema migration. Schema migrations and
/// seeded settings are not rolled back. On `dry_run` the target schema is migrated
/// and column mappings are validated, but no source rows are copied and an
/// existing history epoch is not rotated. Keep both source and target offline;
/// source reads do not share a transaction snapshot.
pub async fn migrate_sqlite_to_postgres(
    source_url: &str,
    target_url: &str,
    batch_size: i64,
    dry_run: bool,
) -> Result<MigrationReport, DbError> {
    if crate::detect_database_engine(source_url)? != DatabaseEngine::Sqlite {
        return Err(protocol_err(format!(
            "--source must be a SQLite URL, got '{}'",
            paracord_util::redact::redact_db_url(source_url)
        )));
    }
    if crate::detect_database_engine(target_url)? != DatabaseEngine::Postgres {
        return Err(protocol_err(format!(
            "--target must be a PostgreSQL URL, got '{}'",
            paracord_util::redact::redact_db_url(target_url)
        )));
    }
    let batch_size = batch_size.max(1);

    // Read with SQLite's typed driver: Any rejects declared BOOLEAN/DATE types
    // before extract_value can inspect them. Avoid SQL CAST workarounds, which
    // would turn malformed source strings into zero or otherwise lose bytes.
    // The source remains read-only and each value retains its storage class.
    let source = sqlx::sqlite::SqlitePoolOptions::new()
        .max_connections(4)
        .connect_with(
            source_url
                .parse::<sqlx::sqlite::SqliteConnectOptions>()?
                .read_only(true)
                .create_if_missing(false),
        )
        .await?;
    let target =
        crate::create_pool_full(target_url, 4, Some(DatabaseEngine::Postgres), None, None).await?;

    // Bring the target schema up to date (idempotent) before copying data.
    crate::run_migrations_for_engine(&target, DatabaseEngine::Postgres).await?;

    if dry_run {
        let mut tables = Vec::with_capacity(MIGRATION_TABLE_ORDER.len());
        for &table in MIGRATION_TABLE_ORDER {
            let (plan, _keyset) = plan_table(&source, &target, table).await?;
            // Exercise the SQL builders so a malformed plan surfaces in dry-run.
            let _ = build_insert_sql(table, &plan);
            let source_rows = count_rows(&source, table).await?;
            tables.push(TableMigrationReport {
                table: table.to_string(),
                columns: plan.len(),
                source_rows,
                copied_rows: 0,
            });
        }
        return Ok(MigrationReport {
            dry_run: true,
            tables,
            repaired_channel_tails: 0,
            database_history_epoch: None,
        });
    }

    // Plan every table so a schema mismatch fails before any source row copies.
    // Target schema migrations and their seed rows have already committed.
    let mut plans = Vec::with_capacity(MIGRATION_TABLE_ORDER.len());
    for &table in MIGRATION_TABLE_ORDER {
        let (plan, keyset) = plan_table(&source, &target, table).await?;
        plans.push((table, plan, keyset));
    }

    let mut tx = target.begin().await?;
    let mut tables = Vec::with_capacity(plans.len());
    for (table, plan, keyset) in &plans {
        let source_rows = count_rows(&source, table).await?;
        let copied =
            copy_table(&source, &mut tx, table, plan, keyset.as_deref(), batch_size).await?;
        if copied != source_rows {
            // Roll the whole transaction back — no partial state.
            drop(tx);
            return Err(protocol_err(format!(
                "row-count mismatch on '{table}': source has {source_rows}, copied {copied}; \
                 rolled back copied rows (target schema migrations remain applied)"
            )));
        }
        tables.push(TableMigrationReport {
            table: table.to_string(),
            columns: plan.len(),
            source_rows,
            copied_rows: copied,
        });
    }

    // Migrations ran before copying channels, so their one-time tail repair
    // cannot correct imported legacy pointers. Repair only after messages have
    // arrived, and never retain the history identity copied from source settings.
    let repaired_channel_tails = crate::channels::repair_message_tails_for_import(&mut tx).await?;
    let database_history_epoch =
        crate::server_settings::rotate_database_history_epoch(&mut tx).await?;
    tx.commit().await?;

    Ok(MigrationReport {
        dry_run: false,
        tables,
        repaired_channel_tails,
        database_history_epoch: Some(database_history_epoch),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[tokio::test]
    async fn typed_source_preserves_null_boolean_temporal_blob_and_rejects_bad_values() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query("CREATE TABLE values_fixture(id INTEGER PRIMARY KEY, enabled BOOLEAN, nullable BOOLEAN, stamp DATETIME, moment TIMESTAMP, day DATE, clock TIME, payload BLOB, name TEXT, score REAL)")
            .execute(&pool).await.unwrap();
        sqlx::query("INSERT INTO values_fixture VALUES(1,1,NULL,'2026-09-12 12:34:56','2026-09-12T12:34:56Z','2026-09-12','12:34:56',X'00FF','literal',1.25), (2,0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL), (3,'invalid',NULL,'invalid',NULL,NULL,NULL,X'FE',NULL,NULL)")
            .execute(&pool).await.unwrap();
        let rows = sqlx::query("SELECT * FROM values_fixture ORDER BY id")
            .fetch_all(&pool)
            .await
            .unwrap();
        assert_eq!(
            extract_value(&rows[0], "enabled", &TargetKind::Bool).unwrap(),
            BoundValue::Bool(Some(true))
        );
        assert_eq!(
            extract_value(&rows[1], "enabled", &TargetKind::Bool).unwrap(),
            BoundValue::Bool(Some(false))
        );
        assert_eq!(
            extract_value(&rows[0], "nullable", &TargetKind::Bool).unwrap(),
            BoundValue::Bool(None)
        );
        assert_eq!(
            extract_value(&rows[0], "stamp", &TargetKind::Temporal("timestamp")).unwrap(),
            BoundValue::Text(Some("2026-09-12 12:34:56".into()))
        );
        assert_eq!(
            extract_value(&rows[0], "moment", &TargetKind::Temporal("timestamptz")).unwrap(),
            BoundValue::Text(Some("2026-09-12 12:34:56".into()))
        );
        assert_eq!(
            extract_value(&rows[0], "day", &TargetKind::Temporal("date")).unwrap(),
            BoundValue::Text(Some("2026-09-12".into()))
        );
        assert_eq!(
            extract_value(&rows[0], "clock", &TargetKind::Temporal("time")).unwrap(),
            BoundValue::Text(Some("12:34:56".into()))
        );
        assert_eq!(
            extract_value(&rows[0], "payload", &TargetKind::Blob).unwrap(),
            BoundValue::Blob(Some(vec![0, 255]))
        );
        assert_eq!(
            extract_value(&rows[1], "payload", &TargetKind::Blob).unwrap(),
            BoundValue::Blob(None)
        );
        assert_eq!(
            extract_value(&rows[0], "name", &TargetKind::Text).unwrap(),
            BoundValue::Text(Some("literal".into()))
        );
        assert_eq!(
            extract_value(&rows[0], "score", &TargetKind::Real).unwrap(),
            BoundValue::Real(Some(1.25))
        );
        assert!(extract_value(&rows[2], "enabled", &TargetKind::Bool).is_err());
        assert!(extract_value(&rows[2], "payload", &TargetKind::Text).is_err());
        // Unrecognized temporal strings are preserved for PostgreSQL's cast to
        // reject, never silently normalized to a different time.
        assert_eq!(
            extract_value(&rows[2], "stamp", &TargetKind::Temporal("timestamp")).unwrap(),
            BoundValue::Text(Some("invalid".into()))
        );
        for integer in [9_007_199_254_740_993_i64, i64::MAX] {
            let row = sqlx::query("SELECT $1 AS value")
                .bind(integer)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert!(extract_value(&row, "value", &TargetKind::Real).is_err());
        }
        for integer in [1_i64 << 54, i64::MIN] {
            let row = sqlx::query("SELECT $1 AS value")
                .bind(integer)
                .fetch_one(&pool)
                .await
                .unwrap();
            assert_eq!(
                extract_value(&row, "value", &TargetKind::Real).unwrap(),
                BoundValue::Real(Some(integer as f64))
            );
        }
        assert!(target_kind_for("numeric").is_none());
        assert!(target_kind_for("USER-DEFINED").is_none());
        assert_eq!(
            normalize_temporal_text("2026-09-12T12:34:56.125+02:00"),
            "2026-09-12 10:34:56.125"
        );
        pool.close().await;
    }

    #[test]
    fn build_insert_sql_casts_temporal_columns_and_upserts_on_the_primary_key() {
        let columns = vec![
            ColumnPlan {
                name: "id".to_string(),
                kind: TargetKind::Int,
                pk: 1,
            },
            ColumnPlan {
                name: "name".to_string(),
                kind: TargetKind::Text,
                pk: 0,
            },
            ColumnPlan {
                name: "expires_at".to_string(),
                kind: TargetKind::Temporal("timestamptz"),
                pk: 0,
            },
        ];
        let sql = build_insert_sql("webhooks", &columns);
        assert_eq!(
            sql,
            r#"INSERT INTO "webhooks" ("id", "name", "expires_at") VALUES ($1, $2, $3::timestamptz) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "expires_at" = EXCLUDED."expires_at""#
        );
    }

    #[test]
    fn build_insert_sql_upserts_seeded_key_value_tables() {
        // `server_settings` is seeded by the PostgreSQL migrations that run
        // against the target before the copy starts. A plain INSERT collided
        // with those seeds and rolled the entire copy transaction back.
        let columns = vec![
            ColumnPlan {
                name: "key".to_string(),
                kind: TargetKind::Text,
                pk: 1,
            },
            ColumnPlan {
                name: "value".to_string(),
                kind: TargetKind::Text,
                pk: 0,
            },
        ];
        assert_eq!(
            build_insert_sql("server_settings", &columns),
            r#"INSERT INTO "server_settings" ("key", "value") VALUES ($1, $2) ON CONFLICT ("key") DO UPDATE SET "value" = EXCLUDED."value""#
        );
    }

    #[test]
    fn build_insert_sql_uses_do_nothing_when_every_column_is_a_key() {
        let columns = vec![
            ColumnPlan {
                name: "user_id".to_string(),
                kind: TargetKind::Int,
                pk: 1,
            },
            ColumnPlan {
                name: "role_id".to_string(),
                kind: TargetKind::Int,
                pk: 2,
            },
        ];
        assert_eq!(
            build_insert_sql("member_roles", &columns),
            r#"INSERT INTO "member_roles" ("user_id", "role_id") VALUES ($1, $2) ON CONFLICT ("user_id", "role_id") DO NOTHING"#
        );
    }

    #[test]
    fn build_select_sql_keyset_vs_offset() {
        let columns = vec![
            ColumnPlan {
                name: "id".to_string(),
                kind: TargetKind::Int,
                pk: 1,
            },
            ColumnPlan {
                name: "content".to_string(),
                kind: TargetKind::Text,
                pk: 0,
            },
        ];
        assert_eq!(
            build_select_sql("messages", &columns, Some("id")),
            r#"SELECT "id", "content" FROM "messages" WHERE "id" > $1 ORDER BY "id" ASC LIMIT $2"#
        );
        assert_eq!(
            build_select_sql("member_roles", &columns, None),
            r#"SELECT "id", "content" FROM "member_roles" ORDER BY "id", "content" LIMIT $1 OFFSET $2"#
        );
    }

    #[test]
    fn target_kind_mapping() {
        assert_eq!(target_kind_for("boolean").unwrap(), TargetKind::Bool);
        assert_eq!(target_kind_for("bigint").unwrap(), TargetKind::Int);
        assert_eq!(target_kind_for("smallint").unwrap(), TargetKind::Int);
        assert_eq!(target_kind_for("bytea").unwrap(), TargetKind::Blob);
        assert_eq!(target_kind_for("text").unwrap(), TargetKind::Text);
        assert_eq!(
            target_kind_for("character varying").unwrap(),
            TargetKind::Text
        );
        assert_eq!(
            target_kind_for("timestamp with time zone").unwrap(),
            TargetKind::Temporal("timestamptz")
        );
        assert_eq!(
            target_kind_for("timestamp without time zone").unwrap(),
            TargetKind::Temporal("timestamp")
        );
    }

    #[test]
    fn migration_table_order_has_no_duplicates_or_internal_tables() {
        let mut seen = BTreeSet::new();
        for &table in MIGRATION_TABLE_ORDER {
            assert!(seen.insert(table), "duplicate table in order: {table}");
            assert!(
                !is_internal_table(table),
                "internal table must not be migrated: {table}"
            );
        }
    }

    #[tokio::test]
    async fn migration_table_order_matches_schema() {
        let pool = crate::create_pool("sqlite::memory:", 1)
            .await
            .expect("pool");
        crate::run_migrations(&pool).await.expect("migrations");

        let rows: Vec<(String,)> =
            sqlx::query_as("SELECT name FROM sqlite_master WHERE type = 'table'")
                .fetch_all(&pool)
                .await
                .expect("list tables");

        let schema: BTreeSet<String> = rows
            .into_iter()
            .map(|(name,)| name)
            .filter(|name| !is_internal_table(name))
            .collect();
        let listed: BTreeSet<String> = MIGRATION_TABLE_ORDER
            .iter()
            .map(|s| s.to_string())
            .collect();

        let missing: Vec<&String> = schema.difference(&listed).collect();
        let extra: Vec<&String> = listed.difference(&schema).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "MIGRATION_TABLE_ORDER out of sync with schema.\n  missing (add these): {missing:?}\n  extra (remove these): {extra:?}"
        );
    }
}
