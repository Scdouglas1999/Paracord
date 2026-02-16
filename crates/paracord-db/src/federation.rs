use crate::{bool_from_any_row, json_from_db_text, DbPool};
use serde_json::Value;
use sqlx::Row;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct FederatedServerRow {
    pub id: i64,
    pub server_name: String,
    pub domain: String,
    pub federation_endpoint: String,
    pub public_key_hex: Option<String>,
    pub key_id: Option<String>,
    pub trusted: bool,
    pub last_seen_at: Option<String>,
    pub created_at: String,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for FederatedServerRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        Ok(Self {
            id: row.try_get("id")?,
            server_name: row.try_get("server_name")?,
            domain: row.try_get("domain")?,
            federation_endpoint: row.try_get("federation_endpoint")?,
            public_key_hex: row.try_get("public_key_hex")?,
            key_id: row.try_get("key_id")?,
            trusted: bool_from_any_row(row, "trusted")?,
            last_seen_at: row.try_get("last_seen_at")?,
            created_at: row.try_get("created_at")?,
        })
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ServerKeypairRow {
    pub id: i64,
    pub key_id: String,
    pub signing_key_hex: String,
    pub public_key_hex: String,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct OutboundFederationEventRow {
    pub id: i64,
    pub destination_server: String,
    pub federation_endpoint: String,
    pub event_id: String,
    pub room_id: String,
    pub event_type: String,
    pub sender: String,
    pub origin_server: String,
    pub origin_ts: i64,
    pub content: Value,
    pub depth: i64,
    pub state_key: Option<String>,
    pub signatures: Value,
    pub attempt_count: i64,
}

impl<'r> sqlx::FromRow<'r, sqlx::any::AnyRow> for OutboundFederationEventRow {
    fn from_row(row: &'r sqlx::any::AnyRow) -> Result<Self, sqlx::Error> {
        let content_raw: String = row.try_get("content")?;
        let signatures_raw: String = row.try_get("signatures")?;
        Ok(Self {
            id: row.try_get("id")?,
            destination_server: row.try_get("destination_server")?,
            federation_endpoint: row.try_get("federation_endpoint")?,
            event_id: row.try_get("event_id")?,
            room_id: row.try_get("room_id")?,
            event_type: row.try_get("event_type")?,
            sender: row.try_get("sender")?,
            origin_server: row.try_get("origin_server")?,
            origin_ts: row.try_get("origin_ts")?,
            content: json_from_db_text(&content_raw)?,
            depth: row.try_get("depth")?,
            state_key: row.try_get("state_key")?,
            signatures: json_from_db_text(&signatures_raw)?,
            attempt_count: row.try_get("attempt_count")?,
        })
    }
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct RemoteFederatedUserRow {
    pub remote_user_id: String,
    pub origin_server: String,
    pub local_user_id: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FederatedSpaceMapRow {
    pub origin_server: String,
    pub remote_space_id: String,
    pub local_guild_id: i64,
    pub created_at: String,
}

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct FederatedChannelMapRow {
    pub origin_server: String,
    pub remote_channel_id: String,
    pub local_channel_id: i64,
    pub local_guild_id: i64,
    pub created_at: String,
}

/// Insert or update a known federated server.
pub async fn upsert_federated_server(
    pool: &DbPool,
    id: i64,
    server_name: &str,
    domain: &str,
    federation_endpoint: &str,
    public_key_hex: Option<&str>,
    key_id: Option<&str>,
    trusted: bool,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federated_servers (id, server_name, domain, federation_endpoint, public_key_hex, key_id, trusted)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (server_name) DO UPDATE SET
             domain = EXCLUDED.domain,
             federation_endpoint = EXCLUDED.federation_endpoint,
             public_key_hex = COALESCE(EXCLUDED.public_key_hex, federated_servers.public_key_hex),
             key_id = COALESCE(EXCLUDED.key_id, federated_servers.key_id),
             trusted = EXCLUDED.trusted",
    )
    .bind(id)
    .bind(server_name)
    .bind(domain)
    .bind(federation_endpoint)
    .bind(public_key_hex)
    .bind(key_id)
    .bind(trusted)
    .execute(pool)
    .await?;
    Ok(())
}

/// Get a federated server by its server_name.
pub async fn get_federated_server(
    pool: &DbPool,
    server_name: &str,
) -> Result<Option<FederatedServerRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedServerRow>(
        "SELECT id, server_name, domain, federation_endpoint, public_key_hex, key_id, trusted, last_seen_at, created_at
         FROM federated_servers WHERE server_name = $1",
    )
    .bind(server_name)
    .fetch_optional(pool)
    .await
}

/// Get a federated server by its ID.
pub async fn get_federated_server_by_id(
    pool: &DbPool,
    id: i64,
) -> Result<Option<FederatedServerRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedServerRow>(
        "SELECT id, server_name, domain, federation_endpoint, public_key_hex, key_id, trusted, last_seen_at, created_at
         FROM federated_servers WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
}

/// List all known federated servers.
pub async fn list_federated_servers(pool: &DbPool) -> Result<Vec<FederatedServerRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedServerRow>(
        "SELECT id, server_name, domain, federation_endpoint, public_key_hex, key_id, trusted, last_seen_at, created_at
         FROM federated_servers ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await
}

/// List only trusted federated servers.
pub async fn list_trusted_federated_servers(
    pool: &DbPool,
) -> Result<Vec<FederatedServerRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedServerRow>(
        "SELECT id, server_name, domain, federation_endpoint, public_key_hex, key_id, trusted, last_seen_at, created_at
         FROM federated_servers WHERE trusted = TRUE ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await
}

/// Delete a federated server by server_name.
pub async fn delete_federated_server(
    pool: &DbPool,
    server_name: &str,
) -> Result<bool, sqlx::Error> {
    let result = sqlx::query("DELETE FROM federated_servers WHERE server_name = $1")
        .bind(server_name)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Update the last_seen_at timestamp for a federated server.
pub async fn touch_federated_server(pool: &DbPool, server_name: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE federated_servers SET last_seen_at = datetime('now') WHERE server_name = $1",
    )
    .bind(server_name)
    .execute(pool)
    .await?;
    Ok(())
}

/// Return true if a server is trusted and not blocked/quarantined.
pub async fn is_federated_server_trusted(
    pool: &DbPool,
    server_name: &str,
    now_ms: i64,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1
         FROM federated_servers fs
         LEFT JOIN federation_peer_trust_state pts
           ON pts.server_name = fs.server_name
         WHERE fs.server_name = $1
           AND fs.trusted = TRUE
           AND COALESCE(pts.mode, 'allow') != 'block'
           AND NOT (
               COALESCE(pts.mode, 'allow') = 'quarantine'
               AND COALESCE(pts.quarantined_until_ms, 0) > $2
           )
         LIMIT 1",
    )
    .bind(server_name)
    .bind(now_ms)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

/// Insert a replay key. Returns true if inserted, false when already seen.
pub async fn insert_transport_replay_key(
    pool: &DbPool,
    origin_server: &str,
    signature_hash: &str,
    request_ts: i64,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(
        "INSERT INTO federation_transport_replay_cache (origin_server, signature_hash, request_ts)
         VALUES ($1, $2, $3)
         ON CONFLICT (origin_server, signature_hash) DO NOTHING",
    )
    .bind(origin_server)
    .bind(signature_hash)
    .bind(request_ts)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows > 0)
}

pub async fn prune_transport_replay_cache(
    pool: &DbPool,
    older_than_ms: i64,
) -> Result<u64, sqlx::Error> {
    let rows = sqlx::query(
        "DELETE FROM federation_transport_replay_cache
         WHERE created_at_ms < $1",
    )
    .bind(older_than_ms)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows)
}

