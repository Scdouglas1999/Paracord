//! Shared message search for one channel and for a whole server.
//!
//! Channel search and guild search both build their SQL here. The channel
//! route asks for relevance order; the guild route asks for newest first and
//! may omit the text query when a filter is set.

use crate::messages::MessageRow;
use crate::{datetime_to_db_text, DbError, DbPool};
use chrono::{DateTime, Utc};
use paracord_models::id::{ChannelId, UserId};

/// How many channels one search may name. Callers that need fewer (forum
/// search) truncate first. Past this, the query is refused instead of silently
/// dropping channels.
pub const MAX_SEARCH_CHANNELS: usize = 2_000;

const MESSAGE_FLAG_DM_E2EE: i32 = 1 << 0;

const SEARCH_COLUMNS: &str =
    "m.id, m.channel_id, m.author_id, m.content, m.nonce, m.delivery_nonce, \
     m.message_type, m.flags, m.edited_at, CASE WHEN m.pinned THEN 1 ELSE 0 END AS pinned, \
     m.reference_id, m.e2ee_header, m.created_at, m.embeds, m.components, m.recovery_revision, m.forwarded_from";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageSearchOrder {
    /// `ts_rank` / FTS rank. Channel search keeps this.
    Relevance,
    /// `created_at` descending, then id. Guild search uses this.
    Newest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageHas {
    Link,
    Image,
    Video,
    File,
    Poll,
    Embed,
}

pub struct MessageSearch<'a> {
    pub channel_ids: &'a [ChannelId],
    /// Trimmed text. Empty skips the full-text predicate.
    pub query: Option<&'a str>,
    pub author_id: Option<UserId>,
    pub after: Option<DateTime<Utc>>,
    pub before: Option<DateTime<Utc>>,
    /// `Some(true)` is pinned only, `Some(false)` is unpinned only.
    pub pinned: Option<bool>,
    pub mentions_user_id: Option<UserId>,
    pub has: &'a [MessageHas],
    pub limit: i64,
    pub offset: i64,
    pub order: MessageSearchOrder,
}

pub struct MessageSearchPage {
    pub total: i64,
    pub messages: Vec<MessageRow>,
}

#[derive(Clone, Copy)]
enum TextPath {
    /// No text predicate. Same SQL on both engines.
    FiltersOnly,
    Postgres,
    SqliteFts,
    SqliteLike,
}

struct Binds<'a> {
    channels: &'a [ChannelId],
    text: Option<&'a str>,
    author_id: Option<UserId>,
    after: Option<&'a str>,
    before: Option<&'a str>,
    /// 1, 0, or NULL. Compared with `CASE WHEN pinned THEN 1 ELSE 0 END`, so
    /// both engines see an integer on each side.
    pinned: Option<i32>,
    /// The mentioned user's id as text, matched against the `<@id>` and
    /// `<@!id>` tokens in the message body. The body is the source of truth
    /// for a direct mention; `message_mentions` also holds everyone who was
    /// reached through `@everyone` or a role, which is not what `mentions:`
    /// asks for.
    mentions: Option<String>,
    limit: i64,
    offset: i64,
}

pub async fn search_messages_page(
    pool: &DbPool,
    request: &MessageSearch<'_>,
) -> Result<MessageSearchPage, DbError> {
    if request.channel_ids.is_empty() {
        return Ok(MessageSearchPage {
            total: 0,
            messages: Vec::new(),
        });
    }
    if request.channel_ids.len() > MAX_SEARCH_CHANNELS {
        return Err(DbError::LimitReached(
            "too many channels to search".to_string(),
        ));
    }

    let limit = request.limit.clamp(1, 500);
    let offset = request.offset.max(0);
    let text = request
        .query
        .map(str::trim)
        .filter(|query| !query.is_empty());
    let after_text = request.after.map(datetime_to_db_text);
    let before_text = request.before.map(datetime_to_db_text);
    let pinned = request.pinned.map(i32::from);

    if text.is_none() {
        return execute(
            pool,
            request,
            TextPath::FiltersOnly,
            None,
            &after_text,
            &before_text,
            pinned,
            limit,
            offset,
        )
        .await;
    }
    let text = text.unwrap();

    match crate::active_database_engine() {
        crate::DatabaseEngine::Postgres => {
            execute(
                pool,
                request,
                TextPath::Postgres,
                Some(text),
                &after_text,
                &before_text,
                pinned,
                limit,
                offset,
            )
            .await
        }
        crate::DatabaseEngine::Sqlite => {
            let fts_query = sanitize_fts5_query(text);
            let fts_result = execute(
                pool,
                request,
                TextPath::SqliteFts,
                Some(&fts_query),
                &after_text,
                &before_text,
                pinned,
                limit,
                offset,
            )
            .await;
            match fts_result {
                Err(DbError::Sqlx(err)) if is_unusable_fts_index(&err) => {
                    tracing::warn!(
                        error = %err,
                        "messages_fts unavailable; falling back to LIKE search"
                    );
                    execute(
                        pool,
                        request,
                        TextPath::SqliteLike,
                        Some(text),
                        &after_text,
                        &before_text,
                        pinned,
                        limit,
                        offset,
                    )
                    .await
                }
                other => other,
            }
        }
    }
}

