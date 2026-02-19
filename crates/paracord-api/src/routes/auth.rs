use axum::{
    body::to_bytes,
    extract::{ConnectInfo, Path, Request, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{AppendHeaders, IntoResponse},
    Json,
};
use chrono::{Duration, Utc};
use paracord_core::AppState;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;
use crate::routes::security;

const REFRESH_COOKIE_NAME: &str = "paracord_refresh";
const REFRESH_COOKIE_PATH: &str = "/api/v1/auth";
const ACCESS_COOKIE_NAME: &str = "paracord_access";
const ACCESS_COOKIE_PATH: &str = "/api/v1";
const CHALLENGE_STORE_MAX_ENTRIES: usize = 10_000;
const MAX_DISPLAY_NAME_LEN: usize = 64;
const AUTH_GUARD_TTL_SECONDS: i64 = 3600;
const AUTH_GUARD_CLEANUP_LIMIT: i64 = 512;
const MAX_LOGIN_BODY_BYTES: usize = 16 * 1024;

// In-memory challenge nonce store (nonce -> timestamp). Cleaned up on each request.
static CHALLENGE_STORE: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
static AUTH_GUARD_OP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn challenge_store() -> &'static Mutex<HashMap<String, i64>> {
    CHALLENGE_STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cleanup_expired_challenges(store: &mut HashMap<String, i64>) {
    let now = Utc::now().timestamp();
    store.retain(|_, ts| (now - *ts).abs() <= 120);
}

fn cap_oldest_challenges(store: &mut HashMap<String, i64>) {
    if store.len() <= CHALLENGE_STORE_MAX_ENTRIES {
        return;
    }
    let mut entries: Vec<(String, i64)> = store.iter().map(|(k, v)| (k.clone(), *v)).collect();
    entries.sort_by_key(|(_, ts)| *ts);
    let overflow = store.len().saturating_sub(CHALLENGE_STORE_MAX_ENTRIES);
    for (key, _) in entries.into_iter().take(overflow) {
        store.remove(&key);
    }
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
        return Err(ApiError::RateLimited);
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

fn first_non_whitespace_byte(bytes: &[u8]) -> Option<u8> {
    bytes
        .iter()
        .copied()
        .find(|b| !matches!(b, b' ' | b'\n' | b'\r' | b'\t'))
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
/// (access_token, access_cookie, refresh_cookie, session_id, raw_refresh_token)
async fn issue_auth_session(
    state: &AppState,
    user_id: i64,
    public_key: Option<&str>,
    headers: &HeaderMap,
    peer_ip: Option<&str>,
) -> Result<(String, String, String, String, String), ApiError> {
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
    Ok((access_token, access_cookie, refresh_cookie, session_id, refresh_token))
}

/// Result: (access_token, access_cookie, refresh_cookie, session_id, raw_new_refresh_token)
async fn rotate_auth_session(
    state: &AppState,
    refresh_token: &str,
) -> Result<(String, String, String, String, String), ApiError> {
    let refresh_hash = sha256_hex(refresh_token);
    let now = Utc::now();
    let session = paracord_db::sessions::get_session_by_refresh_hash(&state.db, &refresh_hash)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::Unauthorized)?;
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
    Ok((access_token, access_cookie, refresh_cookie, session.id, new_refresh))
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

    if paracord_util::validation::validate_username(&body.username).is_err() {
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

    let (token, access_cookie, refresh_cookie, session_id, raw_refresh) = issue_auth_session(
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
        Some(json!({ "auth_method": "password" })),
    )
    .await;
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

    let (token, access_cookie, refresh_cookie, session_id, raw_refresh) = issue_auth_session(
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
    headers: HeaderMap,
    body: Option<Json<serde_json::Value>>,
) -> Result<impl IntoResponse, ApiError> {
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
    let (token, access_cookie, refresh_cookie, session_id, new_raw_refresh) =
        rotate_auth_session(&state, &refresh_token).await?;
    security::log_security_event(
        &state,
        "auth.refresh",
        None,
        None,
        Some(&session_id),
        Some(&headers),
        None,
    )
    .await;
    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
        ]),
        Json(json!({ "token": token, "refresh_token": new_raw_refresh })),
    ))
}

