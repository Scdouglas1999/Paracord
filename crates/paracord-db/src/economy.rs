use crate::{
    active_database_engine, datetime_from_db_text, datetime_to_db_text, DatabaseEngine, DbError,
    DbPool,
};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use sqlx::Row;
use std::collections::HashSet;

#[derive(Debug, Clone)]
pub struct UserXpRow {
    pub user_id: i64,
    pub guild_id: i64,
    pub xp: i64,
    pub level: i32,
    pub last_xp_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserXpRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let last_xp_at_raw: String = row.try_get("last_xp_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            guild_id: row.try_get("guild_id")?,
            xp: row.try_get("xp")?,
            level: row.try_get("level")?,
            last_xp_at: datetime_from_db_text(&last_xp_at_raw)?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct GuildLevelRoleRow {
    pub guild_id: i64,
    pub level: i32,
    pub role_id: i64,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for GuildLevelRoleRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            level: row.try_get("level")?,
            role_id: row.try_get("role_id")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct UserActivityStreakRow {
    pub user_id: i64,
    pub guild_id: i64,
    pub streak_days: i32,
    pub longest_streak_days: i32,
    pub last_active_date: NaiveDate,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserActivityStreakRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let last_active_raw: String = row.try_get("last_active_date")?;
        let updated_at_raw: String = row.try_get("updated_at")?;
        let last_active_date =
            NaiveDate::parse_from_str(&last_active_raw, "%Y-%m-%d").map_err(|err| {
                sqlx::Error::Protocol(format!("invalid date '{}': {err}", last_active_raw))
            })?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            guild_id: row.try_get("guild_id")?,
            streak_days: row.try_get("streak_days")?,
            longest_streak_days: row.try_get("longest_streak_days")?,
            last_active_date,
            updated_at: datetime_from_db_text(&updated_at_raw)?,
        })
    }
}

#[derive(Debug, Clone)]
pub struct UserAchievementRow {
    pub user_id: i64,
    pub guild_id: i64,
    pub achievement_key: String,
    pub awarded_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for UserAchievementRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let awarded_at_raw: String = row.try_get("awarded_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            guild_id: row.try_get("guild_id")?,
            achievement_key: row.try_get("achievement_key")?,
            awarded_at: datetime_from_db_text(&awarded_at_raw)?,
        })
    }
}

/// Compute the expected level from total XP.
/// Formula: level = floor(sqrt(xp / 100))
pub fn level_for_xp(xp: i64) -> i32 {
    ((xp as f64 / 100.0).sqrt()).floor() as i32
}

fn user_xp_projection() -> &'static str {
    match active_database_engine() {
        DatabaseEngine::Postgres => {
            "user_id, guild_id, xp, level, to_char(last_xp_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') AS last_xp_at"
        }
        DatabaseEngine::Sqlite => "user_id, guild_id, xp, level, last_xp_at",
    }
}

fn user_xp_timestamp_parameter(position: usize) -> String {
    match active_database_engine() {
        DatabaseEngine::Postgres => format!("${position}::timestamptz"),
        DatabaseEngine::Sqlite => format!("${position}"),
    }
}

