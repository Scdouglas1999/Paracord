use axum::{
    body::to_bytes,
    extract::{ConnectInfo, Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{AppendHeaders, IntoResponse},
    Json,
};
use chrono::{Duration, Utc};
use lettre::message::Mailbox;
use lettre::transport::smtp::authentication::Credentials;
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use moka::sync::Cache;
use paracord_core::AppState;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration as StdDuration;
use totp_rs;
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::security;

const REFRESH_COOKIE_NAME: &str = "paracord_refresh";
const REFRESH_COOKIE_PATH: &str = "/api/v1/auth";
const ACCESS_COOKIE_NAME: &str = "paracord_access";
const ACCESS_COOKIE_PATH: &str = "/api/v1";
const CSRF_COOKIE_NAME: &str = "paracord_csrf";
const CSRF_COOKIE_PATH: &str = "/";
const CHALLENGE_STORE_MAX_ENTRIES: usize = 10_000;
const CHALLENGE_STORE_TTL_SECONDS: u64 = 120;
// Maximum age of a challenge, measured from the trusted server-issued timestamp.
// Enforced independently of the cache TTL (which is deliberately longer to bound
// memory) so a nonce that lingers in the cache still expires as a credential.
const CHALLENGE_MAX_AGE_SECONDS: i64 = 60;
// Acceptable skew between the client-echoed timestamp and the server-issued one.
// The client echoes the exact issued timestamp, so a tight bound is safe.
const CHALLENGE_SKEW_SECONDS: i64 = 5;
const MAX_DISPLAY_NAME_LEN: usize = 64;
const AUTH_GUARD_TTL_SECONDS: i64 = 3600;
const AUTH_GUARD_CLEANUP_LIMIT: i64 = 512;
const MAX_LOGIN_BODY_BYTES: usize = 16 * 1024;

// In-memory challenge nonce store (nonce -> timestamp).
static CHALLENGE_STORE: OnceLock<Cache<String, i64>> = OnceLock::new();
// Superseded refresh hashes (old hash -> session id) for reuse detection between
// rotations when the DB row has not yet been updated. Durable detection uses
// auth_sessions.previous_refresh_token_hash; see sessions.rs.
static SUPERSEDED_REFRESH_HASHES: OnceLock<Cache<String, String>> = OnceLock::new();
static AUTH_GUARD_OP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn challenge_store() -> &'static Cache<String, i64> {
    CHALLENGE_STORE.get_or_init(|| {
        Cache::builder()
            .max_capacity(CHALLENGE_STORE_MAX_ENTRIES as u64)
            .time_to_live(StdDuration::from_secs(CHALLENGE_STORE_TTL_SECONDS))
            .build()
    })
}

fn superseded_refresh_hashes() -> &'static Cache<String, String> {
    SUPERSEDED_REFRESH_HASHES.get_or_init(|| {
        let ttl_days = refresh_session_ttl_days();
        Cache::builder()
            .max_capacity(100_000)
            .time_to_live(StdDuration::from_secs(
                ttl_days.saturating_mul(24 * 60 * 60) as u64,
            ))
            .build()
    })
}

fn track_superseded_refresh_hash(old_hash: &str, session_id: &str) {
    superseded_refresh_hashes().insert(old_hash.to_string(), session_id.to_string());
}

fn validate_public_key_hex(public_key: &str) -> Result<(), ApiError> {
    if public_key.len() != 64 || !public_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "Invalid public key format (expected 64 hex characters)".into(),
        ));
    }
    Ok(())
}

fn verify_pubkey_challenge_proof(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
    public_key: &str,
    nonce: &str,
    timestamp: i64,
    signature: &str,
) -> Result<(), ApiError> {
    validate_public_key_hex(public_key)?;

    let issued_at = match challenge_store().remove(nonce) {
        Some(issued_at) => issued_at,
        None => return Err(ApiError::Unauthorized),
    };

    let now = Utc::now().timestamp();
    if now - issued_at > CHALLENGE_MAX_AGE_SECONDS
        || (timestamp - issued_at).abs() > CHALLENGE_SKEW_SECONDS
    {
        return Err(ApiError::Unauthorized);
    }

    let server_origin = resolve_server_origin(
        state.config.public_url.as_deref(),
        headers,
        peer_ip,
    );

    let valid = paracord_core::auth::verify_challenge(
        public_key,
        nonce,
        timestamp,
        &server_origin,
        signature,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if valid {
        Ok(())
    } else {
        Err(ApiError::Unauthorized)
    }
}

async fn handle_refresh_token_reuse(
    state: &AppState,
    session_id: &str,
    headers: Option<&HeaderMap>,
    peer_ip: Option<&str>,
) -> Result<(), ApiError> {
    let now = Utc::now();
    let session = paracord_db::sessions::get_session_by_id(&state.db, session_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .filter(|row| row.revoked_at.is_none() && row.expires_at > now);
    let Some(session) = session else {
        return Ok(());
    };

    tracing::warn!(
        target: "paracord::auth",
        session_id = %session.id,
        user_id = session.user_id,
        "auth.refresh.reuse"
    );
    let _ = paracord_db::sessions::revoke_all_sessions_for_refresh_reuse(
        &state.db,
        session.user_id,
        now,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    security::log_security_event(
        state,
        "auth.refresh.reuse",
        Some(session.user_id),
        Some(session.user_id),
        Some(&session.id),
        headers,
        peer_ip,
        None,
    )
    .await;

    Ok(())
}

fn constant_time_equal(a: &str, b: &str) -> bool {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    if a_bytes.len() != b_bytes.len() {
        return false;
    }
    let mut diff = 0u8;
    for i in 0..a_bytes.len() {
        diff |= a_bytes[i] ^ b_bytes[i];
    }
    diff == 0
}

fn trust_proxy_headers() -> bool {
    std::env::var("PARACORD_TRUST_PROXY")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false)
}

fn proxy_peer_is_trusted(peer_ip: Option<&str>) -> bool {
    if !trust_proxy_headers() {
        return false;
    }
    let Some(peer_ip) = peer_ip else {
        return false;
    };
    let trusted = std::env::var("PARACORD_TRUSTED_PROXY_IPS")
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    !trusted.is_empty() && trusted.iter().any(|ip| ip == peer_ip)
}

fn resolve_client_ip(headers: &HeaderMap, peer_ip: Option<&str>) -> String {
    if proxy_peer_is_trusted(peer_ip) {
        if let Some(ip) = headers
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
        {
            return ip.to_string();
        }
    }
    peer_ip.unwrap_or("unknown").to_string()
}

fn auth_guard_keys(
    headers: &HeaderMap,
    peer_ip: Option<&str>,
    account_hint: Option<&str>,
) -> Vec<String> {
    let mut keys = Vec::new();
    let ip = resolve_client_ip(headers, peer_ip);
    keys.push(format!("ip:{ip}"));

    if let Some(device_id) = headers
        .get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        keys.push(format!("device:{device_id}"));
    } else if let Some(user_agent) = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        keys.push(format!("ua:{user_agent}"));
    }

    if let Some(account) = account_hint.map(str::trim).filter(|v| !v.is_empty()) {
        keys.push(format!("acct:{}", account.to_ascii_lowercase()));
    }
    keys
}

fn challenge_bypass_enabled_and_valid(headers: &HeaderMap) -> bool {
    let Ok(secret) = std::env::var("PARACORD_AUTH_CHALLENGE_TOKEN") else {
        return false;
    };
    if secret.trim().is_empty() {
        return false;
    }
    headers
        .get("x-paracord-auth-challenge")
        .and_then(|v| v.to_str().ok())
        .map(|provided| constant_time_equal(provided, &secret))
        .unwrap_or(false)
}

async fn auth_guard_maybe_cleanup(state: &AppState, now: i64) {
    let op = AUTH_GUARD_OP_COUNTER
        .fetch_add(1, Ordering::Relaxed)
        .saturating_add(1);
    if op % 64 != 0 {
        return;
    }
    let cutoff = now.saturating_sub(AUTH_GUARD_TTL_SECONDS);
    if let Err(err) = paracord_db::rate_limits::purge_auth_guard_older_than(
        &state.db,
        cutoff,
        AUTH_GUARD_CLEANUP_LIMIT,
    )
    .await
    {
        tracing::warn!("auth-guard cleanup failed: {}", err);
    }
}

async fn auth_guard_enforce(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
    account_hint: Option<&str>,
) -> Result<(), ApiError> {
    let now = Utc::now().timestamp();
    let keys = auth_guard_keys(headers, peer_ip, account_hint);
    let rows = paracord_db::rate_limits::get_auth_guard_states(&state.db, &keys)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let locked = rows.iter().any(|row| row.locked_until > now);
    if locked && !challenge_bypass_enabled_and_valid(headers) {
        return Err(ApiError::RateLimited(0));
    }

    auth_guard_maybe_cleanup(state, now).await;
    Ok(())
}

async fn auth_guard_record_failure(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
    account_hint: Option<&str>,
) {
    let now = Utc::now().timestamp();
    let keys = auth_guard_keys(headers, peer_ip, account_hint);
    for key in keys {
        if let Err(err) =
            paracord_db::rate_limits::record_auth_guard_failure(&state.db, &key, now).await
        {
            tracing::warn!("auth-guard failure update failed for '{}': {}", key, err);
        }
    }
    auth_guard_maybe_cleanup(state, now).await;
}

async fn auth_guard_record_success(
    state: &AppState,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
    account_hint: Option<&str>,
) {
    let keys = auth_guard_keys(headers, peer_ip, account_hint);
    if let Err(err) = paracord_db::rate_limits::clear_auth_guard_keys(&state.db, &keys).await {
        tracing::warn!("auth-guard success clear failed: {}", err);
    }
}

