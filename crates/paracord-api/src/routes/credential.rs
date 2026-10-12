//! One password: credential sign-up, sign-in, the v1 move, change, phrase
//! reset, email Start over, the key backup and the credential claim
//! (docs/setup-spec.md §3.3–§3.11, §9.1).
//!
//! The server receives a derived **auth key**, never the password, and keeps
//! `Argon2id(auth_key)` (over the raw 32 bytes) in `users.password_hash`
//! together with the salt and KDF the client derives it with. The identity
//! private key is held only wrapped under a key the server cannot compute
//! (`account_key_backups`). The pure checks and the transactional writes live
//! in `paracord_core::credential`; this file is the HTTP surface: auth guard,
//! invite gate, proofs, sessions and responses.
//!
//! Downgrade resistance (§3.13): `credential_version` only increases (every
//! write is conditional on the version and epoch it started from), the legacy
//! password routes refuse one-password accounts (`credential_upgraded`), and
//! a one-password hash can never be satisfied by a typed password because it
//! is a hash of raw key bytes.

use axum::{
    extract::{ConnectInfo, State},
    http::{header, HeaderMap, StatusCode},
    response::{AppendHeaders, IntoResponse},
    Json,
};
use chrono::Utc;
use paracord_contracts::credential::{
    ChangeCredentialRequest, CredentialClaimRequest, CredentialEmailResetRequest,
    CredentialEpochResponse, CredentialLoginRequest, CredentialParams, CredentialParamsRequest,
    CredentialRegister, CredentialUpgradeRequest, KeyBackup, ResetCredentialRequest,
};
use paracord_core::credential::{self as core_credential, FirstCredential, StartOver};
use paracord_core::AppState;
use paracord_db::credentials::{CredentialRow, VERSION_LEGACY, VERSION_ONE_PASSWORD};
use serde_json::{json, Value};
use std::net::SocketAddr;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::auth::{
    apply_login_gates, auth_guard_enforce, auth_guard_record_failure, auth_guard_record_success,
    auto_join_public_spaces, credential_upgraded, dispatch_email_verification, header_value,
    invite_refusal_counts_against_guard, issue_credential_auth_session, mfa_required_response,
    new_account_identity_error, normalize_backup_code, normalize_email_for_auth,
    normalize_login_identifier_for_auth, parse_username_with_discriminator,
    publish_identity_update, refresh_token_for_body, registration_identity_taken,
    release_signup_slot, reserve_signup_slot, sha256_hex, signup_invite_gate,
    synthesized_local_email, user_auth_json, user_json, username_is_registered,
    username_login_effective, verify_credential_proof, verify_totp_code, AuthResponse, LoginGate,
    PrimaryLoginSnapshot, SETUP_REQUIRED_MESSAGE,
};
use crate::routes::security;

/// Generic sign-up refusal, byte-identical to `POST /auth/register`'s, so no
/// field (username, email, public key) can be probed for existence.
const UNABLE_TO_REGISTER: &str = "Unable to complete registration";

fn internal(err: impl std::fmt::Display) -> ApiError {
    ApiError::Internal(anyhow::anyhow!(err.to_string()))
}

/// 409 `credential_legacy`: the account still uses two passwords; it signs
/// in with `/auth/login` and moves with `/auth/credential/upgrade` (§3.10).
pub(crate) fn credential_legacy() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "credential_legacy",
        message: "This account still uses two passwords. Sign in with your current sign-in password to move it to one password.".into(),
    }
}

/// 409 `credential_key_only`: the account signs in with its identity key
/// and has no password (§3.10, v0 column).
pub(crate) fn credential_key_only() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "credential_key_only",
        message: "This account signs in with its key and has no password.".into(),
    }
}

/// 409 `identity_mismatch`: the identity offered is not the account's.
fn identity_mismatch() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "identity_mismatch",
        message: "This account already has a different identity. Use your recovery phrase, or finish on the device that has your keys.".into(),
    }
}

/// 409 `credential_changed`: the credential changed while this request ran
/// (a concurrent change, reset or move won). Nothing was changed by this one.
fn credential_changed() -> ApiError {
    ApiError::Refused {
        status: StatusCode::CONFLICT,
        code: "credential_changed",
        message: "Your password changed while this was in progress. Sign in again and retry."
            .into(),
    }
}

