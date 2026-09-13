//! First-owner claim: the only way an unclaimed instance gets an account.
//!
//! A fresh database is `pending`. Until it is claimed, `POST /auth/register`
//! refuses every request (see [`super::auth::SETUP_REQUIRED_MESSAGE`]) and the
//! single account-creating path is [`claim_instance`], which requires the
//! one-time bootstrap token the server printed on startup. That replaces the
//! old behaviour in which whoever reached a freshly exposed server first became
//! its administrator without being told so.
//!
//! Nothing here derives setup state from the user count or from a config file:
//! the `instance_setup` row is the only authority, so deleting the owner later
//! cannot reopen the bootstrap window.

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{AppendHeaders, IntoResponse},
    Json,
};
use paracord_core::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::net::SocketAddr;

use crate::error::ApiError;
use crate::routes::auth::{
    auth_guard_enforce, auth_guard_record_failure, auth_guard_record_success, header_value,
    issue_auth_session, new_account_input_error, normalize_email_for_auth,
    normalize_login_identifier_for_auth, refresh_token_for_body, registration_identity_taken,
    synthesized_local_email, user_json, username_is_registered, AuthResponse,
};
use crate::routes::security;

/// What an unauthenticated client needs in order to decide between the login
/// page and the setup page. Deliberately minimal: it is readable by anyone who
/// can reach the server, so it carries no token, no hash, and no operator
/// detail beyond the instance's own display name.
#[derive(Debug, Serialize)]
pub struct SetupStatusResponse {
    /// True while this instance still needs its first owner.
    pub setup_required: bool,
    /// Operator-chosen name for this instance, once it has been claimed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub instance_name: Option<String>,
}