fn refresh_session_ttl_days() -> i64 {
    std::env::var("PARACORD_REFRESH_SESSION_TTL_DAYS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 365))
        .unwrap_or(30)
}

fn normalize_email_for_auth(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn username_login_effective(allow_username_login: bool, require_email: bool) -> bool {
    allow_username_login || !require_email
}

fn normalize_login_identifier_for_auth(value: &str) -> String {
    value.trim().to_ascii_lowercase()
}

fn parse_bool_env(name: &str, default: bool) -> bool {
    env::var(name)
        .ok()
        .map(|raw| {
            let normalized = raw.trim().to_ascii_lowercase();
            matches!(normalized.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(default)
}

fn parse_u16_env(name: &str, default: u16) -> u16 {
    env::var(name)
        .ok()
        .and_then(|raw| raw.trim().parse::<u16>().ok())
        .unwrap_or(default)
}

#[derive(Clone, Debug)]
struct SmtpConfig {
    host: String,
    port: u16,
    username: Option<String>,
    password: Option<String>,
    from: Mailbox,
    starttls: bool,
}

fn load_smtp_config() -> Result<Option<SmtpConfig>, ApiError> {
    let host = env::var("PARACORD_SMTP_HOST")
        .ok()
        .map(|raw| raw.trim().to_string())
        .unwrap_or_default();
    if host.is_empty() {
        return Ok(None);
    }

    let from_raw = env::var("PARACORD_SMTP_FROM")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| "Paracord <no-reply@localhost>".to_string());
    let from = from_raw.parse::<Mailbox>().map_err(|err| {
        ApiError::Internal(anyhow::anyhow!(
            "invalid PARACORD_SMTP_FROM mailbox '{}': {}",
            from_raw,
            err
        ))
    })?;

    let username = env::var("PARACORD_SMTP_USERNAME")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty());
    let password = env::var("PARACORD_SMTP_PASSWORD")
        .ok()
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty());

    Ok(Some(SmtpConfig {
        host,
        port: parse_u16_env("PARACORD_SMTP_PORT", 587),
        username,
        password,
        from,
        starttls: parse_bool_env("PARACORD_SMTP_STARTTLS", true),
    }))
}

fn recipient_mailbox(address: &str) -> Option<Mailbox> {
    let trimmed = address.trim();
    if trimmed.is_empty() || trimmed.ends_with("@local.invalid") || trimmed.ends_with("@pubkey") {
        return None;
    }
    trimmed.parse::<Mailbox>().ok()
}

async fn send_transactional_email(
    recipient: &str,
    subject: &str,
    text_body: &str,
) -> Result<bool, ApiError> {
    let Some(to) = recipient_mailbox(recipient) else {
        return Ok(false);
    };

    let Some(config) = load_smtp_config()? else {
        return Ok(false);
    };

    let email = Message::builder()
        .from(config.from.clone())
        .to(to)
        .subject(subject)
        .body(text_body.to_string())
        .map_err(|err| {
            ApiError::Internal(anyhow::anyhow!("failed to build smtp message: {}", err))
        })?;

    let mut builder = if config.starttls {
        AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.host).map_err(|err| {
            ApiError::Internal(anyhow::anyhow!("invalid smtp relay host: {}", err))
        })?
    } else {
        AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&config.host)
    };

    builder = builder.port(config.port);
    if let (Some(username), Some(password)) = (config.username, config.password) {
        builder = builder.credentials(Credentials::new(username, password));
    }

    let transport = builder.build();
    transport.send(email).await.map_err(|err| {
        ApiError::Internal(anyhow::anyhow!(
            "failed sending transactional email via smtp host '{}': {}",
            config.host,
            err
        ))
    })?;

    Ok(true)
}

fn first_non_whitespace_byte(bytes: &[u8]) -> Option<u8> {
    bytes
        .iter()
        .copied()
        .find(|b| !matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
}

fn legacy_login_parser_enabled() -> bool {
    std::env::var("PARACORD_AUTH_LOGIN_LEGACY_PARSER")
        .ok()
        .map(|raw| {
            let normalized = raw.trim().to_ascii_lowercase();
            normalized == "1" || normalized == "true"
        })
        .unwrap_or(false)
}

fn parse_login_json_value(value: Value) -> Option<LoginRequest> {
    let root = value.as_object()?;

    let source = if root.contains_key("identifier")
        || root.contains_key("email")
        || root.contains_key("username")
        || root.contains_key("login")
        || root.contains_key("password")
    {
        root
    } else {
        root.get("data")
            .and_then(Value::as_object)
            .or_else(|| root.get("payload").and_then(Value::as_object))
            .or_else(|| root.get("credentials").and_then(Value::as_object))
            .unwrap_or(root)
    };

    let identifier = source
        .get("identifier")
        .or_else(|| source.get("email"))
        .or_else(|| source.get("username"))
        .or_else(|| source.get("login"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let password = source
        .get("password")
        .or_else(|| source.get("passphrase"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    Some(LoginRequest {
        email: identifier,
        password,
    })
}

fn parse_login_form_value(body: &[u8]) -> Option<LoginRequest> {
    let mut identifier = String::new();
    let mut password = String::new();

    for (key, value) in url::form_urlencoded::parse(body) {
        match key.as_ref() {
            "identifier" | "email" | "username" | "login" if identifier.is_empty() => {
                identifier = value.into_owned();
            }
            "password" | "passphrase" if password.is_empty() => {
                password = value.into_owned();
            }
            _ => {}
        }
    }

    if identifier.is_empty() && password.is_empty() {
        return None;
    }

    Some(LoginRequest {
        email: identifier,
        password,
    })
}

fn parse_login_request(headers: &HeaderMap, body: &[u8]) -> Option<LoginRequest> {
    if let Ok(parsed) = serde_json::from_slice::<LoginRequest>(body) {
        return Some(parsed);
    }

    if !legacy_login_parser_enabled() {
        return None;
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    let first_byte = first_non_whitespace_byte(body);
    let looks_like_json = matches!(first_byte, Some(b'{') | Some(b'['));

    if content_type.contains("json") || looks_like_json {
        if let Ok(value) = serde_json::from_slice::<Value>(body) {
            if let Some(parsed) = parse_login_json_value(value) {
                return Some(parsed);
            }
        }
    }

    if content_type.contains("x-www-form-urlencoded") || body.contains(&b'=') {
        if let Some(parsed) = parse_login_form_value(body) {
            return Some(parsed);
        }
    }

    serde_json::from_slice::<LoginRequest>(body).ok()
}

fn parse_username_with_discriminator(identifier: &str) -> Option<(&str, i16)> {
    let (username, discriminator) = identifier.rsplit_once('#')?;
    let username = username.trim();
    if username.is_empty() {
        return None;
    }
    let discriminator = discriminator.trim().parse::<i16>().ok()?;
    Some((username, discriminator))
}

fn synthesized_local_email(user_id: i64) -> String {
    format!("u{user_id}@local.invalid")
}

fn should_use_secure_cookie_with_public_url(public_url: Option<&str>) -> bool {
    if let Ok(raw) = std::env::var("PARACORD_COOKIE_SECURE") {
        let lower = raw.trim().to_ascii_lowercase();
        if lower == "1" || lower == "true" {
            return true;
        }
        if lower == "0" || lower == "false" {
            return false;
        }
    }
    if let Ok(raw) = std::env::var("PARACORD_TLS_ENABLED") {
        let lower = raw.trim().to_ascii_lowercase();
        if lower == "1" || lower == "true" {
            return true;
        }
        if lower == "0" || lower == "false" {
            return false;
        }
    }
    public_url
        .map(|url| url.starts_with("https://"))
        .unwrap_or(false)
}

fn should_use_secure_cookie(state: &AppState) -> bool {
    should_use_secure_cookie_with_public_url(state.config.public_url.as_deref())
}

fn normalize_public_origin(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    let parsed = url::Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return None;
    }
    let host = parsed.host_str()?;
    let mut origin = format!("{scheme}://{host}");
    if let Some(port) = parsed.port() {
        origin.push(':');
        origin.push_str(&port.to_string());
    }
    Some(origin)
}

fn normalize_host_header_value(value: &str) -> Option<String> {
    let first = value.split(',').next()?.trim();
    if first.is_empty() {
        return None;
    }
    let without_scheme = first
        .trim_start_matches("http://")
        .trim_start_matches("https://");
    let host = without_scheme.split('/').next()?.trim();
    if host.is_empty() {
        return None;
    }
    Some(host.to_string())
}

fn parse_forwarded_proto(value: &str) -> Option<&'static str> {
    let first = value.split(',').next()?.trim().to_ascii_lowercase();
    match first.as_str() {
        "https" | "wss" => Some("https"),
        "http" | "ws" => Some("http"),
        _ => None,
    }
}

fn default_server_scheme_from_env() -> &'static str {
    if let Ok(raw) = std::env::var("PARACORD_TLS_ENABLED") {
        let lower = raw.trim().to_ascii_lowercase();
        if lower == "1" || lower == "true" {
            return "https";
        }
        if lower == "0" || lower == "false" {
            return "http";
        }
    }
    "http"
}

fn resolve_server_origin(
    configured_public_url: Option<&str>,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) -> String {
    if let Some(origin) = configured_public_url.and_then(normalize_public_origin) {
        return origin;
    }

    let trusted_proxy = proxy_peer_is_trusted(peer_ip);
    let host = if trusted_proxy {
        headers
            .get("x-forwarded-host")
            .and_then(|v| v.to_str().ok())
            .and_then(normalize_host_header_value)
    } else {
        None
    }
    .or_else(|| {
        headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .and_then(normalize_host_header_value)
    })
    .unwrap_or_else(|| "localhost".to_string());

    let scheme = if trusted_proxy {
        headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .and_then(parse_forwarded_proto)
    } else {
        None
    }
    .unwrap_or_else(default_server_scheme_from_env);

    format!("{scheme}://{host}")
}

/// Resolve an origin that is safe to embed in outbound messages (verification
/// and password-reset emails) delivered to an account owner.
///
/// Unlike [`resolve_server_origin`], this NEVER falls back to a client-supplied
/// `Host`/`X-Forwarded-Host` header from an untrusted peer: the resulting URL
/// carries a bearer token and is sent to the victim, so a poisoned `Host`
/// (classic host-header injection) would leak that token to an attacker's
/// server. Only a configured `public_url`, or headers presented via a trusted
/// proxy, are honored. Returns `None` when no trusted origin is available, in
/// which case the caller must skip sending the link rather than emit an
/// attacker-controlled URL.
fn resolve_outbound_link_origin(
    configured_public_url: Option<&str>,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) -> Option<String> {
    if let Some(origin) = configured_public_url.and_then(normalize_public_origin) {
        return Some(origin);
    }

    // Without a configured public_url, only a trusted proxy may dictate the
    // host/scheme for links we mail to users.
    if !proxy_peer_is_trusted(peer_ip) {
        return None;
    }

    let host = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
        .and_then(normalize_host_header_value)
        .or_else(|| {
            headers
                .get(header::HOST)
                .and_then(|v| v.to_str().ok())
                .and_then(normalize_host_header_value)
        })?;

    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(parse_forwarded_proto)
        .unwrap_or_else(default_server_scheme_from_env);

    Some(format!("{scheme}://{host}"))
}

fn build_refresh_cookie(token: &str, ttl_days: i64, secure: bool) -> String {
    let max_age = ttl_days.saturating_mul(24 * 60 * 60);
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}={value}; HttpOnly; Path={path}; SameSite=Lax; Max-Age={max_age}{secure}",
        name = REFRESH_COOKIE_NAME,
        value = token,
        path = REFRESH_COOKIE_PATH,
        max_age = max_age,
        secure = secure_attr,
    )
}

fn build_access_cookie(token: &str, ttl_seconds: u64, secure: bool) -> String {
    let max_age = ttl_seconds;
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}={value}; HttpOnly; Path={path}; SameSite=Lax; Max-Age={max_age}{secure}",
        name = ACCESS_COOKIE_NAME,
        value = token,
        path = ACCESS_COOKIE_PATH,
        max_age = max_age,
        secure = secure_attr,
    )
}

