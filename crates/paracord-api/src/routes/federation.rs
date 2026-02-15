use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use ed25519_dalek::SigningKey;
use paracord_core::AppState;
use paracord_federation::{
    FederationConfig, FederationEventEnvelope, FederationServerKey, FederationService,
};
use serde_json::{json, Value};

use crate::error::ApiError;

fn parse_signing_key() -> Option<SigningKey> {
    let raw = std::env::var("PARACORD_FEDERATION_SIGNING_KEY_HEX").ok()?;
    if raw.len() != 64 {
        return None;
    }
    let mut bytes = [0u8; 32];
    for (idx, chunk) in raw.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        bytes[idx] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(SigningKey::from_bytes(&bytes))
}

fn federation_service() -> FederationService {
    let enabled = std::env::var("PARACORD_FEDERATION_ENABLED")
        .ok()
        .and_then(|v| v.parse::<bool>().ok())
        .unwrap_or(false);
    let server_name =
        std::env::var("PARACORD_SERVER_NAME").unwrap_or_else(|_| "localhost".to_string());
    let key_id = std::env::var("PARACORD_FEDERATION_KEY_ID")
        .unwrap_or_else(|_| "ed25519:auto".to_string());
    FederationService::new(FederationConfig {
        enabled,
        server_name,
        key_id,
        signing_key: parse_signing_key(),
    })
}

pub async fn well_known() -> Result<Json<Value>, ApiError> {
    let service = federation_service();
    Ok(Json(json!({
        "server_name": service.server_name(),
        "federation_endpoint": "/_paracord/federation/v1",
        "enabled": service.is_enabled(),
    })))
}

pub async fn get_keys(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let service = federation_service();
    if !service.is_enabled() {
        return Ok(Json(json!({
            "server_name": service.server_name(),
            "keys": [],
        })));
    }
    let mut keys = service
        .list_server_keys(&state.db, service.server_name())
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if keys.is_empty() {
        if let Some(public_key) = service.signing_public_key() {
            let key = FederationServerKey {
                server_name: service.server_name().to_string(),
                key_id: service.key_id().to_string(),
                public_key,
                valid_until: chrono::Utc::now().timestamp_millis() + 86_400_000,
            };
            service
                .upsert_server_key(&state.db, &key)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
            keys.push(key);
        }
    }
    Ok(Json(json!({
        "server_name": service.server_name(),
        "keys": keys,
    })))
}

pub async fn ingest_event(
    State(state): State<AppState>,
    Json(payload): Json<FederationEventEnvelope>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let service = federation_service();
    if !service.is_enabled() {
        return Err(ApiError::Forbidden("forbidden".into()));
    }
    let inserted = service
        .persist_event(&state.db, &payload)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok((
        StatusCode::ACCEPTED,
        Json(json!({
            "event_id": payload.event_id,
            "inserted": inserted,
        })),
    ))
}

pub async fn get_event(
    State(state): State<AppState>,
    Path(event_id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let service = federation_service();
    if !service.is_enabled() {
        return Err(ApiError::Forbidden("forbidden".into()));
    }
    let event = service
        .fetch_event(&state.db, &event_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    match event {
        Some(envelope) => Ok(Json(json!(envelope))),
        None => Err(ApiError::NotFound),
    }
}