pub async fn logout(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
) -> Result<impl IntoResponse, ApiError> {
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
        None,
    )
    .await;

    let secure = should_use_secure_cookie(&state);
    let clear_access_cookie = build_access_cookie_clear(secure);
    let clear_refresh_cookie = build_refresh_cookie_clear(secure);
    Ok((
        StatusCode::NO_CONTENT,
        AppendHeaders([
            (header::SET_COOKIE, header_value(&clear_access_cookie)?),
            (header::SET_COOKIE, header_value(&clear_refresh_cookie)?),
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
    auth: AuthUser,
    Path(session_id): Path<String>,
) -> Result<axum::response::Response, ApiError> {
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
        None,
    )
    .await;

    let should_clear_cookie = auth.session_id.as_deref() == Some(session_id.as_str());
    if should_clear_cookie {
        let secure = should_use_secure_cookie(&state);
        let clear_access_cookie = build_access_cookie_clear(secure);
        let clear_refresh_cookie = build_refresh_cookie_clear(secure);
        Ok((
            StatusCode::NO_CONTENT,
            AppendHeaders([
                (header::SET_COOKIE, header_value(&clear_access_cookie)?),
                (header::SET_COOKIE, header_value(&clear_refresh_cookie)?),
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
}

pub async fn attach_public_key(
    State(state): State<AppState>,
    auth: AuthUser,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(body): Json<AttachPublicKeyRequest>,
) -> Result<impl IntoResponse, ApiError> {
    let peer_ip = addr.ip().to_string();
    // Validate public key format (64 hex chars = 32 bytes Ed25519 public key)
    if body.public_key.len() != 64 || !body.public_key.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(ApiError::BadRequest(
            "Invalid public key format (expected 64 hex characters)".into(),
        ));
    }

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
        // Already attached to this user — rotate current session token anyway.
    }

    // Attach the public key to the authenticated user's account.
    let user =
        paracord_db::users::update_user_public_key(&state.db, auth.user_id, &body.public_key)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    // Force global session invalidation on trust material change.
    let _ = paracord_db::sessions::revoke_all_user_sessions_except(
        &state.db,
        auth.user_id,
        None,
        "public_key_rotated",
        Utc::now(),
    )
    .await;

    let (token, access_cookie, refresh_cookie, session_id, raw_refresh) = issue_auth_session(
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
        Some(json!({ "sessions_revoked": true })),
    )
    .await;

    Ok((
        AppendHeaders([
            (header::SET_COOKIE, header_value(&access_cookie)?),
            (header::SET_COOKIE, header_value(&refresh_cookie)?),
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

    // Store the nonce.
    {
        let mut store = challenge_store()
            .lock()
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("lock error")))?;
        cleanup_expired_challenges(&mut store);
        store.insert(nonce.clone(), timestamp);
        cap_oldest_challenges(&mut store);
    }

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

    if paracord_util::validation::validate_username(&body.username).is_err() {
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

    // Validate public key format (64 hex chars = 32 bytes).
    if body.public_key.len() != 64 {
        auth_guard_record_failure(
            &state,
            &headers,
            Some(peer_ip.as_str()),
            Some(&body.public_key),
        )
        .await;
        return Err(ApiError::BadRequest("Invalid public key".into()));
    }

    // Consume the nonce (one-time use) without holding the mutex across awaits.
    let nonce_consumed = {
        let mut store = challenge_store()
            .lock()
            .map_err(|_| ApiError::Internal(anyhow::anyhow!("lock error")))?;
        store.remove(&body.nonce).is_some()
    };
    if !nonce_consumed {
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

    let (token, access_cookie, refresh_cookie, session_id, raw_refresh) = issue_auth_session(
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
        auth_guard_keys, build_refresh_cookie, get_cookie_value, normalize_email_for_auth,
        parse_login_form_value, parse_login_json_value, parse_login_request,
        parse_username_with_discriminator, resolve_server_origin,
        should_use_secure_cookie_with_public_url, synthesized_local_email,
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
    fn parse_login_request_accepts_form_content_type() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("application/x-www-form-urlencoded"),
        );
        let parsed = parse_login_request(&headers, b"username=alice&password=secret-123")
            .expect("form payload should deserialize with content-type");
        assert_eq!(parsed.email, "alice");
        assert_eq!(parsed.password, "secret-123");
    }

    #[test]
    fn parse_login_request_tolerates_null_identifier_fields() {
        let headers = HeaderMap::new();
        let parsed = parse_login_request(
            &headers,
            br#"{"identifier":null,"email":null,"password":"secret-123"}"#,
        )
        .expect("null identifiers should not hard-fail login payload parsing");
        assert!(parsed.email.is_empty());
        assert_eq!(parsed.password, "secret-123");
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