/// Resolve a sign-in identifier the way `POST /auth/login` does: a username
/// (optionally `name#0001`) when username login is on and there is no `@`,
/// otherwise an email address. An identifier that cannot name an account is
/// simply nobody.
async fn resolve_identifier(
    state: &AppState,
    normalized_identifier: &str,
) -> Result<Option<paracord_db::users::UserAuthRow>, ApiError> {
    if normalized_identifier.is_empty() {
        return Ok(None);
    }
    let allow_username_login = username_login_effective(
        state.config.allow_username_login,
        state.config.require_email,
    );
    if allow_username_login && !normalized_identifier.contains('@') {
        return match parse_username_with_discriminator(normalized_identifier) {
            Some((username, discriminator)) => {
                paracord_db::users::get_user_auth_by_username(&state.db, username, discriminator)
                    .await
            }
            None => {
                paracord_db::users::get_user_auth_by_username_only(&state.db, normalized_identifier)
                    .await
            }
        }
        .map_err(internal);
    }
    let email = normalize_email_for_auth(normalized_identifier);
    if paracord_util::validation::validate_email(&email).is_err() {
        return Ok(None);
    }
    paracord_db::users::get_user_by_email(&state.db, &email)
        .await
        .map_err(internal)
}

async fn credential_row(state: &AppState, user_id: i64) -> Result<CredentialRow, ApiError> {
    paracord_db::credentials::get(&state.db, user_id)
        .await
        .map_err(internal)?
        .ok_or(ApiError::Unauthorized)
}

/// Check the second factor when the account has one (fails closed on a read
/// error, like `apply_login_gates`).
async fn require_second_factor(
    state: &AppState,
    user_id: i64,
    email: &str,
    code: Option<&str>,
) -> Result<(), ApiError> {
    let config = paracord_db::mfa::get_mfa_config(&state.db, user_id)
        .await
        .map_err(internal)?;
    let Some(config) = config.filter(|config| config.enabled) else {
        return Ok(());
    };
    let code = code.map(str::trim).unwrap_or_default();
    if code.is_empty() {
        return Err(ApiError::BadRequest(
            "MFA code required for this change".into(),
        ));
    }
    if verify_totp_code(state, &config, code, email).await? {
        return Ok(());
    }
    let code_hash = sha256_hex(&normalize_backup_code(code));
    if paracord_db::mfa::consume_backup_code(&state.db, user_id, &code_hash, Utc::now())
        .await
        .map_err(internal)?
    {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

async fn begin(state: &AppState) -> Result<core_credential::CredentialTx, ApiError> {
    state
        .db
        .begin()
        .await
        .map_err(|e| ApiError::Internal(e.into()))
}

async fn commit(tx: core_credential::CredentialTx) -> Result<(), ApiError> {
    tx.commit().await.map_err(|e| ApiError::Internal(e.into()))
}

// ---------------------------------------------------------------------------
// Params and sign-in
// ---------------------------------------------------------------------------

/// `POST /api/v1/auth/credential/params` — public (auth bucket).
///
/// The same shape and the same work for every identifier: one user lookup and
/// one credential read (of id 0 when nobody matched), then either the real
/// parameters, `version: 1`, or the default KDF with a fake salt (§3.3).
pub async fn params(
    State(state): State<AppState>,
    Json(body): Json<CredentialParamsRequest>,
) -> Result<Json<CredentialParams>, ApiError> {
    let identifier = normalize_login_identifier_for_auth(&body.identifier);
    if identifier.is_empty() || identifier.len() > 320 {
        return Err(ApiError::BadRequest(
            "Enter a username or email address".into(),
        ));
    }
    let user = resolve_identifier(&state, &identifier).await?;
    let row = paracord_db::credentials::get(&state.db, user.as_ref().map_or(0, |u| u.id))
        .await
        .map_err(internal)?;
    Ok(Json(core_credential::params_for(
        row.as_ref(),
        &state.config.jwt_secret,
        &identifier,
    )))
}

/// `POST /api/v1/auth/credential/login` — public (auth bucket, auth guard).
///
/// The same `LoginResponse` as `/auth/login`, including the MFA ticket branch;
/// `/auth/mfa/login` completes it unchanged (the ticket binds the stored hash).
pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CredentialLoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let identifier = normalize_login_identifier_for_auth(&body.identifier);
    auth_guard_enforce(&state, &headers, Some(peer_ip.as_str()), Some(&identifier)).await?;
    let fail = || async {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), Some(&identifier))
            .await;
        ApiError::Unauthorized
    };

    // A malformed key says nothing about the account, so it is refused before
    // any lookup.
    let Some(auth_key) = core_credential::decode_auth_key(&body.auth_key) else {
        return Err(ApiError::BadRequest(
            "The auth key must be 32 bytes of unpadded base64url.".into(),
        ));
    };
    if identifier.is_empty() {
        core_credential::equalize_auth_key_timing(&auth_key);
        return Err(fail().await);
    }

    let user = resolve_identifier(&state, &identifier).await?;
    let row = paracord_db::credentials::get(&state.db, user.as_ref().map_or(0, |u| u.id))
        .await
        .map_err(internal)?;
    let (Some(user), Some(row)) = (user, row) else {
        core_credential::equalize_auth_key_timing(&auth_key);
        return Err(fail().await);
    };
    match row.version {
        VERSION_ONE_PASSWORD => {}
        VERSION_LEGACY => {
            // `params` already answers `version: 1` for this account, so this
            // reveals nothing new; a current client never sends it.
            auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), Some(&identifier))
                .await;
            return Err(credential_legacy());
        }
        _ => {
            core_credential::equalize_auth_key_timing(&auth_key);
            return Err(fail().await);
        }
    }
    if !core_credential::verify_auth_key(&auth_key, &user.password_hash) {
        return Err(fail().await);
    }

    match apply_login_gates(
        &state,
        user.id,
        user.email_verified,
        &user.email,
        &user.password_hash,
        false,
    )
    .await
    {
        Ok(LoginGate::Proceed) => {}
        Ok(LoginGate::MfaRequired(ticket)) => {
            auth_guard_record_success(&state, &headers, Some(peer_ip.as_str()), Some(&identifier))
                .await;
            return Ok(mfa_required_response(&state, &ticket)?.into_response());
        }
        Err(err) => {
            auth_guard_record_success(&state, &headers, Some(peer_ip.as_str()), Some(&identifier))
                .await;
            return Err(err);
        }
    }

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_credential_auth_session(
            &state,
            PrimaryLoginSnapshot {
                user_id: user.id,
                email: &user.email,
                public_key: user.public_key.as_deref(),
                primary_credential: &user.password_hash,
                public_key_login: false,
                require_verified_email: state.config.require_email_verification,
            },
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.login.credential",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "auth_method": "one_password" })),
    )
    .await;
    auth_guard_record_success(&state, &headers, Some(peer_ip.as_str()), Some(&identifier)).await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_auth_json(&user),
            refresh_token: refresh_token_for_body(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                raw_refresh,
            ),
        }),
    )
        .into_response())
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

