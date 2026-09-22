//! Queries behind the server home's "Latest" feed
//! (`GET /api/v1/guilds/{guild_id}/feed`, docs/server-home-spec.md).
//!
//! The route decides which channels the viewer may read; everything here takes
//! those channel ids as given. Every query is a bounded, batched read so a page
//! costs the same number of round trips whatever it holds.

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::messages::MessageRow;
use crate::{datetime_from_db_text, DbError, DbPool};

/// How many ids one feed query may bind. Past this the query is refused rather
/// than silently dropping channels or threads.
pub const MAX_FEED_BINDS: usize = 20_000;

const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;

const MESSAGE_COLUMNS: &str =
    "m.id, m.channel_id, m.author_id, m.content, m.nonce, m.delivery_nonce, \
     m.message_type, m.flags, m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, \
     m.reference_id, m.e2ee_header, m.created_at, m.embeds, m.components, m.recovery_revision, m.forwarded_from";

/// What makes a message worth a place in the feed. Any one is enough.
pub struct NotableMessages<'a> {
    /// Channels whose messages may appear at all (already permission-filtered).
    pub channel_ids: &'a [i64],
    /// The subset of `channel_ids` that are announcement channels.
    pub announcement_channel_ids: &'a [i64],
    /// Messages that started a thread which then drew enough replies.
    pub thread_starter_ids: &'a [i64],
    /// A message with at least this many reactions (all emoji together).
    pub min_reactions: i64,
    /// Only messages with an id below this.
    pub before: Option<i64>,
    pub limit: i64,
}

fn placeholders(start: usize, count: usize) -> String {
    (0..count)
        .map(|offset| format!("${}", start + offset))
        .collect::<Vec<_>>()
        .join(", ")
}

/// `col IN (...)`, or a false predicate for an empty list (an empty `IN ()` is
/// a syntax error on both engines).
fn in_clause(column: &str, start: usize, count: usize) -> String {
    if count == 0 {
        "1 = 0".to_string()
    } else {
        format!("{column} IN ({})", placeholders(start, count))
    }
}

/// Newest notable messages first. Plain chat never matches.
pub async fn list_notable_messages(
    pool: &DbPool,
    request: &NotableMessages<'_>,
) -> Result<Vec<MessageRow>, DbError> {
    if request.channel_ids.is_empty() {
        return Ok(Vec::new());
    }
    let binds = request.channel_ids.len()
        + request.announcement_channel_ids.len()
        + request.thread_starter_ids.len();
    if binds > MAX_FEED_BINDS {
        return Err(DbError::LimitReached(
            "too many channels and threads for one feed page".to_string(),
        ));
    }

    let mut idx = 1;
    let channels = in_clause("m.channel_id", idx, request.channel_ids.len());
    idx += request.channel_ids.len();
    let announcements = in_clause("m.channel_id", idx, request.announcement_channel_ids.len());
    idx += request.announcement_channel_ids.len();
    let starters = in_clause("m.id", idx, request.thread_starter_ids.len());
    idx += request.thread_starter_ids.len();
    let reactions_idx = idx;
    idx += 1;
    let before = if request.before.is_some() {
        let clause = format!("AND m.id < ${idx}");
        idx += 1;
        clause
    } else {
        String::new()
    };
    let limit_idx = idx;

    let sql = format!(
        "SELECT {MESSAGE_COLUMNS} FROM messages m \
         WHERE {channels} \
           AND (m.flags & {MESSAGE_FLAG_DM_E2EE}) = 0 \
           {before} \
           AND ( {announcements} \
              OR (CASE WHEN m.pinned THEN 1 ELSE 0 END) = 1 \
              OR EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id) \
              OR EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id) \
              OR (SELECT COUNT(*) FROM reactions r WHERE r.message_id = m.id) >= ${reactions_idx} \
              OR {starters} ) \
         ORDER BY m.id DESC LIMIT ${limit_idx}"
    );
    let mut query = sqlx::query_as::<_, MessageRow>(&sql);
    for id in request
        .channel_ids
        .iter()
        .chain(request.announcement_channel_ids)
        .chain(request.thread_starter_ids)
    {
        query = query.bind(*id);
    }
    query = query.bind(request.min_reactions);
    if let Some(before) = request.before {
        query = query.bind(before);
    }
    Ok(query
        .bind(request.limit.clamp(1, 500))
        .fetch_all(pool)
        .await?)
}