async fn execute(
    pool: &DbPool,
    request: &MessageSearch<'_>,
    path: TextPath,
    text: Option<&str>,
    after_text: &Option<String>,
    before_text: &Option<String>,
    pinned: Option<i32>,
    limit: i64,
    offset: i64,
) -> Result<MessageSearchPage, DbError> {
    let like_pattern = match path {
        TextPath::SqliteLike => Some(like_pattern(text.unwrap_or_default())),
        _ => None,
    };
    let bound_text = match path {
        TextPath::SqliteLike => like_pattern.as_deref(),
        _ => text,
    };
    let binds = Binds {
        channels: request.channel_ids,
        text: bound_text,
        author_id: request.author_id,
        after: after_text.as_deref(),
        before: before_text.as_deref(),
        pinned,
        mentions: request.mentions_user_id.map(|id| id.get().to_string()),
        limit,
        offset,
    };
    let (page_sql, count_sql) = sql_pair(path, request.has, request.order, &binds);

    let (total,) = bind_query(sqlx::query_as::<_, (i64,)>(&count_sql), &binds, false)
        .fetch_one(pool)
        .await?;
    let messages = bind_query(sqlx::query_as::<_, MessageRow>(&page_sql), &binds, true)
        .fetch_all(pool)
        .await?;
    Ok(MessageSearchPage { total, messages })
}

fn sql_pair(
    path: TextPath,
    has: &[MessageHas],
    order: MessageSearchOrder,
    binds: &Binds<'_>,
) -> (String, String) {
    let n = binds.channels.len();
    let in_list = build_placeholders(1, n);
    let mut idx = n as i32;
    let text_idx = if binds.text.is_some() {
        idx += 1;
        Some(idx)
    } else {
        None
    };
    idx += 1;
    let author_idx = idx;
    idx += 1;
    let after_idx = idx;
    idx += 1;
    let before_idx = idx;
    idx += 1;
    let pinned_idx = idx;
    idx += 1;
    let mentions_idx = idx;
    idx += 1;
    let limit_idx = idx;
    idx += 1;
    let offset_idx = idx;

    let from = match path {
        TextPath::FiltersOnly => {
            format!("FROM messages m WHERE m.channel_id IN ({in_list})")
        }
        TextPath::Postgres => {
            let text_idx = text_idx.expect("postgres text search binds a query");
            format!(
                "FROM messages m WHERE m.channel_id IN ({in_list}) \
                 AND m.search_vector @@ plainto_tsquery('english', ${text_idx})"
            )
        }
        TextPath::SqliteFts => {
            let text_idx = text_idx.expect("sqlite text search binds a query");
            format!(
                "FROM messages m \
                 JOIN messages_fts ON messages_fts.rowid = m.id \
                 WHERE messages_fts MATCH ${text_idx} \
                   AND m.channel_id IN ({in_list})"
            )
        }
        TextPath::SqliteLike => {
            let text_idx = text_idx.expect("like search binds a pattern");
            format!(
                "FROM messages m WHERE m.channel_id IN ({in_list}) \
                 AND COALESCE(m.content, '') LIKE ${text_idx} ESCAPE '\\'"
            )
        }
    };
    let filters = format!(
        "AND (${author_idx} IS NULL OR (m.author_id = ${author_idx} \
              AND NOT EXISTS (SELECT 1 FROM anonymous_messages am WHERE am.message_id = m.id) \
              AND NOT EXISTS (SELECT 1 FROM webhook_messages wm WHERE wm.message_id = m.id))) \
         AND (${after_idx} IS NULL OR m.created_at >= ${after_idx}) \
         AND (${before_idx} IS NULL OR m.created_at <= ${before_idx}) \
         AND (${pinned_idx} IS NULL OR (CASE WHEN m.pinned THEN 1 ELSE 0 END) = ${pinned_idx}) \
         AND (${mentions_idx} IS NULL \
              OR COALESCE(m.content, '') LIKE '%<@' || ${mentions_idx} || '>%' \
              OR COALESCE(m.content, '') LIKE '%<@!' || ${mentions_idx} || '>%') \
         AND (m.flags & {MESSAGE_FLAG_DM_E2EE}) = 0 \
         {}",
        has_clause(has)
    );
    let order_sql = order_clause(order, path, text_idx);
    let page_sql = format!(
        "SELECT {SEARCH_COLUMNS} {from} {filters} {order_sql} LIMIT ${limit_idx} OFFSET ${offset_idx}"
    );
    let count_sql = format!("SELECT COUNT(*) {from} {filters}");
    (page_sql, count_sql)
}