fn build_csrf_cookie(token: &str, ttl_seconds: u64, secure: bool) -> String {
    let max_age = ttl_seconds;
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}={value}; Path={path}; SameSite=Lax; Max-Age={max_age}{secure}",
        name = CSRF_COOKIE_NAME,
        value = token,
        path = CSRF_COOKIE_PATH,
        max_age = max_age,
        secure = secure_attr,
    )
}

fn build_refresh_cookie_clear(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}=; HttpOnly; Path={path}; SameSite=Lax; Max-Age=0{secure}",
        name = REFRESH_COOKIE_NAME,
        path = REFRESH_COOKIE_PATH,
        secure = secure_attr,
    )
}

fn build_access_cookie_clear(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}=; HttpOnly; Path={path}; SameSite=Lax; Max-Age=0{secure}",
        name = ACCESS_COOKIE_NAME,
        path = ACCESS_COOKIE_PATH,
        secure = secure_attr,
    )
}

fn build_csrf_cookie_clear(secure: bool) -> String {
    let secure_attr = if secure { "; Secure" } else { "" };
    format!(
        "{name}=; Path={path}; SameSite=Lax; Max-Age=0{secure}",
        name = CSRF_COOKIE_NAME,
        path = CSRF_COOKIE_PATH,
        secure = secure_attr,
    )
}

fn get_cookie_value(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name == cookie_name {
            return Some(value.to_string());
        }
    }
    None
}

fn random_token_hex(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    rand::thread_rng().fill_bytes(&mut buf);
    let mut out = String::with_capacity(bytes * 2);
    for b in &buf {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

fn sha256_hex(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Generate an email-verification token, persist it, and email the recipient a
/// fresh verification link (mirrors the registration flow). Failures to persist
/// the token or deliver the message are logged and swallowed so they never block
/// the surrounding account operation.
pub(crate) async fn dispatch_email_verification(
    state: &AppState,
    user_id: i64,
    username: &str,
    recipient_email: &str,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) {
    let verify_token = random_token_hex(32);
    let verify_token_hash = sha256_hex(&verify_token);
    let verify_expires = Utc::now() + Duration::hours(EMAIL_VERIFY_TOKEN_TTL_HOURS);
    if let Err(err) = paracord_db::users::create_email_verification_token(
        &state.db,
        user_id,
        &verify_token_hash,
        verify_expires,
    )
    .await
    {
        tracing::error!(
            target: "paracord::email_verification",
            user_id,
            error = %err,
            "Failed to persist email verification token"
        );
        return;
    }

    let Some(server_origin) =
        resolve_outbound_link_origin(state.config.public_url.as_deref(), headers, peer_ip)
    else {
        tracing::warn!(
            target: "paracord::email_verification",
            user_id,
            username = %username,
            email = %recipient_email,
            "Email verification link skipped: no trusted public origin (set public_url or trust a proxy)"
        );
        return;
    };
    let verify_url = format!(
        "{}/api/v1/auth/verify-email?token={}",
        server_origin, verify_token
    );
    let subject = "Verify your Paracord email";
    let body = format!(
        "Hi {},\n\nVerify your email by opening this link:\n{}\n\nThis link expires in {} hours.\n\nIf you did not request this change, ignore this message.",
        username, verify_url, EMAIL_VERIFY_TOKEN_TTL_HOURS
    );
    match send_transactional_email(recipient_email, subject, &body).await {
        Ok(true) => {
            tracing::info!(
                target: "paracord::email_verification",
                user_id,
                username = %username,
                email = %recipient_email,
                "Sent email verification message"
            );
        }
        Ok(false) => {
            tracing::warn!(
                target: "paracord::email_verification",
                user_id,
                username = %username,
                email = %recipient_email,
                "Email verification SMTP delivery skipped (recipient or SMTP config unavailable)"
            );
        }
        Err(err) => {
            tracing::error!(
                target: "paracord::email_verification",
                user_id,
                username = %username,
                email = %recipient_email,
                error = %err,
                "Failed to send email verification message"
            );
        }
    }
}

fn header_value(value: &str) -> Result<HeaderValue, ApiError> {
    HeaderValue::from_str(value)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("invalid header value: {}", e)))
}

fn request_metadata(
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) -> (Option<String>, Option<String>, Option<String>) {
    let device_id = headers
        .get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);
    let ip_address = Some(resolve_client_ip(headers, peer_ip)).filter(|v| v != "unknown");
    (device_id, user_agent, ip_address)
}