/// `POST /api/v1/auth/credential/register` — public (auth bucket, invite gate).
///
/// The same account rules, invite gate and guard bookkeeping as
/// `/auth/register`, plus the credential, the identity proof (purpose
/// `register`) and the key backup, stored together with the account's move to
/// version 2 in one transaction.
pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CredentialRegister>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let normalized_email = normalize_email_for_auth(body.email.as_deref().unwrap_or_default());
    let account_hint = if normalized_email.is_empty() {
        normalize_login_identifier_for_auth(&body.username)
    } else {
        normalized_email.clone()
    };
    let hint = Some(account_hint.as_str());
    let ip = Some(peer_ip.as_str());
    auth_guard_enforce(&state, &headers, ip, hint).await?;

    if paracord_db::instance_setup::is_pending(&state.db)
        .await
        .map_err(internal)?
    {
        return Err(ApiError::Conflict(SETUP_REQUIRED_MESSAGE.into()));
    }
    if !state.runtime.read().await.registration_enabled {
        auth_guard_record_failure(&state, &headers, ip, hint).await;
        return Err(ApiError::Forbidden);
    }
    let signup_invite = match signup_invite_gate(&state, body.invite_code.as_deref()).await {
        Ok(invite) => invite,
        Err(err) => {
            if invite_refusal_counts_against_guard(body.invite_code.as_deref()) {
                auth_guard_record_failure(&state, &headers, ip, hint).await;
            }
            return Err(err);
        }
    };
    if let Some(rejection) = new_account_identity_error(
        &state,
        &body.username,
        &normalized_email,
        body.display_name.as_deref(),
    ) {
        if rejection.counts_against_guard {
            auth_guard_record_failure(&state, &headers, ip, hint).await;
        }
        return Err(ApiError::BadRequest(rejection.message));
    }
    let credential = core_credential::check_credential(&body.credential)?;
    let identity = core_credential::check_identity(&body.identity)?;
    if let Err(err) = verify_credential_proof(
        &state,
        &headers,
        ip,
        core_credential::PURPOSE_REGISTER,
        &identity.public_key,
        &body.identity.proof,
    ) {
        auth_guard_record_failure(&state, &headers, ip, hint).await;
        return Err(err);
    }

    let identity_taken = (!normalized_email.is_empty()
        && paracord_db::users::get_user_by_email(&state.db, &normalized_email)
            .await
            .map_err(internal)?
            .is_some())
        || username_is_registered(&state, &body.username).await?
        || paracord_db::users::get_user_by_public_key(&state.db, &identity.public_key)
            .await
            .map_err(internal)?
            .is_some();
    if identity_taken {
        auth_guard_record_failure(&state, &headers, ip, hint).await;
        return Err(ApiError::BadRequest(UNABLE_TO_REGISTER.into()));
    }

    let password_hash = credential.hash()?;
    let id = paracord_util::snowflake::generate(1);
    let resolved_email = if normalized_email.is_empty() {
        synthesized_local_email(id)
    } else {
        normalized_email.clone()
    };
    reserve_signup_slot(&state, signup_invite.as_ref(), id).await?;
    let created = match paracord_db::users::create_user_as_first_admin(
        &state.db,
        id,
        &body.username,
        0,
        &resolved_email,
        &password_hash,
        paracord_core::USER_FLAG_ADMIN,
    )
    .await
    {
        Ok(user) => user,
        Err(err) => {
            release_signup_slot(&state, signup_invite.as_ref(), id).await;
            if registration_identity_taken(&state, &body.username, &normalized_email).await {
                auth_guard_record_failure(&state, &headers, ip, hint).await;
                return Err(ApiError::BadRequest(UNABLE_TO_REGISTER.into()));
            }
            return Err(internal(err));
        }
    };

    // The row went in as a legacy hash; move it to one password together with
    // the identity and its backup, or take the whole account back out.
    let stored = async {
        let mut tx = begin(&state).await?;
        let outcome = core_credential::store_first_credential(
            &mut tx,
            created.id,
            VERSION_LEGACY,
            Some(&password_hash),
            &credential,
            &password_hash,
            &identity,
            Utc::now(),
        )
        .await?;
        if matches!(outcome, FirstCredential::Stored { .. }) {
            commit(tx).await?;
        }
        Ok::<_, ApiError>(outcome)
    }
    .await;
    if !matches!(stored, Ok(FirstCredential::Stored { .. })) {
        if let Err(err) = paracord_db::users::delete_unused_account(&state.db, created.id).await {
            tracing::error!(user_id = created.id, error = %err, "failed to remove a half-created one-password account");
        }
        if created.flags & paracord_core::USER_FLAG_ADMIN != 0 {
            if let Err(err) = paracord_db::users::release_first_admin_slot(&state.db).await {
                tracing::error!(error = %err, "failed to release the first-admin slot after a failed sign-up");
            }
        }
        release_signup_slot(&state, signup_invite.as_ref(), created.id).await;
        return match stored {
            Ok(FirstCredential::PublicKeyTaken) => {
                auth_guard_record_failure(&state, &headers, ip, hint).await;
                Err(ApiError::BadRequest(UNABLE_TO_REGISTER.into()))
            }
            Ok(_) => Err(internal("a new account changed during sign-up")),
            Err(err) => Err(err),
        };
    }

    auto_join_public_spaces(&state, created.id).await?;
    if let Some(display_name) = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        paracord_db::users::update_user(&state.db, created.id, Some(display_name), None, None)
            .await
            .map_err(internal)?;
    }
    let user = paracord_db::users::get_user_by_id(&state.db, created.id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("the new account disappeared"))?;

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_credential_auth_session(
            &state,
            PrimaryLoginSnapshot {
                user_id: user.id,
                email: &user.email,
                public_key: user.public_key.as_deref(),
                primary_credential: &password_hash,
                public_key_login: false,
                require_verified_email: false,
            },
            &headers,
            ip,
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.register.credential",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        ip,
        Some(json!({ "auth_method": "one_password" })),
    )
    .await;
    if state.config.require_email_verification && !normalized_email.is_empty() {
        dispatch_email_verification(
            &state,
            user.id,
            &user.username,
            &resolved_email,
            &headers,
            ip,
        )
        .await;
    }
    auth_guard_record_success(&state, &headers, ip, hint).await;

    Ok((
        StatusCode::CREATED,
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_json(&user),
            refresh_token: refresh_token_for_body(&state, &headers, ip, raw_refresh),
        }),
    ))
}

