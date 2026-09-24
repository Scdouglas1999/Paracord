//! Daily word add-on: per-server settings, each day's stored answer, and one
//! result per person per day for the whole instance.
//!
//! Booleans are bound as Rust `bool` and read back through `CAST(col AS INTEGER)`
//! plus [`bool_from_any_row`]. Timestamps are TEXT on both engines.

use crate::{bool_from_any_row, datetime_from_db_text, datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyWordSettingsRow {
    pub guild_id: i64,
    pub enabled: bool,
    pub share_channel_id: Option<i64>,
    pub show_on_front_page: bool,
    pub updated_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for DailyWordSettingsRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let updated_at: Option<String> = row.try_get("updated_at")?;
        Ok(Self {
            guild_id: row.try_get("guild_id")?,
            enabled: bool_from_any_row(row, "enabled")?,
            share_channel_id: row.try_get("share_channel_id")?,
            show_on_front_page: bool_from_any_row(row, "show_on_front_page")?,
            updated_at: match updated_at {
                Some(text) => datetime_from_db_text(&text)?,
                None => DateTime::<Utc>::UNIX_EPOCH,
            },
        })
    }
}

const SETTINGS_COLUMNS: &str = "guild_id, CAST(enabled AS INTEGER) AS enabled, share_channel_id, \
     CAST(show_on_front_page AS INTEGER) AS show_on_front_page, updated_at";