/// Get a user's XP record in a guild.
pub async fn get_user_xp(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Option<UserXpRow>, DbError> {
    let sql = format!(
        "SELECT {} FROM user_xp WHERE user_id = $1 AND guild_id = $2",
        user_xp_projection()
    );
    let row = sqlx::query_as::<_, UserXpRow>(&sql)
        .bind(user_id)
        .bind(guild_id)
        .fetch_optional(pool)
        .await?;
    Ok(row)
}

/// Add XP to a user, returning (new_row, leveled_up).
pub async fn add_xp(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    amount: i64,
) -> Result<(UserXpRow, bool), DbError> {
    if amount < 0 {
        return Err(DbError::Sqlx(sqlx::Error::Protocol(
            "amount must be non-negative".to_string(),
        )));
    }

    let now = datetime_to_db_text(Utc::now());

    let last_xp_at_param = user_xp_timestamp_parameter(4);
    let sql = format!(
        "INSERT INTO user_xp (user_id, guild_id, xp, level, last_xp_at)
         VALUES ($1, $2, $3, 0, {last_xp_at_param})
         ON CONFLICT (user_id, guild_id)
         DO UPDATE SET xp = user_xp.xp + $3, last_xp_at = {last_xp_at_param}
         RETURNING {}",
        user_xp_projection()
    );
    let row = sqlx::query_as::<_, UserXpRow>(&sql)
        .bind(user_id)
        .bind(guild_id)
        .bind(amount)
        .bind(&now)
        .fetch_one(pool)
        .await?;

    let new_level = level_for_xp(row.xp);
    let leveled_up = new_level > row.level;

    if new_level != row.level {
        sqlx::query("UPDATE user_xp SET level = $3 WHERE user_id = $1 AND guild_id = $2")
            .bind(user_id)
            .bind(guild_id)
            .bind(new_level)
            .execute(pool)
            .await?;
    }

    let final_row = UserXpRow {
        level: new_level,
        ..row
    };

    Ok((final_row, leveled_up))
}

/// Get the leaderboard for a guild, ordered by XP descending.
pub async fn get_leaderboard(
    pool: &DbPool,
    guild_id: i64,
    limit: i64,
) -> Result<Vec<UserXpRow>, DbError> {
    let sql = format!(
        "SELECT {} FROM user_xp
         WHERE guild_id = $1
         ORDER BY xp DESC, user_id ASC
         LIMIT $2",
        user_xp_projection()
    );
    let rows = sqlx::query_as::<_, UserXpRow>(&sql)
        .bind(guild_id)
        .bind(limit)
        .fetch_all(pool)
        .await?;
    Ok(rows)
}

/// Get a 1-based rank for a user in a guild leaderboard.
pub async fn get_user_rank(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Option<i64>, DbError> {
    let user_xp: Option<i64> =
        sqlx::query_scalar("SELECT xp FROM user_xp WHERE user_id = $1 AND guild_id = $2")
            .bind(user_id)
            .bind(guild_id)
            .fetch_optional(pool)
            .await?;

    let Some(user_xp) = user_xp else {
        return Ok(None);
    };

    let rank: i64 =
        sqlx::query_scalar("SELECT 1 + COUNT(*) FROM user_xp WHERE guild_id = $1 AND xp > $2")
            .bind(guild_id)
            .bind(user_xp)
            .fetch_one(pool)
            .await?;

    Ok(Some(rank))
}

pub async fn list_level_roles(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Vec<GuildLevelRoleRow>, DbError> {
    let rows = sqlx::query_as::<_, GuildLevelRoleRow>(
        "SELECT guild_id, level, role_id, created_at
         FROM guild_level_roles
         WHERE guild_id = $1
         ORDER BY level ASC, role_id ASC",
    )
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn list_eligible_level_roles(
    pool: &DbPool,
    guild_id: i64,
    level: i32,
) -> Result<Vec<GuildLevelRoleRow>, DbError> {
    let rows = sqlx::query_as::<_, GuildLevelRoleRow>(
        "SELECT guild_id, level, role_id, created_at
         FROM guild_level_roles
         WHERE guild_id = $1 AND level <= $2
         ORDER BY level ASC, role_id ASC",
    )
    .bind(guild_id)
    .bind(level)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn replace_level_roles(
    pool: &DbPool,
    guild_id: i64,
    mappings: &[(i32, i64)],
) -> Result<(), DbError> {
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM guild_level_roles WHERE guild_id = $1")
        .bind(guild_id)
        .execute(&mut *tx)
        .await?;

    let mut unique = HashSet::new();
    for (level, role_id) in mappings {
        if *level < 0 {
            return Err(DbError::Sqlx(sqlx::Error::Protocol(
                "level must be non-negative".to_string(),
            )));
        }
        if *role_id <= 0 {
            return Err(DbError::Sqlx(sqlx::Error::Protocol(
                "role_id must be positive".to_string(),
            )));
        }
        if !unique.insert((*level, *role_id)) {
            continue;
        }

        sqlx::query(
            "INSERT INTO guild_level_roles (guild_id, level, role_id)
             VALUES ($1, $2, $3)",
        )
        .bind(guild_id)
        .bind(*level)
        .bind(*role_id)
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(())
}

pub async fn get_user_activity_streak(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Option<UserActivityStreakRow>, DbError> {
    let row = sqlx::query_as::<_, UserActivityStreakRow>(
        "SELECT user_id, guild_id, streak_days, longest_streak_days, last_active_date, updated_at
         FROM user_activity_streaks
         WHERE user_id = $1 AND guild_id = $2",
    )
    .bind(user_id)
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_user_activity_streak(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    active_date: NaiveDate,
) -> Result<UserActivityStreakRow, DbError> {
    let existing = get_user_activity_streak(pool, user_id, guild_id).await?;
    let today = active_date.format("%Y-%m-%d").to_string();
    let now = datetime_to_db_text(Utc::now());

    match existing {
        Some(current) if current.last_active_date == active_date => Ok(current),
        Some(current) => {
            let expected_next = current.last_active_date + Duration::days(1);
            let new_streak = if expected_next == active_date {
                current.streak_days + 1
            } else {
                1
            };
            let longest = current.longest_streak_days.max(new_streak);

            sqlx::query(
                "UPDATE user_activity_streaks
                 SET streak_days = $3,
                     longest_streak_days = $4,
                     last_active_date = $5,
                     updated_at = $6
                 WHERE user_id = $1 AND guild_id = $2",
            )
            .bind(user_id)
            .bind(guild_id)
            .bind(new_streak)
            .bind(longest)
            .bind(&today)
            .bind(&now)
            .execute(pool)
            .await?;

            let updated = get_user_activity_streak(pool, user_id, guild_id)
                .await?
                .ok_or(DbError::NotFound)?;
            Ok(updated)
        }
        None => {
            sqlx::query(
                "INSERT INTO user_activity_streaks
                    (user_id, guild_id, streak_days, longest_streak_days, last_active_date, updated_at)
                 VALUES ($1, $2, 1, 1, $3, $4)",
            )
            .bind(user_id)
            .bind(guild_id)
            .bind(&today)
            .bind(&now)
            .execute(pool)
            .await?;

            let inserted = get_user_activity_streak(pool, user_id, guild_id)
                .await?
                .ok_or(DbError::NotFound)?;
            Ok(inserted)
        }
    }
}

pub async fn list_user_achievements(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
) -> Result<Vec<UserAchievementRow>, DbError> {
    let rows = sqlx::query_as::<_, UserAchievementRow>(
        "SELECT user_id, guild_id, achievement_key, awarded_at
         FROM user_achievements
         WHERE user_id = $1 AND guild_id = $2
         ORDER BY awarded_at ASC, achievement_key ASC",
    )
    .bind(user_id)
    .bind(guild_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

pub async fn grant_achievement_if_missing(
    pool: &DbPool,
    user_id: i64,
    guild_id: i64,
    achievement_key: &str,
) -> Result<bool, DbError> {
    let now = datetime_to_db_text(Utc::now());
    let result = sqlx::query(
        "INSERT INTO user_achievements (user_id, guild_id, achievement_key, awarded_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id, guild_id, achievement_key) DO NOTHING",
    )
    .bind(user_id)
    .bind(guild_id)
    .bind(achievement_key)
    .bind(&now)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}