pub async fn enqueue_outbound_event(
    pool: &DbPool,
    destination_server: &str,
    event_id: &str,
    room_id: &str,
    event_type: &str,
    sender: &str,
    origin_server: &str,
    origin_ts: i64,
    content: &Value,
    depth: i64,
    state_key: Option<&str>,
    signatures: &Value,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_outbound_queue (
             destination_server, event_id, room_id, event_type, sender, origin_server, origin_ts,
             content, depth, state_key, signatures, attempt_count, next_attempt_at_ms, last_error,
             created_at_ms, updated_at_ms
         ) VALUES (
             $1, $2, $3, $4, $5, $6, $7,
             $8, $9, $10, $11, 0, $12, NULL,
             $12, $12
         )
         ON CONFLICT (destination_server, event_id) DO UPDATE SET
             next_attempt_at_ms = CASE WHEN federation_outbound_queue.next_attempt_at_ms < EXCLUDED.next_attempt_at_ms THEN federation_outbound_queue.next_attempt_at_ms ELSE EXCLUDED.next_attempt_at_ms END,
             updated_at_ms = EXCLUDED.updated_at_ms",
    )
    .bind(destination_server)
    .bind(event_id)
    .bind(room_id)
    .bind(event_type)
    .bind(sender)
    .bind(origin_server)
    .bind(origin_ts)
    .bind(serde_json::to_string(content).map_err(|e| {
        sqlx::Error::Protocol(format!("invalid federation content json: {e}").into())
    })?)
    .bind(depth)
    .bind(state_key)
    .bind(serde_json::to_string(signatures).map_err(|e| {
        sqlx::Error::Protocol(format!("invalid federation signatures json: {e}").into())
    })?)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn fetch_due_outbound_events(
    pool: &DbPool,
    now_ms: i64,
    limit: i64,
) -> Result<Vec<OutboundFederationEventRow>, sqlx::Error> {
    sqlx::query_as::<_, OutboundFederationEventRow>(
        "SELECT
             q.id,
             q.destination_server,
             fs.federation_endpoint,
             q.event_id,
             q.room_id,
             q.event_type,
             q.sender,
             q.origin_server,
             q.origin_ts,
             q.content,
             q.depth,
             q.state_key,
             q.signatures,
             q.attempt_count
         FROM federation_outbound_queue q
         INNER JOIN federated_servers fs
           ON fs.server_name = q.destination_server
         LEFT JOIN federation_peer_trust_state pts
           ON pts.server_name = q.destination_server
         WHERE q.next_attempt_at_ms <= $1
           AND fs.trusted = TRUE
           AND COALESCE(pts.mode, 'allow') != 'block'
           AND NOT (
               COALESCE(pts.mode, 'allow') = 'quarantine'
               AND COALESCE(pts.quarantined_until_ms, 0) > $1
           )
         ORDER BY q.next_attempt_at_ms ASC
         LIMIT $2",
    )
    .bind(now_ms)
    .bind(limit)
    .fetch_all(pool)
    .await
}