pub async fn get_settings(
    pool: &DbPool,
    guild_id: i64,
) -> Result<Option<DailyWordSettingsRow>, DbError> {
    let row = sqlx::query_as::<_, DailyWordSettingsRow>(&format!(
        "SELECT {SETTINGS_COLUMNS} FROM guild_daily_word_settings WHERE guild_id = $1"
    ))
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

pub async fn upsert_settings(
    pool: &DbPool,
    guild_id: i64,
    enabled: bool,
    share_channel_id: Option<i64>,
    show_on_front_page: bool,
) -> Result<DailyWordSettingsRow, DbError> {
    let row = sqlx::query_as::<_, DailyWordSettingsRow>(&format!(
        "INSERT INTO guild_daily_word_settings
            (guild_id, enabled, share_channel_id, show_on_front_page, updated_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (guild_id) DO UPDATE SET
            enabled = EXCLUDED.enabled,
            share_channel_id = EXCLUDED.share_channel_id,
            show_on_front_page = EXCLUDED.show_on_front_page,
            updated_at = EXCLUDED.updated_at
         RETURNING {SETTINGS_COLUMNS}"
    ))
    .bind(guild_id)
    .bind(enabled)
    .bind(share_channel_id)
    .bind(show_on_front_page)
    .bind(datetime_to_db_text(Utc::now()))
    .fetch_one(pool)
    .await?;
    Ok(row)
}

/// Whether `user_id` belongs to at least one server with the add-on turned on.
pub async fn enabled_for_user(pool: &DbPool, user_id: i64) -> Result<bool, DbError> {
    let row = sqlx::query(
        "SELECT COUNT(*) AS n FROM guild_daily_word_settings s \
         JOIN members m ON m.guild_id = s.guild_id \
         WHERE m.user_id = $1 AND s.enabled = $2",
    )
    .bind(user_id)
    .bind(true)
    .fetch_one(pool)
    .await?;
    let count: i64 = row.try_get("n")?;
    Ok(count > 0)
}

/// The stored answer for a puzzle, if the day has been opened.
pub async fn get_answer(pool: &DbPool, puzzle: i64) -> Result<Option<String>, DbError> {
    let row = sqlx::query("SELECT answer FROM daily_word_puzzles WHERE puzzle = $1")
        .bind(puzzle)
        .fetch_optional(pool)
        .await?;
    Ok(match row {
        Some(row) => Some(row.try_get("answer")?),
        None => None,
    })
}

/// Store `answer` for `puzzle` unless one is stored already, and return the
/// stored one. Two servers racing on the first open of a day agree.
pub async fn store_answer(pool: &DbPool, puzzle: i64, answer: &str) -> Result<String, DbError> {
    sqlx::query(
        "INSERT INTO daily_word_puzzles (puzzle, answer, created_at) VALUES ($1, $2, $3) \
         ON CONFLICT (puzzle) DO NOTHING",
    )
    .bind(puzzle)
    .bind(answer)
    .bind(datetime_to_db_text(Utc::now()))
    .execute(pool)
    .await?;
    get_answer(pool, puzzle).await?.ok_or(DbError::NotFound)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DailyWordResultRow {
    pub user_id: i64,
    pub puzzle: i64,
    /// JSON array of the words guessed, in order.
    pub guesses: String,
    pub guess_count: i64,
    pub finished: bool,
    pub solved: bool,
    pub updated_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for DailyWordResultRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let updated_at: String = row.try_get("updated_at")?;
        let finished_at: Option<String> = row.try_get("finished_at")?;
        Ok(Self {
            user_id: row.try_get("user_id")?,
            puzzle: row.try_get("puzzle")?,
            guesses: row.try_get("guesses")?,
            guess_count: row.try_get("guess_count")?,
            finished: bool_from_any_row(row, "finished")?,
            solved: bool_from_any_row(row, "solved")?,
            updated_at: datetime_from_db_text(&updated_at)?,
            finished_at: finished_at
                .as_deref()
                .map(datetime_from_db_text)
                .transpose()?,
        })
    }
}

const RESULT_COLUMNS: &str = "user_id, puzzle, guesses, guess_count, \
     CAST(finished AS INTEGER) AS finished, CAST(solved AS INTEGER) AS solved, \
     updated_at, finished_at";

pub async fn get_result(
    pool: &DbPool,
    user_id: i64,
    puzzle: i64,
) -> Result<Option<DailyWordResultRow>, DbError> {
    let row = sqlx::query_as::<_, DailyWordResultRow>(&format!(
        "SELECT {RESULT_COLUMNS} FROM daily_word_results WHERE user_id = $1 AND puzzle = $2"
    ))
    .bind(user_id)
    .bind(puzzle)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Every day a person has a row for, oldest first.
pub async fn list_results_for_user(
    pool: &DbPool,
    user_id: i64,
) -> Result<Vec<DailyWordResultRow>, DbError> {
    let rows = sqlx::query_as::<_, DailyWordResultRow>(&format!(
        "SELECT {RESULT_COLUMNS} FROM daily_word_results WHERE user_id = $1 ORDER BY puzzle ASC"
    ))
    .bind(user_id)
    .fetch_all(pool)
    .await?;
    Ok(rows)
}

/// Record a guess, but only if the row still holds `expected_count` guesses and
/// is unfinished. Returns false when another guess landed first.
#[allow(clippy::too_many_arguments)]
pub async fn record_guess(
    pool: &DbPool,
    user_id: i64,
    puzzle: i64,
    expected_count: i64,
    guesses: &str,
    guess_count: i64,
    finished: bool,
    solved: bool,
) -> Result<bool, DbError> {
    let now = datetime_to_db_text(Utc::now());
    if expected_count == 0 {
        let result = sqlx::query(
            "INSERT INTO daily_word_results \
                (user_id, puzzle, guesses, guess_count, finished, solved, updated_at, finished_at) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) \
             ON CONFLICT (user_id, puzzle) DO NOTHING",
        )
        .bind(user_id)
        .bind(puzzle)
        .bind(guesses)
        .bind(guess_count)
        .bind(finished)
        .bind(solved)
        .bind(now.as_str())
        .bind(finished.then_some(now.as_str()))
        .execute(pool)
        .await?;
        return Ok(result.rows_affected() > 0);
    }
    let result = sqlx::query(
        "UPDATE daily_word_results \
         SET guesses = $3, guess_count = $4, finished = $5, solved = $6, updated_at = $7, finished_at = $8 \
         WHERE user_id = $1 AND puzzle = $2 AND guess_count = $9 AND finished = $10",
    )
    .bind(user_id)
    .bind(puzzle)
    .bind(guesses)
    .bind(guess_count)
    .bind(finished)
    .bind(solved)
    .bind(now.as_str())
    .bind(finished.then_some(now.as_str()))
    .bind(expected_count)
    .bind(false)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// One member's day on a server's board.
#[derive(Debug, Clone)]
pub struct BoardRow {
    pub result: DailyWordResultRow,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
    pub nick: Option<String>,
}

/// Members of `guild_id` who have made at least one guess on `puzzle`,
/// solvers first (fewest guesses first), then misses, then people still playing.
pub async fn board(pool: &DbPool, guild_id: i64, puzzle: i64) -> Result<Vec<BoardRow>, DbError> {
    let rows = sqlx::query(
        "SELECT r.user_id, r.puzzle, r.guesses, r.guess_count, \
                CAST(r.finished AS INTEGER) AS finished, CAST(r.solved AS INTEGER) AS solved, \
                r.updated_at, r.finished_at, \
                u.username, u.display_name, u.avatar_hash, m.nick \
         FROM daily_word_results r \
         JOIN members m ON m.user_id = r.user_id AND m.guild_id = $1 \
         JOIN users u ON u.id = r.user_id \
         WHERE r.puzzle = $2 AND r.guess_count > 0 \
         ORDER BY CAST(r.solved AS INTEGER) DESC, CAST(r.finished AS INTEGER) DESC, \
                  r.guess_count ASC, r.finished_at ASC, r.user_id ASC",
    )
    .bind(guild_id)
    .bind(puzzle)
    .fetch_all(pool)
    .await?;
    rows.iter()
        .map(|row| {
            Ok(BoardRow {
                result: <DailyWordResultRow as sqlx::FromRow<_>>::from_row(row)?,
                username: row.try_get("username")?,
                display_name: row.try_get("display_name")?,
                avatar_hash: row.try_get("avatar_hash")?,
                nick: row.try_get("nick")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{create_pool, run_migrations};

    #[tokio::test]
    async fn settings_answers_and_guesses_round_trip() {
        let pool = create_pool("sqlite::memory:", 1).await.unwrap();
        run_migrations(&pool).await.unwrap();

        assert_eq!(get_answer(&pool, 5).await.unwrap(), None);
        assert_eq!(store_answer(&pool, 5, "crane").await.unwrap(), "crane");
        // A second store keeps the first answer.
        assert_eq!(store_answer(&pool, 5, "slate").await.unwrap(), "crane");

        let user_id = 42;
        crate::users::create_user(&pool, user_id, "player", 1, "p@example.com", "hash")
            .await
            .unwrap();
        assert!(
            record_guess(&pool, user_id, 5, 0, r#"["slate"]"#, 1, false, false)
                .await
                .unwrap()
        );
        // A stale first guess loses.
        assert!(
            !record_guess(&pool, user_id, 5, 0, r#"["other"]"#, 1, false, false)
                .await
                .unwrap()
        );
        assert!(
            record_guess(&pool, user_id, 5, 1, r#"["slate","crane"]"#, 2, true, true)
                .await
                .unwrap()
        );
        // A finished day takes no more guesses.
        assert!(
            !record_guess(&pool, user_id, 5, 2, r#"["x"]"#, 3, true, false)
                .await
                .unwrap()
        );
        let row = get_result(&pool, user_id, 5).await.unwrap().unwrap();
        assert_eq!(row.guess_count, 2);
        assert!(row.finished && row.solved);
        assert!(row.finished_at.is_some());
        assert_eq!(
            list_results_for_user(&pool, user_id).await.unwrap().len(),
            1
        );
    }
}
