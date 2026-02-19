use axum::{
    extract::{Path, State},
    Json,
};
use paracord_core::AppState;
use serde::Deserialize;
use serde_json::{json, Value};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const MAX_OPK_PER_REQUEST: usize = 100;
// 32-byte key = 44 base64 chars (with padding)
const EXPECTED_KEY_BASE64_LEN: usize = 44;
// 64-byte signature = 88 base64 chars (with padding)
const EXPECTED_SIG_BASE64_LEN: usize = 88;

fn is_valid_base64(s: &str, expected_len: usize) -> bool {
    if s.len() != expected_len {
        return false;
    }
    s.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '-' || c == '_')
}

#[derive(Deserialize)]
pub struct SignedPrekeyUpload {
    pub id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize)]
pub struct OneTimePrekeyUpload {
    pub id: i64,
    pub public_key: String,
}

#[derive(Deserialize)]
pub struct UploadKeysRequest {
    pub signed_prekey: Option<SignedPrekeyUpload>,
    pub one_time_prekeys: Option<Vec<OneTimePrekeyUpload>>,
}

/// PUT /api/v1/users/@me/keys -- Upload prekey bundle
pub async fn upload_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<UploadKeysRequest>,
) -> Result<Json<Value>, ApiError> {
    let mut signed_prekey_id: Option<i64> = None;
    let mut opk_stored: u64 = 0;

    if let Some(spk) = &body.signed_prekey {
        if !is_valid_base64(&spk.public_key, EXPECTED_KEY_BASE64_LEN) {
            return Err(ApiError::BadRequest(
                "Invalid signed prekey public_key format (expected 44 base64 chars)".into(),
            ));
        }
        if !is_valid_base64(&spk.signature, EXPECTED_SIG_BASE64_LEN) {
            return Err(ApiError::BadRequest(
                "Invalid signed prekey signature format (expected 88 base64 chars)".into(),
            ));
        }
        let row = paracord_db::prekeys::upsert_signed_prekey(
            &state.db,
            spk.id,
            auth.user_id,
            &spk.public_key,
            &spk.signature,
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        signed_prekey_id = Some(row.id);
    }

    if let Some(opks) = &body.one_time_prekeys {
        if opks.len() > MAX_OPK_PER_REQUEST {
            return Err(ApiError::BadRequest(
                format!("Too many one-time prekeys (max {})", MAX_OPK_PER_REQUEST),
            ));
        }
        for opk in opks {
            if !is_valid_base64(&opk.public_key, EXPECTED_KEY_BASE64_LEN) {
                return Err(ApiError::BadRequest(
                    format!(
                        "Invalid one-time prekey public_key format for id {} (expected 44 base64 chars)",
                        opk.id
                    ),
                ));
            }
        }
        let keys: Vec<(i64, String)> = opks.iter().map(|k| (k.id, k.public_key.clone())).collect();
        opk_stored = paracord_db::prekeys::upload_one_time_prekeys(&state.db, auth.user_id, &keys)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let total = paracord_db::prekeys::count_one_time_prekeys(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "signed_prekey_id": signed_prekey_id,
        "one_time_prekeys_stored": opk_stored,
        "one_time_prekeys_total": total,
    })))
}

/// GET /api/v1/users/{user_id}/keys -- Fetch peer's prekey bundle
pub async fn get_keys(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(user_id): Path<i64>,
) -> Result<Json<Value>, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let identity_key = user.public_key.ok_or_else(|| {
        ApiError::NotFound
    })?;

    let spk = paracord_db::prekeys::get_signed_prekey(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let opk = paracord_db::prekeys::consume_one_time_prekey(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let opk_json = opk.map(|o| {
        json!({
            "id": o.id,
            "public_key": o.public_key,
        })
    });

    Ok(Json(json!({
        "identity_key": identity_key,
        "signed_prekey": {
            "id": spk.id,
            "public_key": spk.public_key,
            "signature": spk.signature,
        },
        "one_time_prekey": opk_json,
    })))
}

/// GET /api/v1/users/@me/keys/count -- Check OPK count
pub async fn get_key_count(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let count = paracord_db::prekeys::count_one_time_prekeys(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let has_spk = paracord_db::prekeys::get_signed_prekey(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .is_some();

    Ok(Json(json!({
        "one_time_prekeys_remaining": count,
        "signed_prekey_uploaded": has_spk,
    })))
}