pub async fn mark_outbound_event_delivered(
    pool: &DbPool,
    destination_server: &str,
    event_id: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "DELETE FROM federation_outbound_queue
         WHERE destination_server = $1 AND event_id = $2",
    )
    .bind(destination_server)
    .bind(event_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn mark_outbound_event_retry(
    pool: &DbPool,
    destination_server: &str,
    event_id: &str,
    next_attempt_at_ms: i64,
    error: Option<&str>,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE federation_outbound_queue
         SET
             attempt_count = attempt_count + 1,
             next_attempt_at_ms = $3,
             last_error = $4,
             updated_at_ms = $5
         WHERE destination_server = $1
           AND event_id = $2",
    )
    .bind(destination_server)
    .bind(event_id)
    .bind(next_attempt_at_ms)
    .bind(error)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn record_delivery_attempt(
    pool: &DbPool,
    destination_server: &str,
    event_id: &str,
    success: bool,
    status_code: Option<i64>,
    error: Option<&str>,
    latency_ms: Option<i64>,
    attempted_at_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_delivery_attempts (
             destination_server, event_id, success, status_code, error, latency_ms, attempted_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(destination_server)
    .bind(event_id)
    .bind(success)
    .bind(status_code)
    .bind(error)
    .bind(latency_ms)
    .bind(attempted_at_ms)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn upsert_remote_user_mapping(
    pool: &DbPool,
    remote_user_id: &str,
    origin_server: &str,
    local_user_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_remote_users (remote_user_id, origin_server, local_user_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (remote_user_id) DO UPDATE SET
             origin_server = EXCLUDED.origin_server,
             local_user_id = EXCLUDED.local_user_id",
    )
    .bind(remote_user_id)
    .bind(origin_server)
    .bind(local_user_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_remote_user_mapping(
    pool: &DbPool,
    remote_user_id: &str,
) -> Result<Option<RemoteFederatedUserRow>, sqlx::Error> {
    sqlx::query_as::<_, RemoteFederatedUserRow>(
        "SELECT remote_user_id, origin_server, local_user_id, created_at
         FROM federation_remote_users
         WHERE remote_user_id = $1",
    )
    .bind(remote_user_id)
    .fetch_optional(pool)
    .await
}

pub async fn get_remote_user_mapping_by_local(
    pool: &DbPool,
    local_user_id: i64,
) -> Result<Option<RemoteFederatedUserRow>, sqlx::Error> {
    sqlx::query_as::<_, RemoteFederatedUserRow>(
        "SELECT remote_user_id, origin_server, local_user_id, created_at
         FROM federation_remote_users
         WHERE local_user_id = $1",
    )
    .bind(local_user_id)
    .fetch_optional(pool)
    .await
}

pub async fn map_federated_message(
    pool: &DbPool,
    event_id: &str,
    origin_server: &str,
    remote_message_id: Option<&str>,
    local_message_id: i64,
    channel_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_message_map (
             event_id, origin_server, remote_message_id, local_message_id, channel_id
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id) DO UPDATE SET
             remote_message_id = COALESCE(EXCLUDED.remote_message_id, federation_message_map.remote_message_id),
             local_message_id = EXCLUDED.local_message_id,
             channel_id = EXCLUDED.channel_id",
    )
    .bind(event_id)
    .bind(origin_server)
    .bind(remote_message_id)
    .bind(local_message_id)
    .bind(channel_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_local_message_id_by_remote(
    pool: &DbPool,
    origin_server: &str,
    remote_message_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT local_message_id
         FROM federation_message_map
         WHERE origin_server = $1
           AND remote_message_id = $2
         LIMIT 1",
    )
    .bind(origin_server)
    .bind(remote_message_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}

pub async fn get_local_message_id_by_event(
    pool: &DbPool,
    event_id: &str,
) -> Result<Option<i64>, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT local_message_id
         FROM federation_message_map
         WHERE event_id = $1
         LIMIT 1",
    )
    .bind(event_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(id,)| id))
}

pub async fn upsert_room_membership(
    pool: &DbPool,
    room_id: &str,
    remote_user_id: &str,
    local_user_id: i64,
    guild_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_room_memberships (room_id, remote_user_id, local_user_id, guild_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (room_id, remote_user_id) DO UPDATE SET
             local_user_id = EXCLUDED.local_user_id,
             guild_id = EXCLUDED.guild_id",
    )
    .bind(room_id)
    .bind(remote_user_id)
    .bind(local_user_id)
    .bind(guild_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn delete_room_membership(
    pool: &DbPool,
    room_id: &str,
    remote_user_id: &str,
) -> Result<bool, sqlx::Error> {
    let rows = sqlx::query(
        "DELETE FROM federation_room_memberships
         WHERE room_id = $1
           AND remote_user_id = $2",
    )
    .bind(room_id)
    .bind(remote_user_id)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows > 0)
}

pub async fn has_room_membership(
    pool: &DbPool,
    room_id: &str,
    remote_user_id: &str,
    guild_id: i64,
) -> Result<bool, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT 1
         FROM federation_room_memberships
         WHERE room_id = $1
           AND remote_user_id = $2
           AND guild_id = $3
         LIMIT 1",
    )
    .bind(room_id)
    .bind(remote_user_id)
    .bind(guild_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.is_some())
}

pub async fn list_room_member_servers(
    pool: &DbPool,
    room_id: &str,
) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT remote_user_id
         FROM federation_room_memberships
         WHERE room_id = $1",
    )
    .bind(room_id)
    .fetch_all(pool)
    .await?;

    let mut servers = Vec::new();
    for (remote_user_id,) in rows {
        if let Some((_, server)) = remote_user_id.rsplit_once(':') {
            let trimmed = server.trim();
            if !trimmed.is_empty() {
                servers.push(trimmed.to_string());
            }
        }
    }
    servers.sort();
    servers.dedup();
    Ok(servers)
}