// ---------------------------------------------------------------------------
// The v1 move
// ---------------------------------------------------------------------------

/// `POST /api/v1/auth/credential/upgrade` — session (§3.11).
///
/// Checks the legacy sign-in password, then in one transaction moves the
/// account 1 → 2 (`WHERE credential_version = 1` and the hash it verified),
/// sets the identity when the account had none (it must equal the account's
/// identity otherwise; a proof is required either way) and stores the backup.
/// Sessions are kept. Any failure leaves a working v1 account.
pub async fn upgrade(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<CredentialUpgradeRequest>,
) -> Result<Json<CredentialEpochResponse>, ApiError> {
    let peer_ip = addr.ip().to_string();
    let ip = Some(peer_ip.as_str());
    let hint = auth.user_id.to_string();
    auth_guard_enforce(&state, &headers, ip, Some(&hint)).await?;

    let row = credential_row(&state, auth.user_id).await?;
    match row.version {
        VERSION_LEGACY => {}
        VERSION_ONE_PASSWORD => return Err(credential_upgraded()),
        _ => return Err(credential_key_only()),
    }
    if !paracord_core::auth::verify_password(&body.current_password, &row.password_hash)
        .unwrap_or(false)
    {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(ApiError::Unauthorized);
    }
    let credential = core_credential::check_credential(&body.credential)?;
    let identity = core_credential::check_identity(&body.identity)?;
    if row
        .public_key
        .as_deref()
        .is_some_and(|key| !key.eq_ignore_ascii_case(&identity.public_key))
    {
        return Err(identity_mismatch());
    }
    if let Err(err) = verify_credential_proof(
        &state,
        &headers,
        ip,
        core_credential::PURPOSE_REGISTER,
        &identity.public_key,
        &body.identity.proof,
    ) {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(err);
    }

    let password_hash = credential.hash()?;
    let mut tx = begin(&state).await?;
    let outcome = core_credential::store_first_credential(
        &mut tx,
        auth.user_id,
        VERSION_LEGACY,
        Some(&row.password_hash),
        &credential,
        &password_hash,
        &identity,
        Utc::now(),
    )
    .await?;
    let public_key_set = match outcome {
        FirstCredential::Stored { public_key_set } => public_key_set,
        FirstCredential::NotCurrent => {
            drop(tx);
            // Moved by a concurrent request, or the legacy password changed.
            return Err(match credential_row(&state, auth.user_id).await?.version {
                VERSION_ONE_PASSWORD => credential_upgraded(),
                _ => credential_changed(),
            });
        }
        FirstCredential::IdentityMismatch => return Err(identity_mismatch()),
        FirstCredential::PublicKeyTaken => {
            return Err(ApiError::Conflict(
                "This public key is already in use by another account".into(),
            ))
        }
    };
    let observers = if public_key_set {
        paracord_db::users::identity_observer_ids_in_transaction(&mut tx, auth.user_id).await?
    } else {
        Vec::new()
    };
    commit(tx).await?;
    auth_guard_record_success(&state, &headers, ip, Some(&hint)).await;

    if public_key_set {
        if let Some(user) = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
            .await
            .map_err(internal)?
        {
            publish_identity_update(&state, &user, observers);
        }
    }
    security::log_security_event(
        &state,
        "auth.credential.upgrade",
        Some(auth.user_id),
        Some(auth.user_id),
        auth.session_id.as_deref(),
        Some(&headers),
        ip,
        Some(json!({ "public_key_set": public_key_set })),
    )
    .await;
    Ok(Json(CredentialEpochResponse { epoch: 1 }))
}

