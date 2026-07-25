//! One-shot SQLite → PostgreSQL data migration.
//!
//! Copies every application table from a source SQLite database into a freshly
//! migrated PostgreSQL database inside a single target transaction. Either the
//! whole copy commits or nothing is written: after streaming each table the
//! source `COUNT(*)` is compared against the number of rows inserted, and any
//! mismatch rolls the entire transaction back.
//!
//! The table list ([`MIGRATION_TABLE_ORDER`]) is FK-safe (parents precede
//! children) so inserts satisfy PostgreSQL's immediate foreign-key checks, and
//! within each table rows are streamed in ascending primary-key order so
//! self-referential foreign keys (e.g. `channels.parent_id`, `messages
//! .reference_id`) are always inserted after their parent — snowflake IDs are
//! monotonic with creation time, so a parent's id is always smaller.

use crate::{datetime_to_db_text, DatabaseEngine, DbError, DbPool};
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
    "rate_limit_counters",
    "server_keypair",
    "server_settings",
    "stage_instances",
    "users",
    // Depend on users.
    "auth_sessions",
    "bot_applications",
    "bot_reviews",
    "email_verification_tokens",
    "federation_remote_users",
    "interaction_tokens",
    "mfa_backup_codes",
    "mfa_configs",
    "one_time_prekeys",
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
    "guild_storage_policies",
    "invites",
    "member_onboarding_state",
    "members",
    "messages",
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
    "channel_overwrites",
    "event_rsvps",
    "federation_message_map",
    "guild_level_roles",
    "guild_onboarding_role_options",
    "member_roles",
    "message_edits",
    "message_embeds",
    "saved_messages",
    "message_stickers",
    "poll_options",
    "poll_votes",
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
fn target_kind_for(data_type: &str) -> TargetKind {
    match data_type {
        "boolean" => TargetKind::Bool,
        "smallint" | "integer" | "bigint" => TargetKind::Int,
        "real" | "double precision" | "numeric" => TargetKind::Real,
        "bytea" => TargetKind::Blob,
        "timestamp with time zone" => TargetKind::Temporal("timestamptz"),
        "timestamp without time zone" => TargetKind::Temporal("timestamp"),
        "date" => TargetKind::Temporal("date"),
        other if other.starts_with("time") => TargetKind::Temporal("time"),
        // text, character varying, character, uuid, ... — copied verbatim.
        _ => TargetKind::Text,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ColumnPlan {
    name: String,
    kind: TargetKind,
}

fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

/// Build the parameterised `INSERT` used to copy a single row. Temporal columns
/// get an explicit cast so PostgreSQL accepts the normalised text value.
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
    format!(
        "INSERT INTO {} ({}) VALUES ({})",
        quote_ident(table),
        col_list,
        placeholders
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
enum BoundValue {
    Bool(Option<bool>),
    Int(Option<i64>),
    Real(Option<f64>),
    Text(Option<String>),
    Blob(Option<Vec<u8>>),
}

fn normalize_temporal_text(raw: &str) -> String {
    // Canonicalise to `YYYY-MM-DD HH:MM:SS` (UTC) so the `::timestamp*` cast is
    // unambiguous; PostgreSQL connections are pinned to UTC. If the value isn't
    // a recognised datetime, pass it through untouched and let PostgreSQL judge.
    match crate::datetime_from_db_text(raw) {
        Ok(dt) => datetime_to_db_text(dt),
        Err(_) => raw.to_string(),
    }
}

fn extract_value(
    row: &sqlx::any::AnyRow,
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
            if let Ok(v) = row.try_get::<Option<f64>, _>(column) {
                Ok(BoundValue::Real(v))
            } else {
                Ok(BoundValue::Real(
                    row.try_get::<Option<i64>, _>(column)?.map(|n| n as f64),
                ))
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
                        .map(datetime_to_db_text)
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

async fn fetch_source_columns(pool: &DbPool, table: &str) -> Result<Vec<SourceColumn>, DbError> {
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
) -> Result<std::collections::HashMap<String, TargetKind>, DbError> {
    let rows = sqlx::query(
        "SELECT column_name, data_type FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1",
    )
    .bind(table)
    .fetch_all(pool)
    .await?;
    let mut map = std::collections::HashMap::with_capacity(rows.len());
    for row in rows {
        let name: String = row.try_get("column_name")?;
        let data_type: String = row.try_get("data_type")?;
        map.insert(name, target_kind_for(&data_type));
    }
    Ok(map)
}

fn protocol_err(msg: impl Into<String>) -> DbError {
    DbError::Sqlx(sqlx::Error::Protocol(msg.into()))
}

/// Resolve the copy plan for one table: intersect the source columns with the
/// target schema and decide how each column is bound.
async fn plan_table(
    source: &DbPool,
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
        let Some(kind) = target_cols.get(&col.name) else {
            // Refuse to silently drop data: a source column absent from the
            // target means the schemas have drifted.
            return Err(protocol_err(format!(
                "column '{}.{}' exists in SQLite but not in the PostgreSQL target",
                table, col.name
            )));
        };
        plan.push(ColumnPlan {
            name: col.name.clone(),
            kind: kind.clone(),
        });
    }

    // Keyset-paginate on a single integer primary key when available; this both
    // streams large tables cheaply and guarantees ascending-PK insert order for
    // self-referential foreign keys.
    let pk_cols: Vec<&SourceColumn> = source_cols.iter().filter(|c| c.pk > 0).collect();
    let keyset_pk = match pk_cols.as_slice() {
        [only] if target_cols.get(&only.name) == Some(&TargetKind::Int) => Some(only.name.clone()),
        _ => None,
    };

    Ok((plan, keyset_pk))
}

async fn count_rows(pool: &DbPool, table: &str) -> Result<i64, DbError> {
    let count: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM {}", quote_ident(table)))
        .fetch_one(pool)
        .await?;
    Ok(count)
}

/// Copy one table from `source` into the open target transaction. Returns the
/// number of rows inserted.
async fn copy_table(
    source: &DbPool,
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
                let value = extract_value(row, &col.name, &col.kind)?;
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
/// leaving the target untouched. On `dry_run` the target schema is migrated and
/// column mappings are validated, but no rows are written.
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

    let source =
        crate::create_pool_full(source_url, 4, Some(DatabaseEngine::Sqlite), None, None).await?;
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
        });
    }

    // Plan every table up front so a schema mismatch fails before any writes.
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
                 rolled back with no changes"
            )));
        }
        tables.push(TableMigrationReport {
            table: table.to_string(),
            columns: plan.len(),
            source_rows,
            copied_rows: copied,
        });
    }

    tx.commit().await?;

    Ok(MigrationReport {
        dry_run: false,
        tables,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn build_insert_sql_casts_temporal_columns() {
        let columns = vec![
            ColumnPlan {
                name: "id".to_string(),
                kind: TargetKind::Int,
            },
            ColumnPlan {
                name: "name".to_string(),
                kind: TargetKind::Text,
            },
            ColumnPlan {
                name: "expires_at".to_string(),
                kind: TargetKind::Temporal("timestamptz"),
            },
        ];
        let sql = build_insert_sql("webhooks", &columns);
        assert_eq!(
            sql,
            r#"INSERT INTO "webhooks" ("id", "name", "expires_at") VALUES ($1, $2, $3::timestamptz)"#
        );
    }

    #[test]
    fn build_select_sql_keyset_vs_offset() {
        let columns = vec![
            ColumnPlan {
                name: "id".to_string(),
                kind: TargetKind::Int,
            },
            ColumnPlan {
                name: "content".to_string(),
                kind: TargetKind::Text,
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
        assert_eq!(target_kind_for("boolean"), TargetKind::Bool);
        assert_eq!(target_kind_for("bigint"), TargetKind::Int);
        assert_eq!(target_kind_for("smallint"), TargetKind::Int);
        assert_eq!(target_kind_for("bytea"), TargetKind::Blob);
        assert_eq!(target_kind_for("text"), TargetKind::Text);
        assert_eq!(target_kind_for("character varying"), TargetKind::Text);
        assert_eq!(
            target_kind_for("timestamp with time zone"),
            TargetKind::Temporal("timestamptz")
        );
        assert_eq!(
            target_kind_for("timestamp without time zone"),
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