/// Result of issuing a new auth session:
/// (access_token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh_token)
async fn issue_auth_session(
    state: &AppState,
    user_id: i64,
    public_key: Option<&str>,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) -> Result<(String, String, String, String, String, String), ApiError> {
    let session_id = Uuid::new_v4().to_string();
    let jti = Uuid::new_v4().to_string();
    let refresh_token = random_token_hex(48);
    let refresh_token_hash = sha256_hex(&refresh_token);
    let ttl_days = refresh_session_ttl_days();
    let now = Utc::now();
    let expires_at = now + Duration::days(ttl_days);
    let (device_id, user_agent, ip_address) = request_metadata(headers, peer_ip);

    paracord_db::sessions::create_session(
        &state.db,
        &session_id,
        user_id,
        &refresh_token_hash,
        &jti,
        public_key,
        device_id.as_deref(),
        user_agent.as_deref(),
        ip_address.as_deref(),
        expires_at,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let access_token = paracord_core::auth::create_session_token(
        user_id,
        public_key,
        &state.config.jwt_secret,
        state.config.jwt_expiry_seconds,
        &session_id,
        &jti,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let secure = should_use_secure_cookie(state);
    let access_cookie = build_access_cookie(&access_token, state.config.jwt_expiry_seconds, secure);
    let refresh_cookie = build_refresh_cookie(&refresh_token, ttl_days, secure);
    let csrf_token = random_token_hex(24);
    let csrf_cookie = build_csrf_cookie(&csrf_token, state.config.jwt_expiry_seconds, secure);
    Ok((
        access_token,
        access_cookie,
        refresh_cookie,
        csrf_cookie,
        session_id,
        refresh_token,
    ))
}

/// Result: (access_token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_new_refresh_token)
async fn rotate_auth_session(
    state: &AppState,
    refresh_token: &str,
    headers: Option<&HeaderMap>,
    peer_ip: Option<&str>,
) -> Result<(String, String, String, String, String, String), ApiError> {
    let refresh_hash = sha256_hex(refresh_token);
    let now = Utc::now();
    let session = match paracord_db::sessions::get_session_by_refresh_hash(&state.db, &refresh_hash)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        Some(session) => session,
        None => {
            if let Some(session) = paracord_db::sessions::get_session_by_superseded_refresh_hash(
                &state.db,
                &refresh_hash,
                now,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            {
                handle_refresh_token_reuse(state, &session.id, headers, peer_ip).await?;
            } else if let Some(session_id) = superseded_refresh_hashes().get(&refresh_hash) {
                handle_refresh_token_reuse(state, &session_id, headers, peer_ip).await?;
            }
            return Err(ApiError::Unauthorized);
        }
    };
    if session.revoked_at.is_some() || session.expires_at <= now {
        return Err(ApiError::Unauthorized);
    }

    let new_refresh = random_token_hex(48);
    let new_refresh_hash = sha256_hex(&new_refresh);
    let new_jti = Uuid::new_v4().to_string();
    let ttl_days = refresh_session_ttl_days();
    let new_expires = now + Duration::days(ttl_days);
    let rotated = paracord_db::sessions::rotate_session_refresh_token(
        &state.db,
        &session.id,
        &refresh_hash,
        &new_refresh_hash,
        &new_jti,
        now,
        new_expires,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !rotated {
        return Err(ApiError::Unauthorized);
    }
    track_superseded_refresh_hash(&refresh_hash, &session.id);

    let access_token = paracord_core::auth::create_session_token(
        session.user_id,
        session.pub_key.as_deref(),
        &state.config.jwt_secret,
        state.config.jwt_expiry_seconds,
        &session.id,
        &new_jti,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let secure = should_use_secure_cookie(state);
    let access_cookie = build_access_cookie(&access_token, state.config.jwt_expiry_seconds, secure);
    let refresh_cookie = build_refresh_cookie(&new_refresh, ttl_days, secure);
    let csrf_token = random_token_hex(24);
    let csrf_cookie = build_csrf_cookie(&csrf_token, state.config.jwt_expiry_seconds, secure);
    Ok((
        access_token,
        access_cookie,
        refresh_cookie,
        csrf_cookie,
        session.id,
        new_refresh,
    ))
}

fn user_json(user: &paracord_db::users::UserRow) -> Value {
    json!({
        "id": user.id.to_string(),
        "username": user.username,
        "email": user.email,
        "avatar_hash": user.avatar_hash,
        "display_name": user.display_name,
        "discriminator": user.discriminator,
        "flags": user.flags,
        "bot": paracord_core::is_bot(user.flags),
        "system": false,
        "public_key": user.public_key,
        "email_verified": user.email_verified,
    })
}

fn user_auth_json(user: &paracord_db::users::UserAuthRow) -> Value {
    json!({
        "id": user.id.to_string(),
        "username": user.username,
        "discriminator": user.discriminator,
        "email": user.email,
        "display_name": user.display_name,
        "avatar_hash": user.avatar_hash,
        "flags": user.flags,
        "bot": paracord_core::is_bot(user.flags),
        "system": false,
        "public_key": user.public_key,
        "created_at": user.created_at.to_rfc3339(),
        "email_verified": user.email_verified,
    })
}

async fn auto_join_public_spaces(state: &AppState, user_id: i64) -> Result<(), ApiError> {
    let spaces = paracord_db::guilds::list_all_spaces(&state.db)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    for space in spaces.iter().filter(|s| {
        s.visibility == "public"
            && paracord_db::guilds::parse_allowed_role_ids(&s.allowed_roles).is_empty()
    }) {
        let _ = paracord_db::members::add_member(&state.db, user_id, space.id).await;
        let _ = paracord_db::roles::add_member_role(&state.db, user_id, space.id, space.id).await;
    }
    Ok(())
}

#[derive(Deserialize)]
pub struct RegisterRequest {
    #[serde(default)]
    pub email: String,
    pub username: String,
    pub password: String,
    pub display_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    #[serde(default, alias = "identifier", alias = "username", alias = "login")]
    pub email: String,
    #[serde(default)]
    pub password: String,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: Value,
    /// Refresh token returned in the body for cross-origin clients that cannot
    /// use `HttpOnly` cookies (e.g. Vite dev proxy, Tauri, mobile).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
}

#[derive(Serialize)]
pub struct AuthSessionView {
    pub id: String,
    pub current: bool,
    pub device_id: Option<String>,
    pub user_agent: Option<String>,
    pub ip_address: Option<String>,
    pub issued_at: String,
    pub last_seen_at: String,
    pub expires_at: String,
}

#[derive(Serialize)]
pub struct AuthOptionsResponse {
    pub allow_username_login: bool,
    pub require_email: bool,
}

pub async fn auth_options(State(state): State<AppState>) -> Json<AuthOptionsResponse> {
    let allow_username_login = username_login_effective(
        state.config.allow_username_login,
        state.config.require_email,
    );
    Json(AuthOptionsResponse {
        allow_username_login,
        require_email: state.config.require_email,
    })
}

pub async fn register(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<RegisterRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let normalized_email = normalize_email_for_auth(&body.email);
    let account_hint = if normalized_email.is_empty() {
        normalize_login_identifier_for_auth(&body.username)
    } else {
        normalized_email.clone()
    };
    auth_guard_enforce(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&account_hint),
    )
    .await?;

    // Check runtime settings for registration status
    if !state.runtime.read().await.registration_enabled {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        return Err(ApiError::Forbidden);
    }

    if paracord_util::validation::is_valid_new_username(&body.username).is_err() {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        return Err(ApiError::BadRequest(
            "Username must be between 2 and 32 valid characters".into(),
        ));
    }
    if state.config.require_email && normalized_email.is_empty() {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        return Err(ApiError::BadRequest("Email is required".into()));
    }
    if !normalized_email.is_empty()
        && paracord_util::validation::validate_email(&normalized_email).is_err()
    {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        return Err(ApiError::BadRequest("Invalid email address".into()));
    }
    let allow_username_login = username_login_effective(
        state.config.allow_username_login,
        state.config.require_email,
    );
    if normalized_email.is_empty() && !allow_username_login {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&account_hint),
        )
        .await;
        return Err(ApiError::BadRequest(
            "Server requires email login or username login support".into(),
        ));
    }
    paracord_util::validation::validate_password(&body.password).map_err(|_| {
        ApiError::BadRequest("Password must be between 10 and 128 characters".into())
    })?;

    if !normalized_email.is_empty() {
        let existing = paracord_db::users::get_user_by_email(&state.db, &normalized_email)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

        if existing.is_some() {
            auth_guard_record_failure(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                Some(&account_hint),
            )
            .await;
            return Err(ApiError::BadRequest(
                "Unable to complete registration".into(),
            ));
        }
    }

    let password_hash = paracord_core::auth::hash_password(&body.password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let id = paracord_util::snowflake::generate(1);
    let resolved_email = if normalized_email.is_empty() {
        synthesized_local_email(id)
    } else {
        normalized_email.clone()
    };
    let mut user = paracord_db::users::create_user_as_first_admin(
        &state.db,
        id,
        &body.username,
        0,
        &resolved_email,
        &password_hash,
        paracord_core::USER_FLAG_ADMIN,
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    auto_join_public_spaces(&state, user.id).await?;

    if let Some(display_name) = body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        user = paracord_db::users::update_user(&state.db, user.id, Some(display_name), None, None)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    }

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            user.id,
            user.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.register.password",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "auth_method": "password" })),
    )
    .await;

    // Generate email verification token if required
    if state.config.require_email_verification && !normalized_email.is_empty() {
        let verify_token = random_token_hex(32);
        let verify_token_hash = sha256_hex(&verify_token);
        let verify_expires = Utc::now() + Duration::hours(EMAIL_VERIFY_TOKEN_TTL_HOURS);
        let _ = paracord_db::users::create_email_verification_token(
            &state.db,
            user.id,
            &verify_token_hash,
            verify_expires,
        )
        .await;
        let verify_url = resolve_outbound_link_origin(
            state.config.public_url.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .map(|origin| format!("{}/api/v1/auth/verify-email?token={}", origin, verify_token));
        match verify_url {
            None => {
                tracing::warn!(
                    target: "paracord::email_verification",
                    user_id = user.id,
                    username = %user.username,
                    email = %resolved_email,
                    "Email verification link skipped: no trusted public origin (set public_url or trust a proxy)"
                );
            }
            Some(verify_url) => {
                let subject = "Verify your Paracord email";
                let body = format!(
                    "Hi {},\n\nWelcome to Paracord. Verify your email by opening this link:\n{}\n\nThis link expires in {} hours.\n\nIf you did not create this account, ignore this message.",
                    user.username, verify_url, EMAIL_VERIFY_TOKEN_TTL_HOURS
                );
                match send_transactional_email(&resolved_email, subject, &body).await {
                    Ok(true) => {
                        tracing::info!(
                            target: "paracord::email_verification",
                            user_id = user.id,
                            username = %user.username,
                            email = %resolved_email,
                            "Sent email verification message"
                        );
                    }
                    Ok(false) => {
                        tracing::warn!(
                            target: "paracord::email_verification",
                            user_id = user.id,
                            username = %user.username,
                            email = %resolved_email,
                            "Email verification SMTP delivery skipped (recipient or SMTP config unavailable)"
                        );
                    }
                    Err(err) => {
                        tracing::error!(
                            target: "paracord::email_verification",
                            user_id = user.id,
                            username = %user.username,
                            email = %resolved_email,
                            error = %err,
                            "Failed to send email verification message"
                        );
                    }
                }
            }
        }
    }

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
        Json(AuthResponse {
            token,
            user: user_json(&user),
            refresh_token: Some(raw_refresh),
        }),
    ))
}

pub async fn login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    request: Request,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();

    let (_, request_body) = request.into_parts();
    let body_bytes = to_bytes(request_body, MAX_LOGIN_BODY_BYTES)
        .await
        .map_err(|_| ApiError::BadRequest("Invalid login request body".into()))?;
    let body = parse_login_request(&headers, &body_bytes)
        .ok_or_else(|| ApiError::BadRequest("Invalid login request body".into()))?;

    let normalized_identifier = normalize_login_identifier_for_auth(&body.email);
    auth_guard_enforce(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&normalized_identifier),
    )
    .await?;
    if normalized_identifier.is_empty() {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&normalized_identifier),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    let allow_username_login = username_login_effective(
        state.config.allow_username_login,
        state.config.require_email,
    );
    let resolved_user = if allow_username_login && !normalized_identifier.contains('@') {
        if let Some((username, discriminator)) =
            parse_username_with_discriminator(&normalized_identifier)
        {
            paracord_db::users::get_user_auth_by_username(&state.db, username, discriminator)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        } else {
            paracord_db::users::get_user_auth_by_username_only(&state.db, &normalized_identifier)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        }
    } else {
        let normalized_email = normalize_email_for_auth(&normalized_identifier);
        if paracord_util::validation::validate_email(&normalized_email).is_err() {
            auth_guard_record_failure(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                Some(&normalized_identifier),
            )
            .await;
            return Err(ApiError::Unauthorized);
        }
        paracord_db::users::get_user_by_email(&state.db, &normalized_email)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    let Some(user) = resolved_user else {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&normalized_identifier),
        )
        .await;
        return Err(ApiError::Unauthorized);
    };
    if user.password_hash.trim().is_empty() {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&normalized_identifier),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    let valid = paracord_core::auth::verify_password(&body.password, &user.password_hash)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !valid {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&normalized_identifier),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    if state.config.require_email_verification && !user.email_verified {
        // Correct credentials should clear auth-guard counters even when login
        // is blocked pending verification.
        auth_guard_record_success(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&normalized_identifier),
        )
        .await;
        return Err(ApiError::BadRequest(
            "Email verification required before logging in".into(),
        ));
    }

    // Check if user has MFA enabled — require TOTP before issuing tokens
    if let Ok(Some(mfa_config)) = paracord_db::mfa::get_mfa_config(&state.db, user.id).await {
        if mfa_config.enabled {
            let ticket = Uuid::new_v4().to_string();
            state.mfa_tickets.insert(ticket.clone(), user.id).await;
            let secure = should_use_secure_cookie(&state);
            let clear_access_cookie = build_access_cookie_clear(secure);
            let clear_refresh_cookie = build_refresh_cookie_clear(secure);
            let clear_csrf_cookie = build_csrf_cookie_clear(secure);
            auth_guard_record_success(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                Some(&normalized_identifier),
            )
            .await;
            return Ok((
                AppendHeaders([
                    (header::SET_COOKIE, header_value(&clear_access_cookie)?),
                    (header::SET_COOKIE, header_value(&clear_refresh_cookie)?),
                    (header::SET_COOKIE, header_value(&clear_csrf_cookie)?),
                ]),
                Json(AuthResponse {
                    token: String::new(),
                    user: json!({
                        "mfa_required": true,
                        "mfa_ticket": ticket,
                    }),
                    refresh_token: None,
                }),
            ));
        }
    }

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            user.id,
            user.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.login.password",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "auth_method": "password" })),
    )
    .await;
    auth_guard_record_success(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&normalized_identifier),
    )
    .await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_auth_json(&user),
            refresh_token: Some(raw_refresh),
        }),
    ))
}