pub async fn upsert_space_mapping(
    pool: &DbPool,
    origin_server: &str,
    remote_space_id: &str,
    local_guild_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_space_map (origin_server, remote_space_id, local_guild_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (origin_server, remote_space_id) DO UPDATE SET
             local_guild_id = EXCLUDED.local_guild_id",
    )
    .bind(origin_server)
    .bind(remote_space_id)
    .bind(local_guild_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_space_mapping_by_remote(
    pool: &DbPool,
    origin_server: &str,
    remote_space_id: &str,
) -> Result<Option<FederatedSpaceMapRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedSpaceMapRow>(
        "SELECT origin_server, remote_space_id, local_guild_id, created_at
         FROM federation_space_map
         WHERE origin_server = $1
           AND remote_space_id = $2",
    )
    .bind(origin_server)
    .bind(remote_space_id)
    .fetch_optional(pool)
    .await
}

pub async fn get_space_mapping_by_local(
    pool: &DbPool,
    local_guild_id: i64,
) -> Result<Option<FederatedSpaceMapRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedSpaceMapRow>(
        "SELECT origin_server, remote_space_id, local_guild_id, created_at
         FROM federation_space_map
         WHERE local_guild_id = $1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(local_guild_id)
    .fetch_optional(pool)
    .await
}

pub async fn list_space_mappings_by_origin(
    pool: &DbPool,
    origin_server: &str,
) -> Result<Vec<FederatedSpaceMapRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedSpaceMapRow>(
        "SELECT origin_server, remote_space_id, local_guild_id, created_at
         FROM federation_space_map
         WHERE origin_server = $1
         ORDER BY created_at ASC",
    )
    .bind(origin_server)
    .fetch_all(pool)
    .await
}