// ---------------------------------------------------------------------------
// Change and recovery
// ---------------------------------------------------------------------------

/// `PUT /api/v1/users/@me/credential` — session (+MFA when on) (§3.7).
pub async fn change(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<ChangeCredentialRequest>,
) -> Result<Json<CredentialEpochResponse>, ApiError> {
    let peer_ip = addr.ip().to_string();
    let ip = Some(peer_ip.as_str());
    let hint = auth.user_id.to_string();
    auth_guard_enforce(&state, &headers, ip, Some(&hint)).await?;
    let session_id = auth.session_id.as_deref().ok_or(ApiError::Unauthorized)?;

    let row = one_password_row(&state, auth.user_id).await?;
    let Some(current) = core_credential::decode_auth_key(&body.current_auth_key) else {
        return Err(ApiError::BadRequest(
            "The current auth key must be 32 bytes of unpadded base64url.".into(),
        ));
    };
    if !core_credential::verify_auth_key(&current, &row.password_hash) {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(ApiError::Unauthorized);
    }
    let email = account_email(&state, auth.user_id).await?;
    if let Err(err) =
        require_second_factor(&state, auth.user_id, &email, body.mfa_code.as_deref()).await
    {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(err);
    }

    let epoch = replace(
        &state,
        &row,
        session_id,
        &body.credential,
        &body.wrapped_key,
        "password_changed",
    )
    .await?;
    auth_guard_record_success(&state, &headers, ip, Some(&hint)).await;
    security::log_security_event(
        &state,
        "auth.credential.change",
        Some(auth.user_id),
        Some(auth.user_id),
        Some(session_id),
        Some(&headers),
        ip,
        Some(json!({ "epoch": epoch, "revoked_other_sessions": true })),
    )
    .await;
    Ok(Json(CredentialEpochResponse { epoch }))
}