pub async fn refresh(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    // Accept refresh token from cookie OR request body (for cross-origin clients).
    let refresh_token = get_cookie_value(&headers, REFRESH_COOKIE_NAME)
        .or_else(|| {
            body.as_ref()
                .and_then(|b| b.get("refresh_token"))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
        })
        .ok_or(ApiError::Unauthorized)?;
    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, new_raw_refresh) =
        rotate_auth_session(&state, &refresh_token, Some(&headers), Some(peer_ip.as_str())).await?;
    security::log_security_event(
        &state,
        "auth.refresh",
        None,
        None,
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        None,
    )
    .await;
    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(json!({ "token": token, "refresh_token": new_raw_refresh })),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let now = Utc::now();
    let mut revoked_session: Option<String> = None;
    if let Some(session_id) = auth.session_id.as_deref() {
        let _ = paracord_db::sessions::revoke_session(
            &state.db,
            session_id,
            auth.user_id,
            "user_logout",
            now,
        )
        .await;
        revoked_session = Some(session_id.to_string());
    } else if let Some(refresh_token) = get_cookie_value(&headers, REFRESH_COOKIE_NAME) {
        let refresh_hash = sha256_hex(&refresh_token);
        if let Some(session) =
            paracord_db::sessions::get_session_by_refresh_hash(&state.db, &refresh_hash)
                .await
                .ok()
                .flatten()
        {
            let _ = paracord_db::sessions::revoke_session(
                &state.db,
                &session.id,
                auth.user_id,
                "user_logout",
                now,
            )
            .await;
            revoked_session = Some(session.id);
        }
    }

    security::log_security_event(
        &state,
        "auth.logout",
        Some(auth.user_id),
        Some(auth.user_id),
        revoked_session.as_deref(),
        Some(&headers),
        Some(peer_ip.as_str()),
        None,
    )
    .await;

    let secure = should_use_secure_cookie(&state);
    let clear_access_cookie = build_access_cookie_clear(secure);
    let clear_refresh_cookie = build_refresh_cookie_clear(secure);
    let clear_csrf_cookie = build_csrf_cookie_clear(secure);
    Ok((
        StatusCode::NO_CONTENT,
        AppendHeaders([
            (header::SET_COOKIE, header_value(&clear_access_cookie)?),
            (header::SET_COOKIE, header_value(&clear_refresh_cookie)?),
            (header::SET_COOKIE, header_value(&clear_csrf_cookie)?),
        ]),
    ))
}

pub async fn list_sessions(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let now = Utc::now();
    let sessions = paracord_db::sessions::list_user_sessions(&state.db, auth.user_id, now)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let current = auth.session_id.unwrap_or_default();

    let mapped: Vec<AuthSessionView> = sessions
        .iter()
        .map(|session| AuthSessionView {
            id: session.id.clone(),
            current: session.id == current,
            device_id: session.device_id.clone(),
            user_agent: session.user_agent.clone(),
            ip_address: session.ip_address.clone(),
            issued_at: session.issued_at.to_rfc3339(),
            last_seen_at: session.last_seen_at.to_rfc3339(),
            expires_at: session.expires_at.to_rfc3339(),
        })
        .collect();

    Ok(Json(json!(mapped)))
}

pub async fn revoke_session(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
    let peer_ip = addr.ip().to_string();
    let revoked = paracord_db::sessions::revoke_session(
        &state.db,
        &session_id,
        auth.user_id,
        "user_session_revoke",
        Utc::now(),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    if !revoked {
        return Err(ApiError::NotFound);
    }

    security::log_security_event(
        &state,
        "auth.session.revoke",
        Some(auth.user_id),
        Some(auth.user_id),
        Some(&session_id),
        None,
        Some(peer_ip.as_str()),
        None,
    )
    .await;

    let should_clear_cookie = auth.session_id.as_deref() == Some(session_id.as_str());
    if should_clear_cookie {
        let secure = should_use_secure_cookie(&state);
        let clear_access_cookie = build_access_cookie_clear(secure);
        let clear_refresh_cookie = build_refresh_cookie_clear(secure);
        let clear_csrf_cookie = build_csrf_cookie_clear(secure);
        Ok((
            StatusCode::NO_CONTENT,
            AppendHeaders([
                (header::SET_COOKIE, header_value(&clear_access_cookie)?),
                (header::SET_COOKIE, header_value(&clear_refresh_cookie)?),
                (header::SET_COOKIE, header_value(&clear_csrf_cookie)?),
            ]),
        )
            .into_response())
    } else {
        Ok(StatusCode::NO_CONTENT.into_response())
    }
}

// --- Public key attachment (migration for existing password-based accounts) ---

#[derive(Deserialize)]
pub struct AttachPublicKeyRequest {
    pub public_key: String,
    pub nonce: String,
    pub timestamp: i64,
    pub signature: String,
}

pub async fn attach_public_key(
    State(state): State<AppState>,
    auth: AuthUser,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AttachPublicKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    verify_pubkey_challenge_proof(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        &body.public_key,
        &body.nonce,
        body.timestamp,
        &body.signature,
    )?;

    let current_user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    // Check that this public key isn't already attached to a different account
    let existing = paracord_db::users::get_user_by_public_key(&state.db, &body.public_key)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if let Some(existing_user) = existing {
        if existing_user.id != auth.user_id {
            return Err(ApiError::Conflict(
                "This public key is already in use by another account".into(),
            ));
        }
    }

    let user = if current_user.public_key.as_deref() == Some(body.public_key.as_str()) {
        current_user
    } else {
        paracord_db::users::update_user_public_key(&state.db, auth.user_id, &body.public_key)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    // Force global session invalidation on trust material change.
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        auth.user_id,
        None,
        "public_key_rotated",
        Utc::now(),
    )
    .await;

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            user.id,
            user.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.public_key.attach",
        Some(auth.user_id),
        Some(auth.user_id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "sessions_revoked": true })),
    )
    .await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_json(&user),
            refresh_token: Some(raw_refresh),
        }),
    ))
}

// --- Password reset flow ---

const RESET_TOKEN_TTL_MINUTES: i64 = 60;
const EMAIL_VERIFY_TOKEN_TTL_HOURS: i64 = 24;

#[derive(Deserialize)]
pub struct ForgotPasswordRequest {
    /// Email or username of the account to reset.
    pub identifier: String,
}

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    pub token: String,
    pub new_password: String,
}

pub async fn forgot_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ForgotPasswordRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let normalized = normalize_login_identifier_for_auth(&body.identifier);
    auth_guard_enforce(&state, &headers, Some(peer_ip.as_str()), Some(&normalized)).await?;

    // Intentionally always return 200 to avoid user enumeration.
    let ok_response = || {
        Json(serde_json::json!({
            "message": "If the account exists, a password reset email has been sent."
        }))
    };

    if normalized.is_empty() {
        return Ok(ok_response());
    }

    let allow_username_login = username_login_effective(
        state.config.allow_username_login,
        state.config.require_email,
    );

    let resolved_user = if allow_username_login && !normalized.contains('@') {
        paracord_db::users::get_user_auth_by_username_only(&state.db, &normalized)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    } else {
        paracord_db::users::get_user_by_email(&state.db, &normalized)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    };

    let Some(user) = resolved_user else {
        return Ok(ok_response());
    };

    // Invalidate any existing tokens for this user, then create a new one.
    let _ = paracord_db::password_reset::invalidate_user_reset_tokens(&state.db, user.id).await;

    let raw_token = random_token_hex(32);
    let token_hash = sha256_hex(&raw_token);
    let now = Utc::now();
    let expires_at = now + Duration::minutes(RESET_TOKEN_TTL_MINUTES);

    paracord_db::password_reset::create_reset_token(&state.db, &token_hash, user.id, expires_at)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Only embed a clickable reset link when we can resolve a trusted origin;
    // otherwise a poisoned Host header would point the link (carrying the reset
    // token) at an attacker. The raw token is always included so the user can
    // complete the reset manually even without a link.
    let reset_url = resolve_outbound_link_origin(
        state.config.public_url.as_deref(),
        &headers,
        Some(peer_ip.as_str()),
    )
    .map(|origin| format!("{}/login?reset_token={}", origin, raw_token));
    let subject = "Paracord password reset";
    let body = match &reset_url {
        Some(reset_url) => format!(
            "Hi {},\n\nA password reset was requested for your Paracord account.\n\nReset link: {}\nReset token: {}\n\nThis token expires in {} minutes. If you did not request this, ignore this message.",
            user.username, reset_url, raw_token, RESET_TOKEN_TTL_MINUTES
        ),
        None => format!(
            "Hi {},\n\nA password reset was requested for your Paracord account.\n\nReset token: {}\n\nThis token expires in {} minutes. If you did not request this, ignore this message.",
            user.username, raw_token, RESET_TOKEN_TTL_MINUTES
        ),
    };
    match send_transactional_email(&user.email, subject, &body).await {
        Ok(true) => {
            tracing::info!(
                target: "paracord::password_reset",
                user_id = user.id,
                username = %user.username,
                email = %user.email,
                "Sent password reset email"
            );
        }
        Ok(false) => {
            tracing::warn!(
                target: "paracord::password_reset",
                user_id = user.id,
                username = %user.username,
                email = %user.email,
                "SMTP not configured - password reset token generated but cannot be delivered. Configure SMTP or use admin API to reset passwords."
            );
        }
        Err(err) => {
            tracing::error!(
                target: "paracord::password_reset",
                user_id = user.id,
                username = %user.username,
                email = %user.email,
                error = %err,
                "Failed to send password reset email"
            );
        }
    }

    security::log_security_event(
        &state,
        "auth.password_reset.requested",
        Some(user.id),
        Some(user.id),
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(serde_json::json!({ "ip": peer_ip })),
    )
    .await;

    Ok(ok_response())
}