/// `GET /api/v1/setup/status` — public.
pub async fn setup_status(
    State(state): State<AppState>,
) -> Result<Json<SetupStatusResponse>, ApiError> {
    let row = paracord_db::instance_setup::get(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(Json(SetupStatusResponse {
        setup_required: row.is_pending(),
        instance_name: row.instance_name,
    }))
}

/// `GET /api/v1/setup/password-requirements` — public.
///
/// The claim page renders the password rules before submit, exactly as the
/// registration page does. It is served from the same server-side constants so
/// the advertised rules cannot drift from the ones actually enforced.
pub async fn password_requirements() -> Json<Value> {
    Json(json!({
        "min_length": paracord_util::validation::PASSWORD_MIN_LENGTH,
        "max_length": paracord_util::validation::PASSWORD_MAX_LENGTH,
        "requires_uppercase": true,
        "requires_lowercase": true,
        "requires_digit": true,
        "requires_symbol": true,
        "length_unit": "utf8_bytes",
    }))
}

#[derive(Debug, Deserialize)]
pub struct ClaimRequest {
    pub token: String,
    pub username: String,
    #[serde(default)]
    pub email: String,
    pub password: String,
    pub instance_name: String,
    pub initial_space_name: String,
    /// Optional icon hash for the first space, validated by the same space
    /// creation path every other space goes through.
    #[serde(default)]
    pub initial_space_icon: Option<String>,
    #[serde(default)]
    pub display_name: Option<String>,
}

#[derive(Serialize)]
pub struct ClaimResponse {
    #[serde(flatten)]
    pub auth: AuthResponse,
    /// The space created for the owner, so the client can land in it directly.
    pub space: paracord_contracts::guild::GuildDetail,
    pub instance_name: String,
}

/// `POST /api/v1/setup/claim` — public, token-gated, single use.
pub async fn claim_instance(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ClaimRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let normalized_email = normalize_email_for_auth(&body.email);
    let account_hint = if normalized_email.is_empty() {
        normalize_login_identifier_for_auth(&body.username)
    } else {
        normalized_email.clone()
    };

    // Same exponential-backoff guard the login and registration paths use, so a
    // bootstrap token cannot be brute-forced any faster than a password can.
    auth_guard_enforce(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&account_hint),
    )
    .await?;

    let setup = paracord_db::instance_setup::get(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !setup.is_pending() {
        // No guard failure recorded: this is a settled state, not a guess. An
        // attacker learns nothing they could not read from `GET /setup/status`.
        return Err(ApiError::Conflict(
            "This server has already been set up.".into(),
        ));
    }

    // A pending instance with no provisioned token cannot be claimed at all.
    // Answering "wrong token" here would be a lie, and silently accepting any
    // token would be catastrophic, so say exactly what is wrong.
    let Some(stored_hash) = setup.claim_token_hash.as_deref() else {
        return Err(ApiError::ServiceUnavailable(
            "This server has no setup claim token provisioned. Restart the server to mint one, or set [setup] claim_token in its configuration.".into(),
        ));
    };

    if !paracord_core::instance_setup::claim_token_matches(body.token.trim(), stored_hash) {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        security::log_security_event(
            &state,
            "instance.setup.claim.rejected",
            None,
            None,
            None,
            Some(&headers),
            Some(peer_ip.as_str()),
            Some(json!({ "reason": "invalid_token" })),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    // Everything below is the same account contract ordinary registration
    // applies — reused, never restated, so the two surfaces cannot drift.
    if let Some(rejection) = new_account_input_error(
        &state,
        &body.username,
        &normalized_email,
        &body.password,
        body.display_name.as_deref(),
    ) {
        // The token already checked out, so this is the operator mistyping
        // their own account details, not an attacker: the guard is reserved for
        // the token itself.
        return Err(ApiError::BadRequest(rejection.message));
    }

    let instance_name = paracord_core::instance_setup::validate_instance_name(&body.instance_name)
        .map_err(ApiError::from)?;
    let space_name = paracord_core::instance_setup::validate_space_name(&body.initial_space_name)
        .map_err(ApiError::from)?;

    if !normalized_email.is_empty() {
        let existing = paracord_db::users::get_user_by_email(&state.db, &normalized_email)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if existing.is_some() {
            return Err(ApiError::BadRequest(
                "Unable to complete registration".into(),
            ));
        }
    }
    if username_is_registered(&state, &body.username).await? {
        return Err(ApiError::BadRequest(
            "Unable to complete registration".into(),
        ));
    }

    let password_hash = paracord_core::auth::hash_password(&body.password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // `users.email` is NOT NULL UNIQUE, so an optional-email deployment needs a
    // placeholder at insert time — but the canonical one registration uses is
    // derived from the account's own id, which does not exist yet. Insert a
    // unique temporary address in the same reserved namespace and rewrite it
    // once the row is there (below).
    let outcome = match paracord_core::instance_setup::claim_instance(
        &state.db,
        &body.username,
        &resolve_claim_email(&normalized_email),
        &password_hash,
        &instance_name,
        &space_name,
        body.initial_space_icon.as_deref(),
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(err) => {
            // A racing claim, or a username/e-mail taken underneath us. Neither
            // is a credential guess, so neither feeds the auth guard.
            if registration_identity_taken(&state, &body.username, &normalized_email).await {
                return Err(ApiError::BadRequest(
                    "Unable to complete registration".into(),
                ));
            }
            return Err(ApiError::from(err));
        }
    };

    let mut owner = outcome.owner;

    // Normalize the placeholder to the exact form registration writes.
    //
    // Not fatal if it fails: the account already holds a unique address in the
    // same reserved `.invalid` namespace, so the only casualty is cosmetic
    // consistency between the two shapes — and tearing down a completed claim
    // over that would cost the operator their one bootstrap token. Logged at
    // error so the mismatch is never invisible.
    if normalized_email.is_empty() {
        let placeholder = synthesized_local_email(owner.id);
        if let Err(err) =
            paracord_db::users::update_user_email(&state.db, owner.id, &placeholder).await
        {
            tracing::error!(
                owner_id = owner.id,
                error = %err,
                "failed to normalize the owner's local e-mail placeholder; the account keeps its temporary setup address"
            );
        } else {
            owner.email = placeholder;
        }
    }

    if let Some(display_name) = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        owner =
            paracord_db::users::update_user(&state.db, owner.id, Some(display_name), None, None)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let space_detail = crate::routes::guilds::guild_detail(&outcome.space, 1)?;
    state.member_index.add_member(outcome.space.id, owner.id);
    state.event_bus.dispatch(
        "GUILD_CREATE",
        serde_json::to_value(&space_detail).map_err(|e| ApiError::Internal(e.into()))?,
        Some(outcome.space.id),
    );

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            owner.id,
            owner.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;

    security::log_security_event(
        &state,
        "instance.setup.claimed",
        Some(owner.id),
        Some(owner.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({
            "instance_name": outcome.instance_name,
            "space_id": outcome.space.id.to_string(),
            "token_source": setup.claim_token_source,
        })),
    )
    .await;

    tracing::warn!(
        target: "paracord::setup",
        owner_id = owner.id,
        owner_username = %owner.username,
        space_id = outcome.space.id,
        instance_name = %outcome.instance_name,
        "instance claimed: the bootstrap token is now spent and setup is complete"
    );

    auth_guard_record_success(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&account_hint),
    )
    .await;

    Ok((
        StatusCode::CREATED,
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(ClaimResponse {
            auth: AuthResponse {
                token,
                user: user_json(&owner),
                refresh_token: refresh_token_for_body(
                    &state,
                    &headers,
                    Some(peer_ip.as_str()),
                    raw_refresh,
                ),
            },
            space: space_detail,
            instance_name: outcome.instance_name,
        }),
    ))
}

/// The address stored on the owner row at creation time.
///
/// `users.email` is `NOT NULL UNIQUE`, so an optional-email deployment needs a
/// placeholder. Registration derives it from the user id; the claim cannot know
/// that id before the insert, so it inserts a unique temporary address and
/// rewrites it to the canonical `synthesized_local_email` form immediately
/// afterwards. Both forms live in the same reserved `.invalid` namespace and
/// neither can collide with a real address.
fn resolve_claim_email(normalized_email: &str) -> String {
    if normalized_email.is_empty() {
        format!("setup-{}@paracord.invalid", uuid::Uuid::new_v4().simple())
    } else {
        normalized_email.to_string()
    }
}
