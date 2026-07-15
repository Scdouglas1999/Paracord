use axum::{
    extract::{Query, State},
    Json,
};
use futures_util::TryStreamExt;
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::error::ApiError;

const FEDERATED_DISCOVERY_RESPONSE_BODY_LIMIT: usize = 512 * 1024;

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

fn discovery_base_from_federation_endpoint(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    let without_suffix = trimmed
        .strip_suffix("/_paracord/federation/v1")
        .or_else(|| trimmed.strip_suffix("/_paracord/federation"))
        .unwrap_or(trimmed);
    format!("{without_suffix}/api/v1/discovery/guilds")
}

async fn read_federated_discovery_json_response(response: reqwest::Response) -> Result<Value, ()> {
    if response.content_length().is_some_and(|len| {
        len > u64::try_from(FEDERATED_DISCOVERY_RESPONSE_BODY_LIMIT).unwrap_or(u64::MAX)
    }) {
        return Err(());
    }

    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    loop {
        let chunk = match stream.try_next().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(_) => return Err(()),
        };
        if body.len().saturating_add(chunk.len()) > FEDERATED_DISCOVERY_RESPONSE_BODY_LIMIT {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }

    serde_json::from_slice(&body).map_err(|_| ())
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

    let mut results = Vec::new();
    for peer in peers {
        let url = discovery_base_from_federation_endpoint(&peer.federation_endpoint);
        // Resolve + validate the peer host and pin the connection to the
        // validated address. Building the client per peer (rather than once,
        // unpinned) closes the DNS-rebinding TOCTOU: reqwest connects only to
        // the exact IP that passed the SSRF check.
        let http = match paracord_federation::client::ssrf_checked_pinned_client_for_url(
            "Paracord-Discovery/1.0",
            Duration::from_secs(4),
            &url,
        )
        .await
        {
            Ok(client) => client,
            Err(_) => {
                tracing::warn!(
                    server = %peer.server_name,
                    endpoint = %peer.federation_endpoint,
                    "skipping federated discovery for unsafe peer endpoint"
                );
                continue;
            }
        };
        let mut request = http
            .get(url)
            .query(&[("limit", limit.to_string()), ("offset", "0".to_string())]);
        if let Some(search) = params.search.as_deref() {
            request = request.query(&[("search", search)]);
        }
        if let Some(tag) = params.tag.as_deref() {
            request = request.query(&[("tag", tag)]);
        }

        let response = match request.send().await {
            Ok(resp) => resp,
            Err(_) => continue,
        };
        if !response.status().is_success() {
            continue;
        }

        let payload: Value = match read_federated_discovery_json_response(response).await {
            Ok(payload) => payload,
            Err(_) => continue,
        };
        let Some(guilds) = payload.get("guilds").and_then(|v| v.as_array()) else {
            continue;
        };

        for guild in guilds {
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

pub async fn list_discoverable_guilds(
    State(state): State<AppState>,
    Query(params): Query<DiscoveryQuery>,
) -> Result<Json<Value>, ApiError> {
    let limit = params.limit.unwrap_or(20).clamp(1, 50);
    let offset = params.offset.unwrap_or(0).max(0);
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

    let mut result = Vec::with_capacity(discoverable.len());
    for guild in discoverable {
        let member_count = paracord_db::members::get_member_count(&state.db, guild.id)
            .await
            .unwrap_or(0);
        let tags = parse_discovery_tags(&guild.discovery_tags);

        // Count online members for this guild
        let guild_members = paracord_db::members::get_guild_member_user_ids(&state.db, guild.id)
            .await
            .unwrap_or_default();
        let online_count = guild_members
            .iter()
            .filter(|uid| state.online_users.contains(uid))
            .count();

        result.push(json!({
            "id": guild.id.to_string(),
            "name": guild.name,
            "description": guild.description,
            "icon_hash": guild.icon_hash,
            "member_count": member_count,
            "online_count": online_count,
            "tags": tags,
            "created_at": guild.created_at.to_rfc3339(),
            "federated": false,
        }));
    }

    if include_federated {
        let mut federated =
            fetch_federated_discoverable_guilds(&state, &params, limit.saturating_mul(3)).await;
        result.append(&mut federated);
    }

    result.sort_by(|a, b| {
        let left = a
            .get("member_count")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        let right = b
            .get("member_count")
            .and_then(|v| v.as_i64())
            .unwrap_or_default();
        right.cmp(&left)
    });

    let total = result.len() as i64;
    let start = offset as usize;
    let end = (start + limit as usize).min(result.len());
    let page = if start < result.len() {
        result[start..end].to_vec()
    } else {
        Vec::new()
    };

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
    use super::{bool_query_enabled, discovery_base_from_federation_endpoint};

    #[test]
    fn discovery_base_from_federation_endpoint_normalizes_known_suffixes() {
        assert_eq!(
            discovery_base_from_federation_endpoint("https://peer.example/_paracord/federation/v1"),
            "https://peer.example/api/v1/discovery/guilds"
        );
        assert_eq!(
            discovery_base_from_federation_endpoint("https://peer.example/_paracord/federation/"),
            "https://peer.example/api/v1/discovery/guilds"
        );
    }

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