/// `POST /api/v1/users/@me/credential/reset` — session from a key sign-in
/// (§3.8). The proof signs a fresh challenge with purpose `reset` under the
/// account's own identity key: the phrase holder, and only they, can set a new
/// password and backup.
pub async fn reset(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
    Json(body): Json<ResetCredentialRequest>,
) -> Result<Json<CredentialEpochResponse>, ApiError> {
    let peer_ip = addr.ip().to_string();
    let ip = Some(peer_ip.as_str());
    let hint = auth.user_id.to_string();
    auth_guard_enforce(&state, &headers, ip, Some(&hint)).await?;
    let session_id = auth.session_id.as_deref().ok_or(ApiError::Unauthorized)?;

    let row = one_password_row(&state, auth.user_id).await?;
    let public_key = row
        .public_key
        .clone()
        .ok_or_else(|| internal("a one-password account has no identity"))?;
    if let Err(err) = verify_credential_proof(
        &state,
        &headers,
        ip,
        core_credential::PURPOSE_RESET,
        &public_key,
        &body.proof,
    ) {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(err);
    }
    let email = account_email(&state, auth.user_id).await?;
    if let Err(err) =
        require_second_factor(&state, auth.user_id, &email, body.mfa_code.as_deref()).await
    {
        auth_guard_record_failure(&state, &headers, ip, Some(&hint)).await;
        return Err(err);
    }

    let epoch = replace(
        &state,
        &row,
        session_id,
        &body.credential,
        &body.wrapped_key,
        "password_reset",
    )
    .await?;
    auth_guard_record_success(&state, &headers, ip, Some(&hint)).await;
    security::log_security_event(
        &state,
        "auth.credential.reset",
        Some(auth.user_id),
        Some(auth.user_id),
        Some(session_id),
        Some(&headers),
        ip,
        Some(json!({ "epoch": epoch, "revoked_other_sessions": true })),
    )
    .await;
    Ok(Json(CredentialEpochResponse { epoch }))
}

async fn one_password_row(state: &AppState, user_id: i64) -> Result<CredentialRow, ApiError> {
    let row = credential_row(state, user_id).await?;
    match row.version {
        VERSION_ONE_PASSWORD => Ok(row),
        VERSION_LEGACY => Err(credential_legacy()),
        _ => Err(credential_key_only()),
    }
}

async fn account_email(state: &AppState, user_id: i64) -> Result<String, ApiError> {
    Ok(paracord_db::users::get_user_auth_by_id(&state.db, user_id)
        .await
        .map_err(internal)?
        .ok_or(ApiError::Unauthorized)?
        .email)
}

/// Replace the credential and re-wrap the backup of the account's identity,
/// conditional on the epoch and hash `row` was read at.
async fn replace(
    state: &AppState,
    row: &CredentialRow,
    session_id: &str,
    credential: &paracord_contracts::credential::NewCredential,
    wrapped_key: &str,
    reason: &str,
) -> Result<i64, ApiError> {
    let credential = core_credential::check_credential(credential)?;
    let wrapped_key = core_credential::check_wrapped_key(wrapped_key)?;
    let public_key = row
        .public_key
        .as_deref()
        .ok_or_else(|| internal("a one-password account has no identity"))?;
    let password_hash = credential.hash()?;
    let mut tx = begin(state).await?;
    let epoch = core_credential::replace_credential(
        &mut tx,
        row.user_id,
        row.epoch,
        Some(&row.password_hash),
        &credential,
        &password_hash,
        public_key,
        &wrapped_key,
        session_id,
        reason,
        Utc::now(),
    )
    .await?;
    let Some(epoch) = epoch else {
        return Err(credential_changed());
    };
    commit(tx).await?;
    Ok(epoch)
}

