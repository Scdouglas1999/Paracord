use axum::{
    extract::{Query, State},
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// Upper bound on the candidate set scanned per request.
///
/// There is no paginated discovery query in `paracord-db`, so the handler filters
/// public guilds in Rust. Without this cap the cost of a single request scaled
/// with the total number of public guilds on the instance — which is what made
/// the previously-unauthenticated endpoint an amplification vector.
const MAX_DISCOVERY_CANDIDATES: usize = 200;

/// Deepest page offset accepted. Paging beyond the candidate cap cannot return
/// anything, so a larger offset is only ever wasted work.
const MAX_DISCOVERY_OFFSET: i64 = 200;

#[derive(Deserialize)]
pub struct DiscoveryQuery {
    pub search: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
    pub include_federated: Option<String>,
    pub federated: Option<String>,
}

fn bool_query_enabled(raw: Option<&str>) -> bool {
    matches!(
        raw.map(str::trim)
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "1" | "true" | "yes" | "on"
    )
}

async fn fetch_federated_discoverable_guilds(
    state: &AppState,
    params: &DiscoveryQuery,
    limit: i64,
) -> Vec<Value> {
    let peers = match paracord_db::federation::list_trusted_federated_servers(&state.db).await {
        Ok(peers) => peers,
        Err(_) => return Vec::new(),
    };
    if peers.is_empty() {
        return Vec::new();
    }

    // Peer discovery is fetched over the *signed* federation path, not the
    // public REST endpoint. `/api/v1/discovery/guilds` now requires an
    // authenticated user (it was an anonymous N+1 amplification vector), so an
    // unauthenticated cross-server GET would simply 401 and federated discovery
    // would silently return nothing. `fetch_peer_discoverable_guilds` signs the
    // request with this server's Ed25519 key and performs the same SSRF
    // validation + DNS pinning the raw client used to do here.
    let service = crate::routes::federation::build_federation_service();
    let Some(client) = crate::routes::federation::build_signed_federation_client(&service) else {
        tracing::warn!("federated discovery skipped: no federation signing key configured");
        return Vec::new();
    };

    let mut results = Vec::new();
    for peer in peers {
        let guilds = match client
            .fetch_peer_discoverable_guilds(
                &peer.federation_endpoint,
                params.search.as_deref(),
                params.tag.as_deref(),
                limit,
            )
            .await
        {
            Ok(guilds) => guilds,
            Err(err) => {
                tracing::warn!(
                    server = %peer.server_name,
                    endpoint = %peer.federation_endpoint,
                    error = %err,
                    "federated discovery request failed"
                );
                continue;
            }
        };

        for guild in &guilds {
            let Some(remote_id) = guild.get("id").and_then(|v| v.as_str()) else {
                continue;
            };
            results.push(json!({
                "id": format!("{}:{}", peer.server_name, remote_id),
                "remote_id": remote_id,
                "name": guild.get("name").cloned().unwrap_or_else(|| json!("Unknown guild")),
                "description": guild.get("description").cloned().unwrap_or(Value::Null),
                "icon_hash": guild.get("icon_hash").cloned().unwrap_or(Value::Null),
                "member_count": guild.get("member_count").cloned().unwrap_or_else(|| json!(0)),
                "online_count": guild.get("online_count").cloned().unwrap_or_else(|| json!(0)),
                "tags": guild.get("tags").cloned().unwrap_or_else(|| json!([])),
                "created_at": guild.get("created_at").cloned().unwrap_or(Value::Null),
                "federated": true,
                "origin_server": peer.server_name,
                "origin_domain": peer.domain,
                "federation_endpoint": peer.federation_endpoint,
            }));
        }
    }

    results
}

/// GET /discovery/guilds
///
/// Authenticated: the handler still has to scan the guild table in Rust (there
/// is no paginated discovery query in `paracord-db`), so leaving it open let an
/// anonymous client burn a full table scan plus two queries per public guild at
/// the per-IP rate limit. The candidate set is capped and the expensive
/// per-guild membership read now runs only for the page that is actually
/// returned.
pub async fn list_discoverable_guilds(
    State(state): State<AppState>,
    _auth: AuthUser,
    Query(params): Query<DiscoveryQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = params.limit.unwrap_or(20).clamp(1, 50);
    let offset = params.offset.unwrap_or(0).clamp(0, MAX_DISCOVERY_OFFSET);
    let include_federated = bool_query_enabled(
        params
            .include_federated
            .as_deref()
            .or(params.federated.as_deref()),
    );

    // Get all guilds and filter by public visibility for discovery.
    let all_guilds = paracord_db::guilds::list_all_guilds(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let mut discoverable: Vec<_> = all_guilds
        .into_iter()
        .filter(|g| g.visibility.eq_ignore_ascii_case("public"))
        .collect();

    // Filter by search query
    if let Some(ref search) = params.search {
        let search_lower = search.to_lowercase();
        discoverable.retain(|g| {
            g.name.to_lowercase().contains(&search_lower)
                || g.description
                    .as_deref()
                    .map(|d| d.to_lowercase().contains(&search_lower))
                    .unwrap_or(false)
        });
    }

    // Filter by tag
    if let Some(ref tag) = params.tag {
        let tag_lower = tag.to_lowercase();
        discoverable.retain(|g| {
            let tags = parse_discovery_tags(&g.discovery_tags);
            tags.iter().any(|t| t.to_lowercase() == tag_lower)
        });
    }

    // Bound the work: without a paginated DB read this is the only thing
    // keeping the request cost independent of how many public guilds exist.
    discoverable.truncate(MAX_DISCOVERY_CANDIDATES);

    // Each entry is tagged with its local guild id (None for federated results)
    // so the expensive online-member read can be deferred until after paging.
    let mut result: Vec<(Option<i64>, Value)> = Vec::with_capacity(discoverable.len());
    for guild in discoverable {
        let member_count = paracord_db::members::get_member_count(&state.db, guild.id)
            .await
            .unwrap_or(0);
        let tags = parse_discovery_tags(&guild.discovery_tags);

        result.push((
            Some(guild.id),
            json!({
                "id": guild.id.to_string(),
                "name": guild.name,
                "description": guild.description,
                "icon_hash": guild.icon_hash,
                "member_count": member_count,
                "online_count": 0,
                "tags": tags,
                "created_at": guild.created_at.to_rfc3339(),
                "federated": false,
            }),
        ));
    }

    if include_federated {
        let federated =
            fetch_federated_discoverable_guilds(&state, &params, limit.saturating_mul(3)).await;
        result.extend(federated.into_iter().map(|entry| (None, entry)));
    }

    result.sort_by(|a, b| {
        let left =
            a.1.get("member_count")
                .and_then(|v| v.as_i64())
                .unwrap_or_default();
        let right =
            b.1.get("member_count")
                .and_then(|v| v.as_i64())
                .unwrap_or_default();
        right.cmp(&left)
    });

    let total = result.len() as i64;
    let start = offset as usize;
    let end = (start + limit as usize).min(result.len());
    let mut page = if start < result.len() {
        result[start..end].to_vec()
    } else {
        Vec::new()
    };

    // `get_guild_member_user_ids` is unbounded per guild, so it runs only for
    // the <=50 entries actually being returned rather than for every public
    // guild on the instance.
    for (guild_id, entry) in page.iter_mut() {
        let Some(guild_id) = *guild_id else {
            continue;
        };
        let guild_members = paracord_db::members::get_guild_member_user_ids(&state.db, guild_id)
            .await
            .unwrap_or_default();
        let online_count = guild_members
            .iter()
            .filter(|uid| state.online_users.contains(uid))
            .count();
        entry["online_count"] = json!(online_count);
    }

    let page: Vec<Value> = page.into_iter().map(|(_, entry)| entry).collect();

    Ok(Json(json!({
        "guilds": page,
        "total": total,
    })))
}

fn parse_discovery_tags(raw: &str) -> Vec<String> {
    if let Ok(tags) = serde_json::from_str::<Vec<String>>(raw) {
        return tags;
    }
    raw.split(',')
        .map(str::trim)
        .filter(|tag| !tag.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::bool_query_enabled;

    #[test]
    fn bool_query_enabled_accepts_only_explicit_truthy_values() {
        assert!(bool_query_enabled(Some("true")));
        assert!(bool_query_enabled(Some(" 1 ")));
        assert!(bool_query_enabled(Some("YES")));
        assert!(!bool_query_enabled(None));
        assert!(!bool_query_enabled(Some("false")));
        assert!(!bool_query_enabled(Some("sure")));
    }
}