/// One message of a forum post, reduced to what the feed card shows.
#[derive(Debug, Clone)]
pub struct ThreadMessage {
    pub id: i64,
    pub channel_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    pub flags: i32,
    pub created_at: DateTime<Utc>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ThreadMessage {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            id: row.try_get("id")?,
            channel_id: row.try_get("channel_id")?,
            author_id: row.try_get("author_id")?,
            content: row.try_get("content")?,
            flags: row.try_get("flags")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
        })
    }
}

fn check_thread_ids(thread_ids: &[i64]) -> Result<(), DbError> {
    if thread_ids.len() > MAX_FEED_BINDS {
        return Err(DbError::LimitReached(
            "too many threads for one feed page".to_string(),
        ));
    }
    Ok(())
}

async fn edge_messages(
    pool: &DbPool,
    thread_ids: &[i64],
    aggregate: &str,
) -> Result<Vec<ThreadMessage>, DbError> {
    if thread_ids.is_empty() {
        return Ok(Vec::new());
    }
    check_thread_ids(thread_ids)?;
    let sql = format!(
        "SELECT m.id, m.channel_id, m.author_id, m.content, m.flags, m.created_at \
         FROM messages m \
         WHERE m.id IN (SELECT {aggregate}(x.id) FROM messages x \
                        WHERE x.channel_id IN ({}) GROUP BY x.channel_id)",
        placeholders(1, thread_ids.len())
    );
    let mut query = sqlx::query_as::<_, ThreadMessage>(&sql);
    for id in thread_ids {
        query = query.bind(*id);
    }
    Ok(query.fetch_all(pool).await?)
}

/// The opening message of each thread (its oldest message).
pub async fn first_thread_messages(
    pool: &DbPool,
    thread_ids: &[i64],
) -> Result<Vec<ThreadMessage>, DbError> {
    edge_messages(pool, thread_ids, "MIN").await
}

/// The newest message of each thread.
pub async fn last_thread_messages(
    pool: &DbPool,
    thread_ids: &[i64],
) -> Result<Vec<ThreadMessage>, DbError> {
    edge_messages(pool, thread_ids, "MAX").await
}

/// Everyone who has written in a thread, with their newest message id there.
#[derive(Debug, Clone, Copy)]
pub struct ThreadParticipant {
    pub thread_id: i64,
    pub author_id: i64,
    pub last_message_id: i64,
}