/// `POST /api/v1/auth/reset-password` for a one-password account ("Start
/// over", §3.9), called by `auth::reset_password` once the token resolved to
/// this account. The server cannot restore the old identity, so the request
/// carries a brand-new one (proof purpose `reset`, signed by the new key).
pub(crate) async fn start_over_by_email(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: &str,
    user_id: i64,
    token_hash: &str,
    body: CredentialEmailResetRequest,
) -> Result<Json<Value>, ApiError> {
    let ip = Some(peer_ip);
    let credential = core_credential::check_credential(&body.credential)?;
    let identity = core_credential::check_identity(&body.identity)?;
    if let Err(err) = verify_credential_proof(
        state,
        headers,
        ip,
        core_credential::PURPOSE_RESET,
        &identity.public_key,
        &body.identity.proof,
    ) {
        auth_guard_record_failure(state, headers, ip, None).await;
        return Err(err);
    }
    let row = credential_row(state, user_id).await?;
    if row.version != VERSION_ONE_PASSWORD {
        return Err(credential_changed());
    }
    let password_hash = credential.hash()?;
    let mut tx = begin(state).await?;
    let outcome = core_credential::start_over(
        &mut tx,
        user_id,
        token_hash,
        row.epoch,
        &credential,
        &password_hash,
        &identity,
        Utc::now(),
    )
    .await?;
    let epoch = match outcome {
        StartOver::Done { epoch } => epoch,
        StartOver::NotCurrent => {
            drop(tx);
            auth_guard_record_failure(state, headers, ip, None).await;
            return Err(ApiError::BadRequest(
                "Invalid or expired reset token".into(),
            ));
        }
        StartOver::PublicKeyTaken => {
            return Err(ApiError::Conflict(
                "This public key is already in use by another account".into(),
            ))
        }
    };
    let observers =
        paracord_db::users::identity_observer_ids_in_transaction(&mut tx, user_id).await?;
    commit(tx).await?;
    if let Some(user) = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(internal)?
    {
        publish_identity_update(state, &user, observers);
    }
    security::log_security_event(
        state,
        "auth.password_reset.completed",
        Some(user_id),
        Some(user_id),
        None,
        Some(headers),
        ip,
        Some(json!({
            "ip": peer_ip,
            "sessions_revoked": true,
            "identity_replaced": true,
            "epoch": epoch,
        })),
    )
    .await;
    auth_guard_record_success(state, headers, ip, None).await;
    Ok(Json(json!({
        "epoch": epoch,
        "message": "Your account has a new password and a new identity. Sign in with the new password.",
    })))
}

// ---------------------------------------------------------------------------
// Key backup
// ---------------------------------------------------------------------------

/// `GET /api/v1/users/@me/key-backup` — session.
pub async fn get_key_backup(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<KeyBackup>, ApiError> {
    let backup = paracord_db::key_backups::get(&state.db, auth.user_id)
        .await
        .map_err(internal)?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(KeyBackup {
        public_key: backup.public_key,
        wrapped_key: backup.wrapped_key,
        wrap_alg: backup.wrap_alg,
        epoch: backup.credential_epoch,
        recovery_confirmed: backup.recovery_confirmed,
    }))
}