pub async fn reset_password(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<ResetPasswordRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    auth_guard_enforce(&state, &headers, Some(peer_ip.as_str()), None).await?;

    if body.token.is_empty() {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), None).await;
        return Err(ApiError::BadRequest("Token is required".into()));
    }

    paracord_util::validation::validate_password(&body.new_password).map_err(|_| {
        ApiError::BadRequest("Password must be between 10 and 128 characters".into())
    })?;

    let token_hash = sha256_hex(&body.token);
    let now = Utc::now();

    let token_row = paracord_db::password_reset::get_valid_reset_token(&state.db, &token_hash, now)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let Some(token_row) = token_row else {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), None).await;
        return Err(ApiError::BadRequest(
            "Invalid or expired reset token".into(),
        ));
    };

    // Mark token as used before updating password to prevent race conditions.
    let marked = paracord_db::password_reset::mark_reset_token_used(&state.db, &token_hash, now)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !marked {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), None).await;
        return Err(ApiError::BadRequest(
            "Invalid or expired reset token".into(),
        ));
    }

    let new_hash = paracord_core::auth::hash_password(&body.new_password)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    paracord_db::users::update_user_password_hash(&state.db, token_row.user_id, &new_hash)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Revoke all existing sessions to force re-login with new password.
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        token_row.user_id,
        None,
        "password_reset",
        now,
    )
    .await;

    security::log_security_event(
        &state,
        "auth.password_reset.completed",
        Some(token_row.user_id),
        Some(token_row.user_id),
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(serde_json::json!({ "ip": peer_ip, "sessions_revoked": true })),
    )
    .await;

    auth_guard_record_success(&state, &headers, Some(peer_ip.as_str()), None).await;

    Ok(Json(
        serde_json::json!({ "message": "Password updated successfully. Please log in with your new password." }),
    ))
}

// --- Email Verification ---

#[derive(Deserialize)]
pub struct VerifyEmailRequest {
    pub token: String,
}

pub async fn verify_email(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<VerifyEmailRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    auth_guard_enforce(&state, &headers, Some(peer_ip.as_str()), None).await?;

    if body.token.is_empty() {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), None).await;
        return Err(ApiError::BadRequest("Token is required".into()));
    }

    let token_hash = sha256_hex(&body.token);
    let now = Utc::now();

    let token_row = paracord_db::users::get_email_verification_token(&state.db, &token_hash, now)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let Some(token_row) = token_row else {
        auth_guard_record_failure(&state, &headers, Some(peer_ip.as_str()), None).await;
        return Err(ApiError::BadRequest(
            "Invalid or expired verification token".into(),
        ));
    };

    // Set user as email-verified
    paracord_db::users::set_email_verified(&state.db, token_row.user_id, true)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Clean up all verification tokens for this user
    let _ =
        paracord_db::users::delete_email_verification_tokens_for_user(&state.db, token_row.user_id)
            .await;

    security::log_security_event(
        &state,
        "auth.email_verified",
        Some(token_row.user_id),
        Some(token_row.user_id),
        None,
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(serde_json::json!({ "ip": peer_ip })),
    )
    .await;

    auth_guard_record_success(&state, &headers, Some(peer_ip.as_str()), None).await;

    Ok(Json(
        serde_json::json!({ "message": "Email verified successfully." }),
    ))
}

// --- MFA / TOTP ---

const MFA_BACKUP_CODE_COUNT: usize = 10;
const MFA_ISSUER: &str = "Paracord";

/// Encrypt a TOTP secret before storing in the database. In production
/// (public_url configured) at-rest encryption is required; dev may store plaintext.
fn encrypt_totp_secret(state: &AppState, plaintext_base32: &str) -> Result<String, ApiError> {
    let Some(cryptor) = state.config.totp_cryptor.as_ref() else {
        if state.config.public_url.is_some() {
            return Err(ApiError::ServiceUnavailable(
                "MFA requires at-rest encryption when public_url is configured; enable [at_rest] with a valid key".into(),
            ));
        }
        return Ok(plaintext_base32.to_string());
    };
    let encrypted = cryptor
        .encrypt(plaintext_base32.as_bytes())
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("TOTP secret encryption failed: {}", e)))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::STANDARD.encode(&encrypted))
}

/// Decrypt a TOTP secret from the database. Handles both encrypted (base64-encoded)
/// and legacy plaintext secrets transparently for migration.
fn decrypt_totp_secret(state: &AppState, stored: &str) -> Result<String, ApiError> {
    let Some(cryptor) = state.config.totp_cryptor.as_ref() else {
        return Ok(stored.to_string());
    };
    // Try to base64-decode; if it fails, the value is likely plaintext (pre-encryption).
    use base64::Engine;
    let decoded = match base64::engine::general_purpose::STANDARD.decode(stored) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(stored.to_string()),
    };
    let plaintext_bytes = cryptor
        .decrypt(&decoded)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("TOTP secret decryption failed: {}", e)))?;
    String::from_utf8(plaintext_bytes)
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("TOTP secret is not valid UTF-8: {}", e)))
}

fn generate_totp_secret() -> String {
    let raw_secret = totp_rs::Secret::generate_secret();
    match raw_secret.to_encoded() {
        totp_rs::Secret::Encoded(s) => s,
        other => format!("{other}"),
    }
}

fn totp_for_secret(secret_base32: &str, account_name: &str) -> Result<totp_rs::TOTP, ApiError> {
    let secret = totp_rs::Secret::Encoded(secret_base32.to_string());
    totp_rs::TOTP::new(
        totp_rs::Algorithm::SHA1,
        6,
        1,
        30,
        secret
            .to_bytes()
            .map_err(|e| ApiError::Internal(anyhow::anyhow!("Invalid TOTP secret: {}", e)))?,
        Some(MFA_ISSUER.to_string()),
        account_name.to_string(),
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("TOTP init error: {}", e)))
}

fn verify_totp_code(secret_base32: &str, code: &str, account_name: &str) -> Result<bool, ApiError> {
    let totp = totp_for_secret(secret_base32, account_name)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // Allow 1 step (30s) of drift in either direction
    Ok(totp.check(code, now))
}

fn generate_backup_codes() -> Vec<String> {
    (0..MFA_BACKUP_CODE_COUNT)
        .map(|_| {
            let raw = random_token_hex(8); // 16 hex chars = 64 bits of entropy
                                           // Format as XXXX-XXXX-XXXX-XXXX for readability
            format!(
                "{}-{}-{}-{}",
                &raw[..4],
                &raw[4..8],
                &raw[8..12],
                &raw[12..]
            )
        })
        .collect()
}

fn normalize_backup_code(code: &str) -> String {
    code.trim()
        .to_ascii_uppercase()
        .replace('-', "")
        .replace(' ', "")
}

#[derive(Deserialize)]
pub struct MfaVerifyRequest {
    pub code: String,
}

#[derive(Deserialize)]
pub struct MfaDisableRequest {
    pub code: String,
}

pub async fn mfa_setup(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<impl IntoResponse, ApiError> {
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;

    let secret_base32 = generate_totp_secret();

    // Encrypt the TOTP secret before storing (plaintext only when at-rest is unset in dev).
    let stored_secret = encrypt_totp_secret(&state, &secret_base32)?;

    // Store as pending (not yet enabled)
    paracord_db::mfa::upsert_mfa_secret(&state.db, user.id, &stored_secret)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let totp = totp_for_secret(&secret_base32, &user.email)?;
    let otpauth_url = totp.get_url();

    // Generate QR code as base64 PNG
    let qr_code_base64 = totp
        .get_qr_base64()
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("QR code generation failed: {}", e)))?;

    Ok(Json(json!({
        "secret": secret_base32,
        "otpauth_url": otpauth_url,
        "qr_code": format!("data:image/png;base64,{}", qr_code_base64),
    })))
}

