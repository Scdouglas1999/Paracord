//! The newest message of each of a set of channels, for the channel rows of
//! the places panel (`GET /api/v1/guilds/{guild_id}/channel-previews`).
//!
//! The route decides which channels the viewer may read; this module takes
//! those channel ids as given. One query answers up to [`MAX_PREVIEW_CHANNELS`]
//! channels: per channel, the newest message is found with an index seek on
//! `idx_messages_channel_created (channel_id, id DESC)` (an `ORDER BY id DESC
//! LIMIT 1` subquery, which both engines answer from that index), and
//! everything the row needs (author names, webhook/feed/anonymous identity, the
//! first attachment, attachment and sticker counts) is joined or counted
//! through primary keys and existing indexes. No per-channel round trips.
//!
//! The newest message is read from `messages` rather than trusted from
//! `channels.last_message_id`, so a tail that drifted (a message removed by a
//! cascade that did not repair the tail) cannot point a preview at nothing.

use chrono::{DateTime, Utc};
use sqlx::Row;

use crate::{datetime_from_db_text, DbError, DbPool};

/// Channel ids bound per query. Larger inputs are answered in chunks of this
/// size, so a guild of any size costs `ceil(n / 500)` queries.
pub const MAX_PREVIEW_CHANNELS: usize = 500;

/// One channel's newest message, with what its preview row shows.
#[derive(Debug, Clone)]
pub struct ChannelPreviewRow {
    pub channel_id: i64,
    pub message_id: i64,
    pub author_id: i64,
    pub content: Option<String>,
    pub message_type: i16,
    pub flags: i32,
    pub created_at: DateTime<Utc>,
    pub author_username: Option<String>,
    pub author_display_name: Option<String>,
    /// The author's nickname in the guild the previews are for.
    pub author_nick: Option<String>,
    pub webhook_id: Option<i64>,
    pub webhook_name: Option<String>,
    pub feed_id: Option<i64>,
    pub feed_name: Option<String>,
    pub anonymous_alias: Option<String>,
    pub attachment_count: i64,
    pub sticker_count: i64,
    /// The first attachment (lowest id, i.e. first uploaded) of the message.
    pub first_attachment_id: Option<i64>,
    pub first_attachment_filename: Option<String>,
    pub first_attachment_content_type: Option<String>,
    pub first_attachment_width: Option<i32>,
    pub first_attachment_height: Option<i32>,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for ChannelPreviewRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let created_at_raw: String = row.try_get("created_at")?;
        Ok(Self {
            channel_id: row.try_get("channel_id")?,
            message_id: row.try_get("message_id")?,
            author_id: row.try_get("author_id")?,
            content: row.try_get("content")?,
            message_type: row.try_get("message_type")?,
            flags: row.try_get("flags")?,
            created_at: datetime_from_db_text(&created_at_raw)?,
            author_username: row.try_get("author_username")?,
            author_display_name: row.try_get("author_display_name")?,
            author_nick: row.try_get("author_nick")?,
            webhook_id: row.try_get("webhook_id")?,
            webhook_name: row.try_get("webhook_name")?,
            feed_id: row.try_get("feed_id")?,
            feed_name: row.try_get("feed_name")?,
            anonymous_alias: row.try_get("anonymous_alias")?,
            attachment_count: row.try_get("attachment_count")?,
            sticker_count: row.try_get("sticker_count")?,
            first_attachment_id: row.try_get("first_attachment_id")?,
            first_attachment_filename: row.try_get("first_attachment_filename")?,
            first_attachment_content_type: row.try_get("first_attachment_content_type")?,
            first_attachment_width: row.try_get("first_attachment_width")?,
            first_attachment_height: row.try_get("first_attachment_height")?,
        })
    }
}

