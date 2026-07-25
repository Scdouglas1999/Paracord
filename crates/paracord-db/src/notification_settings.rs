//! Per-space and per-channel notification settings.
//!
//! Resolution is channel -> space -> default. A channel row only overrides the
//! fields it sets, so "mute this one channel in a space I otherwise follow" and
//! "follow this one channel in a space I muted" are both expressible.
//!
//! Booleans are bound as Rust `bool` and read back through
//! `CAST(col AS INTEGER)` + [`bool_from_any_row`], per the dual-engine rules in
//! CLAUDE.md: PostgreSQL rejects a bigint bound into BOOLEAN, and the `Any`
//! driver cannot decode SQLite's Bool type info directly.

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

/// Every message in scope raises a notification.
pub const LEVEL_ALL: i16 = 0;
/// Only messages that mention the viewer raise a notification.
pub const LEVEL_MENTIONS: i16 = 1;
/// Nothing in scope raises a notification.
pub const LEVEL_NOTHING: i16 = 2;

/// Whether `level` is one of the three defined levels.
pub fn is_valid_level(level: i16) -> bool {
    matches!(level, LEVEL_ALL | LEVEL_MENTIONS | LEVEL_NOTHING)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NotificationSettingRow {
    /// Space id or channel id, depending on which table it came from.
    pub scope_id: i64,
    pub level: i16,
    pub muted: bool,
    /// `None` with `muted` set means muted indefinitely.
    pub muted_until: Option<DateTime<Utc>>,
    pub suppress_everyone: bool,
}

impl NotificationSettingRow {
    /// Whether the mute is in force at `now`.
    ///
    /// A lapsed `muted_until` is not a mute. The row is left in place rather
    /// than swept, so this must be evaluated on read — otherwise a temporary
    /// mute would silently become permanent.
    pub fn is_muted_at(&self, now: DateTime<Utc>) -> bool {
        match (self.muted, self.muted_until) {
            (false, _) => false,
            (true, None) => true,
            (true, Some(until)) => until > now,
        }
    }
}

fn row_from(
    row: &sqlx::any::AnyRow,
    id_column: &str,
) -> Result<NotificationSettingRow, sqlx::Error> {
    let muted_until: Option<String> = row.try_get("muted_until")?;
    Ok(NotificationSettingRow {
        scope_id: row.try_get(id_column)?,
        level: row.try_get("level")?,
        muted: bool_from_any_row(row, "muted")?,
        muted_until: muted_until
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .map(datetime_from_db_text)
            .transpose()?,
        suppress_everyone: bool_from_any_row(row, "suppress_everyone")?,
    })
}

const SPACE_SELECT: &str = "space_id, level, CAST(muted AS INTEGER) AS muted, muted_until, \
     CAST(suppress_everyone AS INTEGER) AS suppress_everyone";
const CHANNEL_SELECT: &str = "channel_id, level, CAST(muted AS INTEGER) AS muted, muted_until, \
     CAST(suppress_everyone AS INTEGER) AS suppress_everyone";

/// Upsert one space's settings for a user.
pub async fn set_space_settings(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
    level: i16,
    muted: bool,
    muted_until: Option<DateTime<Utc>>,
    suppress_everyone: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO space_notification_settings
             (user_id, space_id, level, muted, muted_until, suppress_everyone, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, space_id) DO UPDATE SET
             level = EXCLUDED.level,
             muted = EXCLUDED.muted,
             muted_until = EXCLUDED.muted_until,
             suppress_everyone = EXCLUDED.suppress_everyone,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(user_id)
    .bind(space_id)
    .bind(level)
    .bind(muted)
    .bind(muted_until.map(datetime_to_db_text))
    .bind(suppress_everyone)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// Upsert one channel's settings for a user.
pub async fn set_channel_settings(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
    level: i16,
    muted: bool,
    muted_until: Option<DateTime<Utc>>,
    suppress_everyone: bool,
) -> Result<(), DbError> {
    sqlx::query(
        "INSERT INTO channel_notification_settings
             (user_id, channel_id, level, muted, muted_until, suppress_everyone, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, channel_id) DO UPDATE SET
             level = EXCLUDED.level,
             muted = EXCLUDED.muted,
             muted_until = EXCLUDED.muted_until,
             suppress_everyone = EXCLUDED.suppress_everyone,
             updated_at = EXCLUDED.updated_at",
    )
    .bind(user_id)
    .bind(channel_id)
    .bind(level)
    .bind(muted)
    .bind(muted_until.map(datetime_to_db_text))
    .bind(suppress_everyone)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    Ok(())
}

/// Drop a space override, returning the user to the default.
pub async fn clear_space_settings(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM space_notification_settings WHERE user_id = $1 AND space_id = $2")
        .bind(user_id)
        .bind(space_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Drop a channel override, returning the channel to its space's setting.
pub async fn clear_channel_settings(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
) -> Result<(), DbError> {
    sqlx::query("DELETE FROM channel_notification_settings WHERE user_id = $1 AND channel_id = $2")
        .bind(user_id)
        .bind(channel_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Every space override this user holds.
pub async fn list_space_settings(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<NotificationSettingRow>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {SPACE_SELECT} FROM space_notification_settings WHERE user_id = $1"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| row_from(row, "space_id").map_err(DbError::from))
        .collect()
}

/// Every channel override this user holds.
pub async fn list_channel_settings(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<NotificationSettingRow>, DbError> {
    let rows = sqlx::query(&format!(
        "SELECT {CHANNEL_SELECT} FROM channel_notification_settings WHERE user_id = $1"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| row_from(row, "channel_id").map_err(DbError::from))
        .collect()
}

/// One space override, if set.
pub async fn get_space_settings(
    pool: &DbPool,
    user_id: i64,
    space_id: i64,
) -> Result<Option<NotificationSettingRow>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {SPACE_SELECT} FROM space_notification_settings
         WHERE user_id = $1 AND space_id = $2"
    ))
    .bind(user_id)
    .bind(space_id)
    .fetch_optional(pool)
    .await?;
    row.as_ref()
        .map(|row| row_from(row, "space_id").map_err(DbError::from))
        .transpose()
}

/// One channel override, if set.
pub async fn get_channel_settings(
    pool: &DbPool,
    user_id: i64,
    channel_id: i64,
) -> Result<Option<NotificationSettingRow>, DbError> {
    let row = sqlx::query(&format!(
        "SELECT {CHANNEL_SELECT} FROM channel_notification_settings
         WHERE user_id = $1 AND channel_id = $2"
    ))
    .bind(user_id)
    .bind(channel_id)
    .fetch_optional(pool)
    .await?;
    row.as_ref()
        .map(|row| row_from(row, "channel_id").map_err(DbError::from))
        .transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_pool, run_migrations};

    async fn seeded() -> (DbPool, i64, i64, i64) {
        let pool = create_pool("sqlite::memory:", 1).await.expect("pool");
        run_migrations(&pool).await.expect("migrations");
        let (user_id, space_id, channel_id) = (7001, 7002, 7003);
        sqlx::query(
            "INSERT INTO users (id, username, email, password_hash) VALUES ($1,'nu','n@e.com','x')",
        )
        .bind(user_id)
        .execute(&pool)
        .await
        .expect("user");
        sqlx::query("INSERT INTO spaces (id, name, owner_id) VALUES ($1,'S',$2)")
            .bind(space_id)
            .bind(user_id)
            .execute(&pool)
            .await
            .expect("space");
        sqlx::query(
            "INSERT INTO channels (id, space_id, name, channel_type, position) VALUES ($1,$2,'c',0,0)",
        )
        .bind(channel_id)
        .bind(space_id)
        .execute(&pool)
        .await
        .expect("channel");
        (pool, user_id, space_id, channel_id)
    }

    #[tokio::test]
    async fn settings_round_trip_and_clear() {
        let (pool, user, space, channel) = seeded().await;

        assert!(get_space_settings(&pool, user, space)
            .await
            .unwrap()
            .is_none());

        set_space_settings(&pool, user, space, LEVEL_MENTIONS, true, None, true)
            .await
            .unwrap();
        let row = get_space_settings(&pool, user, space)
            .await
            .unwrap()
            .expect("space row");
        assert_eq!(row.level, LEVEL_MENTIONS);
        assert!(row.muted);
        assert!(row.suppress_everyone);
        assert_eq!(row.muted_until, None);

        // Upsert, not a duplicate-key error.
        set_space_settings(&pool, user, space, LEVEL_ALL, false, None, false)
            .await
            .unwrap();
        let row = get_space_settings(&pool, user, space)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(row.level, LEVEL_ALL);
        assert!(!row.muted);
        assert_eq!(list_space_settings(&pool, user).await.unwrap().len(), 1);

        set_channel_settings(&pool, user, channel, LEVEL_NOTHING, true, None, false)
            .await
            .unwrap();
        assert_eq!(list_channel_settings(&pool, user).await.unwrap().len(), 1);

        clear_space_settings(&pool, user, space).await.unwrap();
        clear_channel_settings(&pool, user, channel).await.unwrap();
        assert!(list_space_settings(&pool, user).await.unwrap().is_empty());
        assert!(list_channel_settings(&pool, user).await.unwrap().is_empty());
    }

    /// A temporary mute has to lapse on its own. The row is not swept, so if
    /// `muted_until` were ignored on read a 10-minute mute would be forever.
    #[tokio::test]
    async fn a_timed_mute_lapses_without_being_swept() {
        let (pool, user, space, _) = seeded().await;
        let past = Utc::now() - chrono::Duration::hours(1);
        let future = Utc::now() + chrono::Duration::hours(1);

        set_space_settings(&pool, user, space, LEVEL_ALL, true, Some(past), false)
            .await
            .unwrap();
        let row = get_space_settings(&pool, user, space)
            .await
            .unwrap()
            .unwrap();
        assert!(row.muted, "the stored flag is untouched");
        assert!(
            !row.is_muted_at(Utc::now()),
            "an expired muted_until must not still silence the scope"
        );

        set_space_settings(&pool, user, space, LEVEL_ALL, true, Some(future), false)
            .await
            .unwrap();
        let row = get_space_settings(&pool, user, space)
            .await
            .unwrap()
            .unwrap();
        assert!(
            row.is_muted_at(Utc::now()),
            "a future muted_until still mutes"
        );
    }

    /// Settings are keyed to rows that can be deleted; both scopes carry a real
    /// foreign key so they cascade rather than leaving orphans behind.
    #[tokio::test]
    async fn deleting_the_scope_removes_its_settings() {
        let (pool, user, space, channel) = seeded().await;
        set_space_settings(&pool, user, space, LEVEL_MENTIONS, true, None, false)
            .await
            .unwrap();
        set_channel_settings(&pool, user, channel, LEVEL_MENTIONS, true, None, false)
            .await
            .unwrap();

        sqlx::query("DELETE FROM channels WHERE id = $1")
            .bind(channel)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            list_channel_settings(&pool, user).await.unwrap().is_empty(),
            "deleting a channel must take its notification settings with it"
        );

        sqlx::query("DELETE FROM spaces WHERE id = $1")
            .bind(space)
            .execute(&pool)
            .await
            .unwrap();
        assert!(
            list_space_settings(&pool, user).await.unwrap().is_empty(),
            "deleting a space must take its notification settings with it"
        );
    }
}