pub async fn mfa_verify(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    Json(body): Json<MfaVerifyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;

    let mfa_config = paracord_db::mfa::get_mfa_config(&state.db, user.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(|| ApiError::BadRequest("MFA setup not initiated".into()))?;

    if mfa_config.enabled {
        return Err(ApiError::BadRequest("MFA is already enabled".into()));
    }

    let totp_secret = decrypt_totp_secret(&state, &mfa_config.totp_secret)?;
    let valid = verify_totp_code(&totp_secret, &body.code, &user.email)?;
    if !valid {
        return Err(ApiError::BadRequest("Invalid TOTP code".into()));
    }

    // Enable MFA
    paracord_db::mfa::enable_mfa(&state.db, user.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Generate and store backup codes
    let backup_codes = generate_backup_codes();
    let code_hashes: Vec<String> = backup_codes
        .iter()
        .map(|code| sha256_hex(&normalize_backup_code(code)))
        .collect();

    paracord_db::mfa::store_backup_codes(&state.db, user.id, &code_hashes)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    security::log_security_event(
        &state,
        "auth.mfa.enabled",
        Some(user.id),
        Some(user.id),
        auth.session_id.as_deref(),
        None,
        Some(peer_ip.as_str()),
        None,
    )
    .await;

    Ok(Json(json!({
        "mfa_enabled": true,
        "backup_codes": backup_codes,
        "message": "MFA enabled. Save these backup codes in a safe place - they can only be shown once.",
    })))
}

pub async fn mfa_disable(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    auth: AuthUser,
    Json(body): Json<MfaDisableRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;

    let mfa_config = paracord_db::mfa::get_mfa_config(&state.db, user.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or_else(|| ApiError::BadRequest("MFA is not configured".into()))?;

    if !mfa_config.enabled {
        return Err(ApiError::BadRequest("MFA is not enabled".into()));
    }

    // Verify TOTP code (or backup code) before disabling
    let now = Utc::now();
    let normalized_code = normalize_backup_code(&body.code);
    let code_hash = sha256_hex(&normalized_code);

    let totp_secret = decrypt_totp_secret(&state, &mfa_config.totp_secret)?;
    let valid_totp = verify_totp_code(&totp_secret, &body.code, &user.email)?;
    let valid_backup = if !valid_totp {
        paracord_db::mfa::consume_backup_code(&state.db, user.id, &code_hash, now)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    } else {
        false
    };

    if !valid_totp && !valid_backup {
        return Err(ApiError::BadRequest("Invalid code".into()));
    }

    paracord_db::mfa::disable_mfa(&state.db, user.id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    security::log_security_event(
        &state,
        "auth.mfa.disabled",
        Some(user.id),
        Some(user.id),
        auth.session_id.as_deref(),
        None,
        Some(peer_ip.as_str()),
        None,
    )
    .await;

    Ok(Json(
        json!({ "mfa_enabled": false, "message": "MFA disabled." }),
    ))
}

pub async fn mfa_status(
    State(state): State<AppState>,
    auth: AuthUser,
) -> Result<impl IntoResponse, ApiError> {
    let mfa_config = paracord_db::mfa::get_mfa_config(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let enabled = mfa_config.as_ref().map(|c| c.enabled).unwrap_or(false);

    // Count unused backup codes
    let backup_codes_remaining = if enabled {
        paracord_db::mfa::get_unused_backup_codes(&state.db, auth.user_id)
            .await
            .map(|codes| codes.len())
            .unwrap_or(0)
    } else {
        0
    };

    Ok(Json(json!({
        "mfa_enabled": enabled,
        "backup_codes_remaining": backup_codes_remaining,
    })))
}

// --- MFA login (second step after password auth when MFA is enabled) ---

#[derive(Deserialize)]
pub struct MfaLoginRequest {
    pub ticket: String,
    pub code: String,
}

pub async fn mfa_login(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<MfaLoginRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();

    // Resolve the ticket to a user FIRST so all rate-limiting is keyed on the
    // resolved account, never on the attacker-supplied ticket. Keying on the
    // ticket would let an attacker who knows a victim's ticket drive the failure
    // counter and trip the lockout that invalidates that ticket.
    let user_id = state
        .mfa_tickets
        .get(&body.ticket)
        .await
        .ok_or(ApiError::BadRequest("Invalid or expired MFA ticket".into()))?;

    let account_hint = user_id.to_string();

    // Rate-limit MFA login attempts (IP-level + per-account).
    auth_guard_enforce(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&account_hint),
    )
    .await?;

    let user = paracord_db::users::get_user_by_id(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let mfa_config = paracord_db::mfa::get_mfa_config(&state.db, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::BadRequest("MFA not configured".into()))?;

    // Decrypt the TOTP secret (handles both encrypted and legacy plaintext)
    let totp_secret = decrypt_totp_secret(&state, &mfa_config.totp_secret)?;

    // Try TOTP code first
    let code = body.code.trim();
    let valid_totp = verify_totp_code(&totp_secret, code, &user.email)?;

    if !valid_totp {
        // Try as backup code
        let normalized = normalize_backup_code(code);
        let code_hash = format!("{:x}", Sha256::digest(normalized.as_bytes()));
        let used =
            paracord_db::mfa::consume_backup_code(&state.db, user_id, &code_hash, Utc::now())
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if !used {
            // Record failure for rate limiting, keyed on the resolved account.
            auth_guard_record_failure(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                Some(&account_hint),
            )
            .await;

            // Check if this account has accumulated too many failures (5+) and
            // invalidate the ticket.
            let guard_keys = auth_guard_keys(&headers, Some(peer_ip.as_str()), Some(&account_hint));
            let rows = paracord_db::rate_limits::get_auth_guard_states(&state.db, &guard_keys)
                .await
                .unwrap_or_default();
            let max_failures = rows.iter().map(|r| r.failures).max().unwrap_or(0);
            if max_failures >= 5 {
                state.mfa_tickets.remove(&body.ticket).await;
                tracing::warn!(
                    target: "paracord::mfa",
                    user_id = %user_id,
                    "MFA ticket invalidated after too many failed attempts"
                );
            }

            return Err(ApiError::BadRequest("Invalid MFA code".into()));
        }
    }

    // Success: remove the ticket (single-use on success) and clear rate-limit state
    state.mfa_tickets.remove(&body.ticket).await;
    auth_guard_record_success(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&account_hint),
    )
    .await;

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            user.id,
            user.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;

    security::log_security_event(
        &state,
        "auth.login.mfa",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "auth_method": "password+mfa" })),
    )
    .await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_json(&user),
            refresh_token: Some(raw_refresh),
        }),
    ))
}

// --- Ed25519 challenge-response authentication ---

#[derive(Serialize)]
pub struct ChallengeResponse {
    pub nonce: String,
    pub timestamp: i64,
    pub server_origin: String,
}

