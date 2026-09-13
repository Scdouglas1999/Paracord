use axum::{
    extract::{Path, State},
    Json,
};
use paracord_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

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
    s.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '+' || c == '/' || c == '=' || c == '-' || c == '_'
    })
}

#[derive(Deserialize, Serialize)]
pub struct SignedPrekeyUpload {
    pub id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Deserialize, Serialize)]
pub struct OneTimePrekeyUpload {
    pub id: i64,
    pub public_key: String,
}

#[derive(Deserialize, Serialize)]
pub struct UploadKeysRequest {
    /// An immutable publication ID and enrolled identity are required together.
    /// Legacy clients may omit both; new clients persist both before sending.
    pub request_id: Option<String>,
    pub expected_identity_key: Option<String>,
    pub signed_prekey: Option<SignedPrekeyUpload>,
    pub one_time_prekeys: Option<Vec<OneTimePrekeyUpload>>,
    /// Long-lived last-resort one-time prekey. Handed out (without deletion) as
    /// an X3DH fallback once the disposable pool is drained, so a hostile caller
    /// cannot exhaust the pool and force new sessions down to signed-prekey-only.
    pub last_resort_prekey: Option<OneTimePrekeyUpload>,
}

/// PUT /api/v1/users/@me/keys -- Upload prekey bundle
pub async fn upload_keys(
    State(state): State<AppState>,
    auth: AuthUser,
    Json(body): Json<UploadKeysRequest>,
) -> Result<Json<paracord_db::prekeys::PrekeyPublication>, ApiError> {
    match (&body.request_id, &body.expected_identity_key) {
        (Some(id), Some(key)) if uuid::Uuid::parse_str(id).is_ok() && key.len() == 64
            && key.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) => {},
        (None, None) => {},
        _ => return Err(ApiError::BadRequest("A valid publication UUID and lowercase hexadecimal enrolled identity key are required together.".into())),
    }
    let request_hash = format!(
        "{:x}",
        Sha256::digest(
            serde_json::to_vec(&body).map_err(|error| ApiError::Internal(error.into()))?
        )
    );
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
    }

    if let Some(opks) = &body.one_time_prekeys {
        if opks.len() > MAX_OPK_PER_REQUEST {
            return Err(ApiError::BadRequest(format!(
                "Too many one-time prekeys (max {})",
                MAX_OPK_PER_REQUEST
            )));
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
    }

    if let Some(lrk) = &body.last_resort_prekey {
        if !is_valid_base64(&lrk.public_key, EXPECTED_KEY_BASE64_LEN) {
            return Err(ApiError::BadRequest(
                "Invalid last-resort prekey public_key format (expected 44 base64 chars)".into(),
            ));
        }
    }

    let keys: Vec<_> = body
        .one_time_prekeys
        .as_deref()
        .unwrap_or_default()
        .iter()
        .map(|key| (key.id, key.public_key.clone()))
        .collect();
    let publication = paracord_db::prekeys::publish_prekeys(
        &state.db,
        auth.user_id,
        body.signed_prekey
            .as_ref()
            .map(|key| (key.id, key.public_key.as_str(), key.signature.as_str())),
        &keys,
        body.last_resort_prekey
            .as_ref()
            .map(|key| (key.id, key.public_key.as_str())),
        body.request_id
            .as_ref()
            .zip(body.expected_identity_key.as_ref())
            .map(|(request_id, expected_identity_key)| {
                paracord_db::prekeys::PrekeyPublicationIdentity {
                    request_id,
                    expected_identity_key,
                    request_hash: &request_hash,
                }
            }),
    )
    .await?;

    // A peer's encryption readiness depends on published prekeys, not only on an
    // enrolled identity key. Republish the same public profile hint the identity
    // routes use so a conversation that could not be encrypted a moment ago is
    // re-checked by its current observers. The hint is advisory: the channel
    // capability endpoint remains authoritative, so a failed audience read is
    // logged rather than reported as a failed publication.
    if publication.signed_prekey_id.is_some()
        || publication.one_time_prekeys_total > 0
        || publication.last_resort_prekey_id.is_some()
    {
        match publish_readiness_hint(&state, auth.user_id).await {
            Ok(()) => {}
            Err(error) => tracing::warn!(
                user_id = auth.user_id,
                error = %error,
                "published prekeys but could not notify this account's observers"
            ),
        }
    }

    Ok(Json(publication))
}