fn preview_sql(channel_count: usize) -> String {
    // $1 is the guild id; channel ids follow from $2.
    let placeholders = crate::messages::build_placeholders(2, channel_count);
    format!(
        "SELECT
            c.id AS channel_id,
            m.id AS message_id,
            m.author_id,
            m.content,
            m.message_type,
            m.flags,
            m.created_at,
            u.username AS author_username,
            u.display_name AS author_display_name,
            mb.nick AS author_nick,
            w.id AS webhook_id,
            w.name AS webhook_name,
            fm.feed_id AS feed_id,
            fm.name AS feed_name,
            am.alias AS anonymous_alias,
            (SELECT COUNT(*) FROM attachments ac WHERE ac.message_id = m.id) AS attachment_count,
            (SELECT COUNT(*) FROM message_stickers ms WHERE ms.message_id = m.id) AS sticker_count,
            fa.id AS first_attachment_id,
            fa.filename AS first_attachment_filename,
            fa.content_type AS first_attachment_content_type,
            fa.width AS first_attachment_width,
            fa.height AS first_attachment_height
         FROM channels c
         JOIN messages m ON m.id = (
             SELECT x.id FROM messages x
             WHERE x.channel_id = c.id
             ORDER BY x.id DESC
             LIMIT 1
         )
         LEFT JOIN users u ON u.id = m.author_id
         LEFT JOIN members mb ON mb.user_id = m.author_id AND mb.guild_id = $1
         LEFT JOIN webhook_messages wm ON wm.message_id = m.id
         LEFT JOIN webhooks w ON w.id = wm.webhook_id
         LEFT JOIN feed_messages fm ON fm.message_id = m.id
         LEFT JOIN anonymous_messages am ON am.message_id = m.id
         LEFT JOIN attachments fa ON fa.id = (
             SELECT a.id FROM attachments a
             WHERE a.message_id = m.id
             ORDER BY a.id ASC
             LIMIT 1
         )
         WHERE c.space_id = $1 AND c.id IN ({placeholders})
         ORDER BY c.id"
    )
}

/// The newest message of every channel in `channel_ids` that belongs to
/// `guild_id` and has at least one message. Channels without messages (and
/// ids that are not channels of this guild) are absent from the result.
pub async fn latest_messages_for_channels(
    pool: &DbPool,
    guild_id: i64,
    channel_ids: &[i64],
) -> Result<Vec<ChannelPreviewRow>, DbError> {
    let mut rows = Vec::new();
    for chunk in channel_ids.chunks(MAX_PREVIEW_CHANNELS) {
        let sql = preview_sql(chunk.len());
        let mut query = sqlx::query_as::<_, ChannelPreviewRow>(&sql).bind(guild_id);
        for channel_id in chunk {
            query = query.bind(*channel_id);
        }
        rows.extend(query.fetch_all(pool).await?);
    }
    Ok(rows)
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn test_pool() -> DbPool {
        let pool = crate::create_pool("sqlite::memory:", 1).await.unwrap();
        crate::run_migrations(&pool).await.unwrap();
        pool
    }

    /// The per-channel seek must come from an index, never a scan of
    /// `messages`: that is what keeps this one query cheap on a big server.
    #[tokio::test]
    async fn sqlite_plan_seeks_the_newest_message_through_an_index() {
        let pool = test_pool().await;
        let sql = format!("EXPLAIN QUERY PLAN {}", preview_sql(3));
        let rows = sqlx::query(&sql)
            .bind(1_i64)
            .bind(10_i64)
            .bind(11_i64)
            .bind(12_i64)
            .fetch_all(&pool)
            .await
            .unwrap();
        let details: Vec<String> = rows
            .iter()
            .map(|row| row.try_get::<String, _>("detail").unwrap())
            .collect();
        let plan = details.join("\n");
        for detail in &details {
            let table_scan = detail.starts_with("SCAN ") && !detail.contains(" USING ");
            assert!(!table_scan, "full scan in preview plan:\n{plan}");
        }
        assert!(
            plan.contains("idx_messages_channel_created"),
            "newest-message seek does not use idx_messages_channel_created:\n{plan}"
        );
    }

    #[tokio::test]
    async fn empty_input_runs_no_query_and_returns_nothing() {
        let pool = test_pool().await;
        let rows = latest_messages_for_channels(&pool, 1, &[]).await.unwrap();
        assert!(rows.is_empty());
    }
}