/// Distinct authors per thread, most recent first within each thread.
pub async fn thread_participants(
    pool: &DbPool,
    thread_ids: &[i64],
) -> Result<Vec<ThreadParticipant>, DbError> {
    if thread_ids.is_empty() {
        return Ok(Vec::new());
    }
    check_thread_ids(thread_ids)?;
    let sql = format!(
        "SELECT m.channel_id AS thread_id, m.author_id, MAX(m.id) AS last_message_id \
         FROM messages m WHERE m.channel_id IN ({}) \
         GROUP BY m.channel_id, m.author_id \
         ORDER BY m.channel_id, MAX(m.id) DESC",
        placeholders(1, thread_ids.len())
    );
    let mut query = sqlx::query(&sql);
    for id in thread_ids {
        query = query.bind(*id);
    }
    let rows = query.fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            Ok(ThreadParticipant {
                thread_id: row.try_get("thread_id")?,
                author_id: row.try_get("author_id")?,
                last_message_id: row.try_get("last_message_id")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// A UTC day on which somebody joined, and how many did.
#[derive(Debug, Clone)]
pub struct JoinDay {
    /// `YYYY-MM-DD`.
    pub day: String,
    pub total: i64,
}

/// The newest join days, newest first. `through_day` (inclusive) bounds the
/// scan for a later page.
pub async fn list_join_days(
    pool: &DbPool,
    guild_id: i64,
    through_day: Option<&str>,
    limit: i64,
) -> Result<Vec<JoinDay>, DbError> {
    let filter = if through_day.is_some() {
        "AND SUBSTR(joined_at, 1, 10) <= $2"
    } else {
        ""
    };
    let limit_idx = if through_day.is_some() { 3 } else { 2 };
    let sql = format!(
        "SELECT SUBSTR(joined_at, 1, 10) AS day, COUNT(*) AS total \
         FROM members WHERE guild_id = $1 {filter} \
         GROUP BY SUBSTR(joined_at, 1, 10) \
         ORDER BY SUBSTR(joined_at, 1, 10) DESC LIMIT ${limit_idx}"
    );
    let mut query = sqlx::query(&sql).bind(guild_id);
    if let Some(day) = through_day {
        query = query.bind(day);
    }
    let rows = query.bind(limit.clamp(1, 500)).fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            Ok(JoinDay {
                day: row.try_get("day")?,
                total: row.try_get("total")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}

/// Somebody who joined on one of the requested days.
#[derive(Debug, Clone)]
pub struct DayJoiner {
    pub day: String,
    pub user_id: i64,
    pub joined_at: DateTime<Utc>,
    pub username: String,
    pub display_name: Option<String>,
    pub avatar_hash: Option<String>,
}

/// The newest `per_day` people to join on each of `days`, newest first.
pub async fn latest_joiners(
    pool: &DbPool,
    guild_id: i64,
    days: &[String],
    per_day: i64,
) -> Result<Vec<DayJoiner>, DbError> {
    if days.is_empty() {
        return Ok(Vec::new());
    }
    if days.len() > 500 {
        return Err(DbError::LimitReached(
            "too many join days for one feed page".to_string(),
        ));
    }
    let per_day_idx = days.len() + 2;
    let sql = format!(
        "SELECT ranked.day, ranked.user_id, ranked.joined_at, ranked.username, \
                ranked.display_name, ranked.avatar_hash \
         FROM (SELECT SUBSTR(m.joined_at, 1, 10) AS day, m.user_id, m.joined_at, \
                      u.username, u.display_name, u.avatar_hash, \
                      ROW_NUMBER() OVER (PARTITION BY SUBSTR(m.joined_at, 1, 10) \
                                         ORDER BY m.joined_at DESC, m.user_id DESC) AS rn \
               FROM members m JOIN users u ON u.id = m.user_id \
               WHERE m.guild_id = $1 AND SUBSTR(m.joined_at, 1, 10) IN ({})) ranked \
         WHERE ranked.rn <= ${per_day_idx} \
         ORDER BY ranked.day DESC, ranked.rn ASC",
        placeholders(2, days.len())
    );
    let mut query = sqlx::query(&sql).bind(guild_id);
    for day in days {
        query = query.bind(day.as_str());
    }
    let rows = query.bind(per_day.clamp(1, 100)).fetch_all(pool).await?;
    rows.iter()
        .map(|row| {
            let joined_at_raw: String = row.try_get("joined_at")?;
            Ok(DayJoiner {
                day: row.try_get("day")?,
                user_id: row.try_get("user_id")?,
                joined_at: datetime_from_db_text(&joined_at_raw)?,
                username: row.try_get("username")?,
                display_name: row.try_get("display_name")?,
                avatar_hash: row.try_get("avatar_hash")?,
            })
        })
        .collect::<Result<Vec<_>, sqlx::Error>>()
        .map_err(DbError::from)
}