fn order_clause(order: MessageSearchOrder, path: TextPath, text_idx: Option<i32>) -> String {
    match order {
        MessageSearchOrder::Newest => "ORDER BY m.created_at DESC, m.id DESC".to_string(),
        MessageSearchOrder::Relevance => match path {
            TextPath::Postgres => {
                let text_idx = text_idx.expect("relevance rank needs the text query");
                format!(
                    "ORDER BY ts_rank(m.search_vector, plainto_tsquery('english', ${text_idx})) DESC, m.id DESC"
                )
            }
            TextPath::SqliteFts => "ORDER BY rank, m.id DESC".to_string(),
            TextPath::SqliteLike | TextPath::FiltersOnly => "ORDER BY m.id DESC".to_string(),
        },
    }
}

fn has_clause(has: &[MessageHas]) -> String {
    let mut sql = String::new();
    for kind in has {
        sql.push_str(" AND ");
        sql.push_str(match kind {
            MessageHas::Link => {
                "(LOWER(COALESCE(m.content, '')) LIKE '%http://%' \
                 OR LOWER(COALESCE(m.content, '')) LIKE '%https://%')"
            }
            MessageHas::Image => {
                "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id \
                 AND LOWER(COALESCE(a.content_type, '')) LIKE 'image/%')"
            }
            MessageHas::Video => {
                "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id \
                 AND LOWER(COALESCE(a.content_type, '')) LIKE 'video/%')"
            }
            MessageHas::File => {
                "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id \
                 AND LOWER(COALESCE(a.content_type, '')) NOT LIKE 'image/%' \
                 AND LOWER(COALESCE(a.content_type, '')) NOT LIKE 'video/%')"
            }
            MessageHas::Poll => "EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id)",
            MessageHas::Embed => {
                "((m.embeds IS NOT NULL AND TRIM(m.embeds) NOT IN ('', '[]', 'null')) \
                 OR EXISTS (SELECT 1 FROM message_embeds e WHERE e.message_id = m.id))"
            }
        });
    }
    sql
}

fn bind_query<'a, T>(
    query: sqlx::query::QueryAs<'a, sqlx::Any, T, sqlx::any::AnyArguments<'a>>,
    binds: &'a Binds<'a>,
    with_page: bool,
) -> sqlx::query::QueryAs<'a, sqlx::Any, T, sqlx::any::AnyArguments<'a>>
where
    T: for<'r> sqlx::FromRow<'r, sqlx::any::AnyRow>,
{
    let mut query = query;
    for id in binds.channels {
        query = query.bind(*id);
    }
    if let Some(text) = binds.text {
        query = query.bind(text);
    }
    query = query
        .bind(binds.author_id)
        .bind(binds.after)
        .bind(binds.before)
        .bind(binds.pinned)
        .bind(binds.mentions.as_deref());
    if with_page {
        query = query.bind(binds.limit).bind(binds.offset);
    }
    query
}

fn build_placeholders(start: usize, count: usize) -> String {
    (0..count)
        .map(|offset| format!("${}", start + offset))
        .collect::<Vec<_>>()
        .join(", ")
}

fn like_pattern(query: &str) -> String {
    let escaped = query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

/// Wrap each word in quotes so FTS5 punctuation cannot change the query.
fn sanitize_fts5_query(input: &str) -> String {
    input
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .map(|word| {
            let escaped = word.replace('"', "\"\"");
            format!("\"{escaped}\"")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_unusable_fts_index(err: &sqlx::Error) -> bool {
    matches!(err, sqlx::Error::Database(db) if {
        let msg = db.message().to_ascii_lowercase();
        (msg.contains("messages_fts")
            && (msg.contains("no such table")
                || msg.contains("no such column")
                || msg.contains("no such module")
                || msg.contains("malformed")
                || msg.contains("corrupt")))
            || msg.contains("unable to use function match")
    })
}
