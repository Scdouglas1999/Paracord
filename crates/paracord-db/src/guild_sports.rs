//! Per-server sports add-on settings.
//!
//! Booleans are bound as Rust `bool` and read back through `CAST(col AS INTEGER)`
//! plus [`bool_from_any_row`]: PostgreSQL rejects a bigint bound into BOOLEAN,
//! and the `Any` driver cannot decode SQLite's Bool type info directly.
//! `updated_at` is TEXT on both engines.

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuildSportsRow {
    pub guild_id: i64,
    pub enabled: bool,
    pub leagues: String,
    pub favorite_teams: String,
    pub show_on_server_page: bool,
    pub default_view: String,
    pub layout: String,
    /// JSON array of channel pins. `[]` when the server has none.
    pub channel_pins: String,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildSportsRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let updated_at: String = row.try_get("updated_at")?;
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            enabled: bool_from_any_row(row, "enabled")?,
            leagues: row
                .try_get::<Option<String>, _>("leagues")?
                .unwrap_or_else(|| "[]".to_string()),
            favorite_teams: row
                .try_get::<Option<String>, _>("favorite_teams")?
                .unwrap_or_else(|| "[]".to_string()),
            show_on_server_page: bool_from_any_row(row, "show_on_server_page")?,
            default_view: row.try_get("default_view")?,
            layout: row.try_get("layout")?,
            channel_pins: row
                .try_get::<Option<String>, _>("channel_pins")?
                .filter(|text| !text.is_empty())
                .unwrap_or_else(|| "[]".to_string()),
            updated_at: datetime_from_db_text(&updated_at)?,
        })
    }
}

const ROW_COLUMNS: &str =
    "guild_id, CAST(enabled AS INTEGER) AS enabled, leagues, favorite_teams, \
     CAST(show_on_server_page AS INTEGER) AS show_on_server_page, default_view, layout, channel_pins, updated_at";

pub async fn get(pool: &DbPool, guild_id: i64) -> Result<Option<GuildSportsRow>, DbError> {
    let row = sqlx::query_as::<_, GuildSportsRow>(&format!(
        "SELECT {ROW_COLUMNS} FROM guild_sports_settings WHERE guild_id = $1"
    ))
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

#[allow(clippy::too_many_arguments)]
pub async fn upsert(
    pool: &DbPool,
    guild_id: i64,
    enabled: bool,
    leagues: &str,
    favorite_teams: &str,
    show_on_server_page: bool,
    default_view: &str,
    layout: &str,
) -> Result<GuildSportsRow, DbError> {
    let row = sqlx::query_as::<_, GuildSportsRow>(&format!(
        "INSERT INTO guild_sports_settings
            (guild_id, enabled, leagues, favorite_teams, show_on_server_page, default_view, layout, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (guild_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            leagues = EXCLUDED.leagues,
            favorite_teams = EXCLUDED.favorite_teams,
            show_on_server_page = EXCLUDED.show_on_server_page,
            default_view = EXCLUDED.default_view,
            layout = EXCLUDED.layout,
            updated_at = EXCLUDED.updated_at
         RETURNING {ROW_COLUMNS}"
    ))
    .bind(guild_id)
    .bind(enabled)
    .bind(leagues)
    .bind(favorite_teams)
    .bind(show_on_server_page)
    .bind(default_view)
    .bind(layout)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Enabled servers that have at least one channel pin.
pub async fn list_enabled_with_pins(pool: &DbPool) -> Result<Vec<GuildSportsRow>, DbError> {
    let rows = sqlx::query_as::<_, GuildSportsRow>(&format!(
        "SELECT {ROW_COLUMNS} FROM guild_sports_settings WHERE enabled = $1 AND channel_pins <> '[]'"
    ))
    .bind(true)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn set_channel_pins(
    pool: &DbPool,
    guild_id: i64,
    channel_pins: &str,
) -> Result<GuildSportsRow, DbError> {
    let row = sqlx::query_as::<_, GuildSportsRow>(&format!(
        "UPDATE guild_sports_settings SET channel_pins = $2 WHERE guild_id = $1 RETURNING {ROW_COLUMNS}"
    ))
    .bind(guild_id)
    .bind(channel_pins)
    .fetch_one(pool)
    .await?;
    Ok(row)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_pool, run_migrations};

    async fn seeded() -> (DbPool, i64) {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        let (user_id, guild_id) = (91001, 91002);
        sqlx::query(
            "INSERT INTO users (id, username, email, password_hash) VALUES ($1, 'su', 's@e.com', 'x')",
        )
        .bind(user_id)
        .execute(&pool)
        .await
        .expect("user");
        sqlx::query("INSERT INTO spaces (id, name, owner_id) VALUES ($1, 'Sports', $2)")
            .bind(guild_id)
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("space");
        (pool, guild_id)
    }

    #[tokio::test]
    async fn missing_row_is_none_and_upsert_round_trips_bools() {
        let (pool, guild_id) = seeded().await;
        assert!(get(&pool, guild_id).await.unwrap().is_none());

        let saved = upsert(
            &pool,
            guild_id,
            true,
            r#"["hockey/nhl"]"#,
            r#"[{"league":"hockey/nhl","team_id":"1","abbr":"NJD","name":"Devils"}]"#,
            false,
            "favorites",
            "list",
        )
        .await
        .unwrap();
        assert!(saved.enabled);
        assert!(!saved.show_on_server_page);
        assert_eq!(saved.default_view, "favorites");
        assert_eq!(saved.layout, "list");
        assert_eq!(saved.leagues, r#"["hockey/nhl"]"#);
        assert_eq!(saved.channel_pins, "[]");

        let pinned = set_channel_pins(&pool, guild_id, r#"[{"channel_id":"1"}]"#)
            .await
            .unwrap();
        assert_eq!(pinned.channel_pins, r#"[{"channel_id":"1"}]"#);
        assert_eq!(
            get(&pool, guild_id).await.unwrap().unwrap().channel_pins,
            pinned.channel_pins
        );

        let again = upsert(
            &pool,
            guild_id,
            false,
            r#"["baseball/mlb","football/nfl"]"#,
            "[]",
            true,
            "live",
            "cards",
        )
        .await
        .unwrap();
        assert!(!again.enabled);
        assert!(again.show_on_server_page);
        assert_eq!(again.default_view, "live");
        assert_eq!(again.layout, "cards");
        assert_eq!(again.favorite_teams, "[]");
        assert_eq!(get(&pool, guild_id).await.unwrap().unwrap(), again);
    }

    #[tokio::test]
    async fn list_enabled_with_pins_skips_off_and_empty() {
        let (pool, guild_id) = seeded().await;
        assert!(list_enabled_with_pins(&pool).await.unwrap().is_empty());
        upsert(&pool, guild_id, true, "[]", "[]", true, "all", "cards")
            .await
            .unwrap();
        assert!(list_enabled_with_pins(&pool).await.unwrap().is_empty());
        set_channel_pins(&pool, guild_id, r#"[{"channel_id":"1"}]"#)
            .await
            .unwrap();
        assert_eq!(list_enabled_with_pins(&pool).await.unwrap().len(), 1);
        upsert(&pool, guild_id, false, "[]", "[]", true, "all", "cards")
            .await
            .unwrap();
        assert!(list_enabled_with_pins(&pool).await.unwrap().is_empty());
    }
}