pub async fn upsert_channel_mapping(
    pool: &DbPool,
    origin_server: &str,
    remote_channel_id: &str,
    local_channel_id: i64,
    local_guild_id: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_channel_map (
             origin_server, remote_channel_id, local_channel_id, local_guild_id
         )
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (origin_server, remote_channel_id) DO UPDATE SET
             local_channel_id = EXCLUDED.local_channel_id,
             local_guild_id = EXCLUDED.local_guild_id",
    )
    .bind(origin_server)
    .bind(remote_channel_id)
    .bind(local_channel_id)
    .bind(local_guild_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn get_channel_mapping_by_remote(
    pool: &DbPool,
    origin_server: &str,
    remote_channel_id: &str,
) -> Result<Option<FederatedChannelMapRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedChannelMapRow>(
        "SELECT origin_server, remote_channel_id, local_channel_id, local_guild_id, created_at
         FROM federation_channel_map
         WHERE origin_server = $1
           AND remote_channel_id = $2",
    )
    .bind(origin_server)
    .bind(remote_channel_id)
    .fetch_optional(pool)
    .await
}

pub async fn get_channel_mapping_by_local(
    pool: &DbPool,
    local_channel_id: i64,
) -> Result<Option<FederatedChannelMapRow>, sqlx::Error> {
    sqlx::query_as::<_, FederatedChannelMapRow>(
        "SELECT origin_server, remote_channel_id, local_channel_id, local_guild_id, created_at
         FROM federation_channel_map
         WHERE local_channel_id = $1
         ORDER BY created_at ASC
         LIMIT 1",
    )
    .bind(local_channel_id)
    .fetch_optional(pool)
    .await
}

pub async fn get_room_sync_cursor(
    pool: &DbPool,
    server_name: &str,
    room_id: &str,
) -> Result<i64, sqlx::Error> {
    let row: Option<(i64,)> = sqlx::query_as(
        "SELECT last_depth
         FROM federation_room_sync_cursors
         WHERE server_name = $1
           AND room_id = $2
         LIMIT 1",
    )
    .bind(server_name)
    .bind(room_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(depth,)| depth).unwrap_or(0))
}

pub async fn upsert_room_sync_cursor(
    pool: &DbPool,
    server_name: &str,
    room_id: &str,
    last_depth: i64,
    now_ms: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO federation_room_sync_cursors (server_name, room_id, last_depth, updated_at_ms)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (server_name, room_id) DO UPDATE SET
             last_depth = MAX(federation_room_sync_cursors.last_depth, EXCLUDED.last_depth),
             updated_at_ms = EXCLUDED.updated_at_ms",
    )
    .bind(server_name)
    .bind(room_id)
    .bind(last_depth)
    .bind(now_ms)
    .execute(pool)
    .await?;
    Ok(())
}

/// Purge expired outbound events that have exceeded max retry attempts or age.
pub async fn purge_expired_outbound_events(
    pool: &DbPool,
    now_ms: i64,
    max_attempts: i64,
    max_age_ms: i64,
) -> Result<u64, sqlx::Error> {
    let cutoff_ms = now_ms.saturating_sub(max_age_ms);
    let rows = sqlx::query(
        "DELETE FROM federation_outbound_queue
         WHERE attempt_count >= $1 OR created_at_ms < $2",
    )
    .bind(max_attempts)
    .bind(cutoff_ms)
    .execute(pool)
    .await?
    .rows_affected();
    Ok(rows)
}

/// Store or replace the local server's ed25519 keypair (singleton row, id=1).
pub async fn upsert_server_keypair(
    pool: &DbPool,
    key_id: &str,
    signing_key_hex: &str,
    public_key_hex: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO server_keypair (id, key_id, signing_key_hex, public_key_hex)
         VALUES (1, $1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET
             key_id = EXCLUDED.key_id,
             signing_key_hex = EXCLUDED.signing_key_hex,
             public_key_hex = EXCLUDED.public_key_hex",
    )
    .bind(key_id)
    .bind(signing_key_hex)
    .bind(public_key_hex)
    .execute(pool)
    .await?;
    Ok(())
}

/// Load the local server's keypair if it exists.
pub async fn get_server_keypair(pool: &DbPool) -> Result<Option<ServerKeypairRow>, sqlx::Error> {
    sqlx::query_as::<_, ServerKeypairRow>(
        "SELECT id, key_id, signing_key_hex, public_key_hex, created_at FROM server_keypair WHERE id = 1",
    )
    .fetch_optional(pool)
    .await
}