/// `POST /api/v1/users/@me/key-backup/recovery-confirmed` — session.
pub async fn recovery_confirmed(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<StatusCode, ApiError> {
    if paracord_db::key_backups::set_recovery_confirmed(&state.db, auth.user_id, Utc::now())
        .await
        .map_err(internal)?
    {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(ApiError::NotFound)
    }
}

// ---------------------------------------------------------------------------
// Claim
// ---------------------------------------------------------------------------

/// `POST /api/v1/setup/credential-claim` — public, claim token (§2.7, §2.11).
///
/// The legacy claim's checks and guard, with the owner created on one
/// password and the first server built from the template with its hue.
pub async fn claim(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<CredentialClaimRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let ip = Some(peer_ip.as_str());
    let owner = &body.owner;
    let normalized_email = normalize_email_for_auth(owner.email.as_deref().unwrap_or_default());
    let account_hint = if normalized_email.is_empty() {
        normalize_login_identifier_for_auth(&owner.username)
    } else {
        normalized_email.clone()
    };
    let hint = Some(account_hint.as_str());
    auth_guard_enforce(&state, &headers, ip, hint).await?;

    let setup = paracord_db::instance_setup::get(&state.db)
        .await
        .map_err(internal)?;
    if !setup.is_pending() {
        return Err(ApiError::Conflict(
            "This instance has already been set up.".into(),
        ));
    }
    let Some(stored_hash) = setup.claim_token_hash.as_deref() else {
        return Err(ApiError::ServiceUnavailable(
            "This instance has no setup claim token provisioned. Restart it to mint one, or set [setup] claim_token in its configuration.".into(),
        ));
    };
    if !paracord_core::instance_setup::claim_token_matches(body.token.trim(), stored_hash) {
        auth_guard_record_failure(&state, &headers, ip, hint).await;
        security::log_security_event(
            &state,
            "instance.setup.claim.rejected",
            None,
            None,
            None,
            Some(&headers),
            ip,
            Some(json!({ "reason": "invalid_token" })),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    // The token checked out: from here on mistakes are the operator's own, not
    // guesses, so they do not feed the guard (as in the legacy claim).
    if let Some(rejection) = new_account_identity_error(
        &state,
        &owner.username,
        &normalized_email,
        owner.display_name.as_deref(),
    ) {
        return Err(ApiError::BadRequest(rejection.message));
    }
    let instance_name = paracord_core::instance_setup::validate_instance_name(&owner.instance_name)
        .map_err(ApiError::from)?;
    let space_name = paracord_core::instance_setup::validate_space_name(&owner.initial_space_name)
        .map_err(ApiError::from)?;
    let hue = u16::try_from(owner.initial_space_hue)
        .ok()
        .filter(|hue| *hue <= paracord_db::guilds::MAX_HUE)
        .ok_or_else(|| ApiError::BadRequest("hue must be between 0 and 359".into()))?;
    let credential = core_credential::check_credential(&owner.credential)?;
    let identity = core_credential::check_identity(&owner.identity)?;
    verify_credential_proof(
        &state,
        &headers,
        ip,
        core_credential::PURPOSE_REGISTER,
        &identity.public_key,
        &owner.identity.proof,
    )?;

    if (!normalized_email.is_empty()
        && paracord_db::users::get_user_by_email(&state.db, &normalized_email)
            .await
            .map_err(internal)?
            .is_some())
        || username_is_registered(&state, &owner.username).await?
    {
        return Err(ApiError::BadRequest(UNABLE_TO_REGISTER.into()));
    }

    if let Some(mode) = owner.registration_mode {
        let mode = paracord_core::registration::RegistrationMode::from(mode);
        paracord_db::server_settings::set_setting(&state.db, "registration_mode", mode.as_str())
            .await
            .map_err(internal)?;
        state.runtime.write().await.registration_mode = mode;
    }

    let outcome = match paracord_core::instance_setup::claim_instance_one_password(
        &state.db,
        &owner.username,
        &crate::routes::setup::resolve_claim_email(&normalized_email),
        &credential,
        &identity,
        &instance_name,
        &space_name,
        owner.initial_space_icon.as_deref(),
        hue,
        owner.initial_space_template,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(err) => {
            if registration_identity_taken(&state, &owner.username, &normalized_email).await {
                return Err(ApiError::BadRequest(UNABLE_TO_REGISTER.into()));
            }
            return Err(ApiError::from(err));
        }
    };

    let mut account = outcome.owner;
    if normalized_email.is_empty() {
        let placeholder = synthesized_local_email(account.id);
        match paracord_db::users::update_user_email(&state.db, account.id, &placeholder).await {
            Ok(_) => account.email = placeholder,
            Err(err) => tracing::error!(
                owner_id = account.id,
                error = %err,
                "failed to normalize the owner's local e-mail placeholder; the account keeps its temporary setup address"
            ),
        }
    }
    if let Some(display_name) = owner
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        account =
            paracord_db::users::update_user(&state.db, account.id, Some(display_name), None, None)
                .await
                .map_err(internal)?;
    }
    let password_hash = paracord_db::credentials::get(&state.db, account.id)
        .await
        .map_err(internal)?
        .ok_or_else(|| internal("the new owner disappeared"))?
        .password_hash;

    let space_detail = crate::routes::guilds::guild_detail(&outcome.space, 1)?;
    state.member_index.add_member(outcome.space.id, account.id);
    state.event_bus.dispatch(
        "GUILD_CREATE",
        serde_json::to_value(&space_detail).map_err(|e| ApiError::Internal(e.into()))?,
        Some(outcome.space.id),
    );

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_credential_auth_session(
            &state,
            PrimaryLoginSnapshot {
                user_id: account.id,
                email: &account.email,
                public_key: account.public_key.as_deref(),
                primary_credential: &password_hash,
                public_key_login: false,
                require_verified_email: false,
            },
            &headers,
            ip,
        )
        .await?;
    security::log_security_event(
        &state,
        "instance.setup.claimed",
        Some(account.id),
        Some(account.id),
        Some(&session_id),
        Some(&headers),
        ip,
        Some(json!({
            "instance_name": outcome.instance_name,
            "space_id": outcome.space.id.to_string(),
            "token_source": setup.claim_token_source,
            "auth_method": "one_password",
        })),
    )
    .await;
    tracing::info!(
        target: "paracord::setup",
        owner_id = account.id,
        space_id = outcome.space.id,
        "instance claimed with one password: the bootstrap token is now spent and setup is complete"
    );
    auth_guard_record_success(&state, &headers, ip, hint).await;

    Ok((
        StatusCode::CREATED,
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(crate::routes::setup::ClaimResponse {
            auth: AuthResponse {
                token,
                user: user_json(&account),
                refresh_token: refresh_token_for_body(&state, &headers, ip, raw_refresh),
            },
            space: space_detail,
            instance_name: outcome.instance_name,
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refusals_carry_their_codes() {
        for (err, status, code) in [
            (
                credential_legacy(),
                StatusCode::CONFLICT,
                "credential_legacy",
            ),
            (
                credential_key_only(),
                StatusCode::CONFLICT,
                "credential_key_only",
            ),
            (
                credential_upgraded(),
                StatusCode::CONFLICT,
                "credential_upgraded",
            ),
            (
                crate::routes::auth::client_update_required(),
                StatusCode::GONE,
                "client_update_required",
            ),
        ] {
            let response = err.into_response();
            assert_eq!(response.status(), status, "{code}");
        }
    }
}