/// Resolve the same observer audience the identity routes use and publish the
/// account's public profile to it.
async fn publish_readiness_hint(state: &AppState, user_id: i64) -> Result<(), ApiError> {
    let Some(user) = paracord_db::users::get_user_by_id(&state.db, user_id).await? else {
        return Err(ApiError::NotFound);
    };
    if user.public_key.is_none() {
        return Ok(());
    }
    let mut transaction = state
        .db
        .begin()
        .await
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error.to_string())))?;
    let observers =
        paracord_db::users::identity_observer_ids_in_transaction(&mut transaction, user_id).await?;
    transaction
        .commit()
        .await
        .map_err(|error| ApiError::Internal(anyhow::anyhow!(error.to_string())))?;
    super::auth::publish_identity_update(state, &user, observers);
    Ok(())
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

    let identity_key = user.public_key.ok_or_else(|| ApiError::NotFound)?;

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

    let has_last_resort = paracord_db::prekeys::has_last_resort_prekey(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(Json(json!({
        "one_time_prekeys_remaining": count,
        "signed_prekey_uploaded": has_spk,
        "last_resort_prekey_uploaded": has_last_resort,
    })))
}

#[derive(Serialize)]
pub struct PublicSignedPrekey {
    pub id: i64,
    pub public_key: String,
    pub signature: String,
}

#[derive(Serialize)]
pub struct PublicOneTimePrekey {
    pub id: i64,
    pub public_key: String,
}

#[derive(Serialize)]
pub struct OwnPublicKeysResponse {
    pub identity_key: Option<String>,
    pub signed_prekey: Option<PublicSignedPrekey>,
    pub one_time_prekeys: Vec<PublicOneTimePrekey>,
    pub last_resort_prekey: Option<PublicOneTimePrekey>,
}

/// GET /api/v1/users/@me/keys -- Inspect authenticated ownership without
/// consuming a peer bundle or guessing which account owns local private keys.
pub async fn get_own_keys(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<OwnPublicKeysResponse>, ApiError> {
    let rows = paracord_db::prekeys::get_public_prekey_state(&state.db, auth.user_id).await?;
    let first = rows.first().ok_or(ApiError::NotFound)?;
    let signed_prekey = match (
        first.signed_prekey_id,
        first.signed_prekey_public_key.as_ref(),
        first.signed_prekey_signature.as_ref(),
    ) {
        (Some(id), Some(key), Some(signature)) => Some(PublicSignedPrekey {
            id,
            public_key: key.clone(),
            signature: signature.clone(),
        }),
        (None, None, None) => None,
        _ => {
            return Err(ApiError::Internal(anyhow::anyhow!(
                "Incomplete published signed prekey"
            )))
        }
    };
    let mut response = OwnPublicKeysResponse {
        identity_key: first.identity_key.clone(),
        signed_prekey,
        one_time_prekeys: Vec::new(),
        last_resort_prekey: None,
    };
    for row in rows {
        match (row.prekey_id, row.prekey_public_key, row.last_resort) {
            (None, None, None) => {}
            (Some(id), Some(public_key), Some(0)) => response
                .one_time_prekeys
                .push(PublicOneTimePrekey { id, public_key }),
            (Some(id), Some(public_key), Some(1)) if response.last_resort_prekey.is_none() => {
                response.last_resort_prekey = Some(PublicOneTimePrekey { id, public_key });
            }
            _ => {
                return Err(ApiError::Internal(anyhow::anyhow!(
                    "Invalid published one-time prekey state"
                )))
            }
        }
    }
    Ok(Json(response))
}