pub async fn challenge(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Result<Json<ChallengeResponse>, ApiError> {
    let peer_ip = addr.ip().to_string();
    auth_guard_enforce(&state, &headers, Some(peer_ip.as_str()), None).await?;

    let (nonce, timestamp) = paracord_core::auth::generate_challenge();

    // Store the nonce (bounded + TTL enforced by Moka cache policy).
    challenge_store().insert(nonce.clone(), timestamp);

    let server_origin = resolve_server_origin(
        state.config.public_url.as_deref(),
        &headers,
        Some(peer_ip.as_str()),
    );

    Ok(Json(ChallengeResponse {
        nonce,
        timestamp,
        server_origin,
    }))
}

#[derive(Deserialize)]
pub struct VerifyRequest {
    pub public_key: String,
    pub nonce: String,
    pub timestamp: i64,
    pub signature: String,
    pub username: String,
    pub display_name: Option<String>,
}

pub async fn verify(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<VerifyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    auth_guard_enforce(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&body.public_key),
    )
    .await?;

    if paracord_util::validation::is_valid_new_username(&body.username).is_err() {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&body.public_key),
        )
        .await;
        return Err(ApiError::BadRequest(
            "Username must be between 2 and 32 valid characters".into(),
        ));
    }

    let normalized_display_name = match body
        .display_name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
    {
        Some(display_name) => {
            if display_name.chars().count() > MAX_DISPLAY_NAME_LEN {
                auth_guard_record_failure(
                    &state,
                    &headers,
                    Some(peer_ip.as_str()),
                    Some(&body.public_key),
                )
                .await;
                return Err(ApiError::BadRequest("Display name is too long".into()));
            }
            if display_name.chars().any(|ch| ch.is_control()) {
                auth_guard_record_failure(
                    &state,
                    &headers,
                    Some(peer_ip.as_str()),
                    Some(&body.public_key),
                )
                .await;
                return Err(ApiError::BadRequest(
                    "Display name contains invalid characters".into(),
                ));
            }
            Some(display_name.to_string())
        }
        None => None,
    };

    // Validate public key format (64 hex chars = 32 bytes Ed25519 public key).
    if let Err(err) = validate_public_key_hex(&body.public_key) {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&body.public_key),
        )
        .await;
        return Err(err);
    }

    // Consume the nonce (one-time use) and recover its server-issued timestamp.
    let issued_at = match challenge_store().remove(&body.nonce) {
        Some(issued_at) => issued_at,
        None => {
            auth_guard_record_failure(
                &state,
                &headers,
                Some(peer_ip.as_str()),
                Some(&body.public_key),
            )
            .await;
            return Err(ApiError::Unauthorized);
        }
    };

    // Reject stale challenges using the trusted server-issued timestamp, and
    // require the client to echo that timestamp within acceptable skew before we
    // re-sign it into the verification message below. This is independent of the
    // cache TTL: a nonce that outlives the challenge window is no longer valid
    // even if it is still present in the cache.
    let now = Utc::now().timestamp();
    if now - issued_at > CHALLENGE_MAX_AGE_SECONDS
        || (body.timestamp - issued_at).abs() > CHALLENGE_SKEW_SECONDS
    {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&body.public_key),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    let server_origin = resolve_server_origin(
        state.config.public_url.as_deref(),
        &headers,
        Some(peer_ip.as_str()),
    );

    // Verify the signature.
    let valid = paracord_core::auth::verify_challenge(
        &body.public_key,
        &body.nonce,
        body.timestamp,
        &server_origin,
        &body.signature,
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    if !valid {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&body.public_key),
        )
        .await;
        return Err(ApiError::Unauthorized);
    }

    // Look up or create user by public key.
    let user = match paracord_db::users::get_user_by_public_key(&state.db, &body.public_key)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        Some(user) => user,
        None => {
            if !state.runtime.read().await.registration_enabled {
                auth_guard_record_failure(
                    &state,
                    &headers,
                    Some(peer_ip.as_str()),
                    Some(&body.public_key),
                )
                .await;
                return Err(ApiError::Forbidden);
            }

            // Auto-register: create new user from public key.
            let id = paracord_util::snowflake::generate(1);
            let new_user = paracord_db::users::create_user_from_pubkey_as_first_admin(
                &state.db,
                id,
                &body.public_key,
                &body.username,
                normalized_display_name.as_deref(),
                paracord_core::USER_FLAG_ADMIN,
            )
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

            auto_join_public_spaces(&state, new_user.id).await?;

            new_user
        }
    };

    let (token, access_cookie, refresh_cookie, csrf_cookie, session_id, raw_refresh) =
        issue_auth_session(
            &state,
            user.id,
            user.public_key.as_deref(),
            &headers,
            Some(peer_ip.as_str()),
        )
        .await?;
    security::log_security_event(
        &state,
        "auth.login.public_key",
        Some(user.id),
        Some(user.id),
        Some(&session_id),
        Some(&headers),
        Some(peer_ip.as_str()),
        Some(json!({ "auth_method": "public_key" })),
    )
    .await;
    auth_guard_record_success(
        &state,
        &headers,
        Some(peer_ip.as_str()),
        Some(&body.public_key),
    )
    .await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
            (header::SET_COOKIE, header_value(&csrf_cookie)?),
        ]),
        Json(AuthResponse {
            token,
            user: user_json(&user),
            refresh_token: Some(raw_refresh),
        }),
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        auth_guard_keys, build_csrf_cookie, build_refresh_cookie, get_cookie_value,
        normalize_email_for_auth, parse_login_form_value, parse_login_json_value,
        parse_login_request, parse_username_with_discriminator, resolve_outbound_link_origin,
        resolve_server_origin, should_use_secure_cookie_with_public_url, synthesized_local_email,
        username_login_effective, HeaderMap, LoginRequest,
    };
    use axum::http::{header, HeaderValue};
    use std::sync::{Mutex, OnceLock};

    fn env_lock() -> &'static Mutex<()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(()))
    }

    #[test]
    fn auth_guard_keys_include_ip_device_and_account() {
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.4"));
        headers.insert("x-device-id", HeaderValue::from_static("device-123"));
        let keys = auth_guard_keys(&headers, Some("198.51.100.9"), Some("USER@example.com"));
        assert!(keys.contains(&"ip:198.51.100.9".to_string()));
        assert!(keys.contains(&"device:device-123".to_string()));
        assert!(keys.contains(&"acct:user@example.com".to_string()));
    }

    #[test]
    fn refresh_cookie_roundtrip_parsing_works() {
        let cookie = build_refresh_cookie("token-value", 7, true);
        let mut headers = HeaderMap::new();
        let header_val = HeaderValue::from_str(&cookie)
            .map_err(|e| format!("failed to build cookie header value: {e}"))
            .unwrap();
        headers.insert(header::COOKIE, header_val);
        let parsed = get_cookie_value(&headers, "paracord_refresh");
        assert_eq!(parsed.as_deref(), Some("token-value"));
    }

    #[test]
    fn csrf_cookie_is_readable_from_app_routes() {
        let cookie = build_csrf_cookie("csrf-token", 3600, true);
        assert!(
            cookie.contains("Path=/;"),
            "csrf cookie must be readable from /app routes so the browser can refresh sessions: {cookie}"
        );
    }

    #[test]
    fn normalizes_email_to_ascii_lowercase_and_trimmed() {
        assert_eq!(
            normalize_email_for_auth("  USER@Example.COM  "),
            "user@example.com"
        );
    }

    #[test]
    fn secure_cookie_defaults_to_true_when_tls_env_enabled() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var("PARACORD_COOKIE_SECURE");
        std::env::set_var("PARACORD_TLS_ENABLED", "true");
        assert!(should_use_secure_cookie_with_public_url(None));
        std::env::remove_var("PARACORD_TLS_ENABLED");
    }

    #[test]
    fn secure_cookie_respects_tls_env_false_even_with_https_public_url() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var("PARACORD_COOKIE_SECURE");
        std::env::set_var("PARACORD_TLS_ENABLED", "false");
        assert!(!should_use_secure_cookie_with_public_url(Some(
            "https://chat.example.com"
        )));
        std::env::remove_var("PARACORD_TLS_ENABLED");
    }

    #[test]
    fn challenge_origin_uses_configured_public_origin_when_available() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("evil.example"));
        let origin = resolve_server_origin(Some("https://chat.example.com/app"), &headers, None);
        assert_eq!(origin, "https://chat.example.com");
    }

    #[test]
    fn challenge_origin_falls_back_to_request_host_when_public_url_missing() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_TLS_ENABLED", "true");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::HOST,
            HeaderValue::from_static("173.62.236.246:8443"),
        );
        let origin = resolve_server_origin(None, &headers, Some("198.51.100.10"));
        assert_eq!(origin, "https://173.62.236.246:8443");
        std::env::remove_var("PARACORD_TLS_ENABLED");
    }

    #[test]
    fn challenge_origin_honors_trusted_forwarded_headers() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_TRUST_PROXY", "true");
        std::env::set_var("PARACORD_TRUSTED_PROXY_IPS", "10.0.0.5");
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("chat.example.com"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8080"));
        let origin = resolve_server_origin(None, &headers, Some("10.0.0.5"));
        assert_eq!(origin, "https://chat.example.com");
        std::env::remove_var("PARACORD_TRUST_PROXY");
        std::env::remove_var("PARACORD_TRUSTED_PROXY_IPS");
    }

    #[test]
    fn outbound_link_origin_uses_configured_public_origin_and_ignores_host() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("attacker.example"));
        let origin =
            resolve_outbound_link_origin(Some("https://chat.example.com/app"), &headers, None);
        assert_eq!(origin.as_deref(), Some("https://chat.example.com"));
    }

    #[test]
    fn outbound_link_origin_refuses_untrusted_host_header() {
        // No configured public_url and an untrusted peer: a poisoned Host must
        // never become an outbound (email) link origin — return None so the
        // caller skips the link instead of leaking the token to attacker.example.
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var("PARACORD_TRUST_PROXY");
        std::env::remove_var("PARACORD_TRUSTED_PROXY_IPS");
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, HeaderValue::from_static("attacker.example"));
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("attacker.example"),
        );
        let origin = resolve_outbound_link_origin(None, &headers, Some("198.51.100.10"));
        assert_eq!(origin, None);
    }

    #[test]
    fn outbound_link_origin_honors_trusted_forwarded_host() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_TRUST_PROXY", "true");
        std::env::set_var("PARACORD_TRUSTED_PROXY_IPS", "10.0.0.5");
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-host",
            HeaderValue::from_static("chat.example.com"),
        );
        headers.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        headers.insert(header::HOST, HeaderValue::from_static("127.0.0.1:8080"));
        let origin = resolve_outbound_link_origin(None, &headers, Some("10.0.0.5"));
        assert_eq!(origin.as_deref(), Some("https://chat.example.com"));
        std::env::remove_var("PARACORD_TRUST_PROXY");
        std::env::remove_var("PARACORD_TRUSTED_PROXY_IPS");
    }

    #[test]
    fn login_request_accepts_identifier_alias() {
        let body = serde_json::json!({
            "identifier": "alice",
            "password": "secret-123"
        });
        let parsed: LoginRequest =
            serde_json::from_value(body).expect("identifier alias should deserialize");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn login_request_accepts_username_alias() {
        let body = serde_json::json!({
            "username": "alice",
            "password": "secret-123"
        });
        let parsed: LoginRequest =
            serde_json::from_value(body).expect("username alias should deserialize");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn login_request_defaults_missing_password_to_empty() {
        let body = serde_json::json!({
            "email": "alice@example.com"
        });
        let parsed: LoginRequest =
            serde_json::from_value(body).expect("missing password should deserialize");
        assert_eq!(parsed.email, "alice@example.com");
        assert!(parsed.password.is_empty());
    }

    #[test]
    fn parse_login_json_value_accepts_nested_credentials_payload() {
        let body = serde_json::json!({
            "credentials": {
                "username": "alice",
                "password": "secret-123"
            }
        });
        let parsed = parse_login_json_value(body).expect("nested payload should deserialize");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn parse_login_form_value_accepts_identifier_and_password() {
        let parsed = parse_login_form_value(b"identifier=alice&password=secret-123")
            .expect("form payload should deserialize");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn parse_login_request_accepts_json_without_content_type() {
        let headers = HeaderMap::new();
        let parsed = parse_login_request(
            &headers,
            br#"{"identifier":"alice@example.com","password":"secret-123"}"#,
        )
        .expect("json payload should deserialize without content-type");
        assert_eq!(parsed.email, "alice@example.com");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn parse_login_request_rejects_form_content_type_by_default() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::remove_var("PARACORD_AUTH_LOGIN_LEGACY_PARSER");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let parsed = parse_login_request(&headers, b"username=alice&password=secret-123");
        assert!(parsed.is_none());
    }

    #[test]
    fn parse_login_request_accepts_legacy_form_when_enabled() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_AUTH_LOGIN_LEGACY_PARSER", "true");
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let parsed = parse_login_request(&headers, b"username=alice&password=secret-123")
            .expect("legacy form payload should deserialize with env flag");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
        std::env::remove_var("PARACORD_AUTH_LOGIN_LEGACY_PARSER");
    }

    #[test]
    fn parse_login_request_tolerates_null_identifier_fields_with_legacy_parser() {
        let _guard = env_lock().lock().expect("env lock");
        std::env::set_var("PARACORD_AUTH_LOGIN_LEGACY_PARSER", "true");
        let headers = HeaderMap::new();
        let parsed = parse_login_request(
            &headers,
            br#"{"identifier":null,"email":null,"password":"secret-123"}"#,
        )
        .expect("null identifiers should not hard-fail login payload parsing");
        assert!(parsed.email.is_empty());
        assert_eq!(parsed.password, "secret-123");
        std::env::remove_var("PARACORD_AUTH_LOGIN_LEGACY_PARSER");
    }

    #[test]
    fn username_login_is_effective_when_email_is_optional() {
        assert!(username_login_effective(false, false));
        assert!(username_login_effective(true, false));
        assert!(username_login_effective(true, true));
        assert!(!username_login_effective(false, true));
    }

    #[test]
    fn parses_username_with_discriminator_identifier() {
        let parsed = parse_username_with_discriminator("alice#42");
        assert_eq!(parsed, Some(("alice", 42)));
        assert!(parse_username_with_discriminator("alice#").is_none());
        assert!(parse_username_with_discriminator("#42").is_none());
    }

    #[test]
    fn synthesizes_local_email_for_emailless_accounts() {
        assert_eq!(synthesized_local_email(12345), "u12345@local.invalid");
    }
}
