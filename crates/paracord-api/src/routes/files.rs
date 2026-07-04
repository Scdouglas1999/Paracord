use axum::{
    extract::{Multipart, Path, State},
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    Json,
};
use chrono::{Duration, Utc};
use jsonwebtoken::{Algorithm, EncodingKey, Header as JwtHeader};
use paracord_core::AppState;
use paracord_models::permissions::Permissions;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::error::ApiError;
use crate::middleware::AuthUser;

const PENDING_ATTACHMENT_TTL_MINUTES: i64 = 15;
const PENDING_ATTACHMENT_CLEANUP_BATCH: i64 = 128;
const MALWARE_SCAN_BIN_ENV: &str = "PARACORD_MALWARE_SCAN_BIN";
const MALWARE_SCAN_ARGS_ENV: &str = "PARACORD_MALWARE_SCAN_ARGS";
const MALWARE_SCAN_FAIL_CLOSED_ENV: &str = "PARACORD_MALWARE_SCAN_FAIL_CLOSED";
const MALWARE_SCAN_INFECTED_EXIT_CODES_ENV: &str = "PARACORD_MALWARE_SCAN_INFECTED_EXIT_CODES";
const MALWARE_QUARANTINE_PATH_ENV: &str = "PARACORD_MALWARE_QUARANTINE_PATH";
const ATTACHMENT_AAD_PREFIX: &str = "attachment:";

fn attachment_aad(attachment_id: i64) -> String {
    format!("{ATTACHMENT_AAD_PREFIX}{attachment_id}")
}

fn sanitize_filename_for_disposition(filename: &str) -> String {
    filename
        .chars()
        .filter(|ch| *ch != '"' && *ch != '\\' && *ch != '\r' && *ch != '\n')
        .collect()
}

fn has_active_extension(filename: &str) -> bool {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());
    matches!(
        ext.as_deref(),
        Some("html")
            | Some("htm")
            | Some("xhtml")
            | Some("svg")
            | Some("xml")
            | Some("js")
            | Some("mjs")
            | Some("cjs")
    )
}

fn body_looks_like_active_content(data: &[u8]) -> bool {
    let sample_len = data.len().min(512);
    let sample = String::from_utf8_lossy(&data[..sample_len]).to_ascii_lowercase();
    sample.contains("<!doctype html")
        || sample.contains("<html")
        || sample.contains("<script")
        || sample.contains("<svg")
}

fn normalized_content_type(filename: &str, claimed: Option<&str>) -> String {
    let guessed = mime_guess::from_path(filename)
        .first_raw()
        .map(str::to_string);
    let claimed = claimed.map(|s| s.trim().to_ascii_lowercase());

    let preferred = claimed
        .as_deref()
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| guessed.as_deref().unwrap_or("application/octet-stream"));

    preferred
        .split(';')
        .next()
        .unwrap_or("application/octet-stream")
        .trim()
        .to_string()
}

fn is_inline_safe_content_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp"
            | "image/avif"
            | "audio/mpeg"
            | "audio/ogg"
            | "audio/wav"
            | "video/mp4"
            | "video/webm"
            | "text/plain"
            | "application/pdf"
    )
}

fn is_active_content_type(content_type: &str) -> bool {
    matches!(
        content_type,
        "text/html"
            | "application/xhtml+xml"
            | "image/svg+xml"
            | "text/xml"
            | "application/xml"
            | "application/javascript"
            | "text/javascript"
    )
}

fn resolve_stored_content_type(filename: &str, claimed: Option<&str>, data: &[u8]) -> String {
    if has_active_extension(filename) || body_looks_like_active_content(data) {
        return "application/octet-stream".to_string();
    }

    let normalized = normalized_content_type(filename, claimed);
    if is_active_content_type(&normalized) {
        return "application/octet-stream".to_string();
    }

    normalized
}

pub(crate) fn build_content_disposition(filename: &str, allow_inline: bool) -> String {
    let safe_name = sanitize_filename_for_disposition(filename);
    if allow_inline {
        format!("inline; filename=\"{}\"", safe_name)
    } else {
        format!("attachment; filename=\"{}\"", safe_name)
    }
}

/// Build the standard download response headers: content type, disposition, and
/// an unconditional `X-Content-Type-Options: nosniff`. Shared by the local and
/// federated download paths so the anti-sniffing guard can never be dropped.
pub(crate) fn download_response_headers(
    content_type: &str,
    disposition: &str,
) -> [(header::HeaderName, HeaderValue); 3] {
    [
        (
            header::CONTENT_TYPE,
            HeaderValue::from_str(content_type)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        ),
        (
            header::CONTENT_DISPOSITION,
            HeaderValue::from_str(disposition).unwrap_or(HeaderValue::from_static("attachment")),
        ),
        (
            header::X_CONTENT_TYPE_OPTIONS,
            HeaderValue::from_static("nosniff"),
        ),
    ]
}

/// Resolved federation file-cache settings, read from `server_settings` at
/// request time so admin edits take effect without a server restart. Falls back
/// to the static config defaults when a key is unset.
struct FederationCacheSettings {
    enabled: bool,
    max_size: u64,
    ttl_hours: u64,
}

async fn resolve_federation_cache_settings(state: &AppState) -> FederationCacheSettings {
    FederationCacheSettings {
        enabled: paracord_db::server_settings::get_bool_setting(
            &state.db,
            "federation_file_cache_enabled",
            state.config.federation_file_cache_enabled,
        )
        .await,
        max_size: paracord_db::server_settings::get_u64_setting(
            &state.db,
            "federation_file_cache_max_size",
            state.config.federation_file_cache_max_size,
        )
        .await,
        ttl_hours: paracord_db::server_settings::get_u64_setting(
            &state.db,
            "federation_file_cache_ttl_hours",
            state.config.federation_file_cache_ttl_hours,
        )
        .await,
    }
}

fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .and_then(|v| match v.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => Some(true),
            "0" | "false" | "no" | "off" => Some(false),
            _ => None,
        })
        .unwrap_or(default)
}

fn parse_infected_exit_codes() -> Vec<i32> {
    std::env::var(MALWARE_SCAN_INFECTED_EXIT_CODES_ENV)
        .ok()
        .map(|raw| {
            raw.split(',')
                .filter_map(|part| part.trim().parse::<i32>().ok())
                .collect::<Vec<_>>()
        })
        .filter(|codes| !codes.is_empty())
        .unwrap_or_else(|| vec![1])
}

fn sanitize_filename_for_path(filename: &str) -> String {
    let mut out = String::new();
    for ch in filename.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "upload.bin".to_string()
    } else {
        out
    }
}

fn build_scanner_command(
    file_path: &std::path::Path,
    filename: &str,
) -> Option<(String, Vec<String>)> {
    let bin = std::env::var(MALWARE_SCAN_BIN_ENV).ok()?;
    let bin = bin.trim();
    if bin.is_empty() {
        return None;
    }

    let file_str = file_path.to_string_lossy().to_string();
    let safe_filename = sanitize_filename_for_path(filename);
    let mut args = std::env::var(MALWARE_SCAN_ARGS_ENV)
        .ok()
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|part| !part.is_empty())
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let mut has_file_placeholder = false;
    for arg in &mut args {
        if arg.contains("{file}") {
            *arg = arg.replace("{file}", &file_str);
            has_file_placeholder = true;
        }
        if arg.contains("{filename}") {
            *arg = arg.replace("{filename}", &safe_filename);
        }
    }

    if !has_file_placeholder {
        args.push(file_str);
    }

    Some((bin.to_string(), args))
}

async fn move_to_quarantine(
    temp_file: &std::path::Path,
    storage_path: &str,
    attachment_id: i64,
    filename: &str,
) {
    let quarantine_dir = std::env::var(MALWARE_QUARANTINE_PATH_ENV)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::Path::new(storage_path).join("quarantine"));
    if let Err(err) = tokio::fs::create_dir_all(&quarantine_dir).await {
        tracing::warn!(
            "Failed to create quarantine directory {:?}: {}",
            quarantine_dir,
            err
        );
        return;
    }

    let safe_name = sanitize_filename_for_path(filename);
    let target = quarantine_dir.join(format!("{}_{}", attachment_id, safe_name));

    if let Err(err) = tokio::fs::rename(temp_file, &target).await {
        // Cross-device rename fallback.
        if let Err(copy_err) = tokio::fs::copy(temp_file, &target).await {
            tracing::warn!(
                "Failed moving malware sample to quarantine {:?}: {} (copy fallback: {})",
                target,
                err,
                copy_err
            );
            let _ = tokio::fs::remove_file(temp_file).await;
            return;
        }
        let _ = tokio::fs::remove_file(temp_file).await;
    }
}

async fn scan_upload_with_malware_hook(
    data: &[u8],
    filename: &str,
    storage_path: &str,
    attachment_id: i64,
) -> Result<(), ApiError> {
    let scan_bin = std::env::var(MALWARE_SCAN_BIN_ENV)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    if scan_bin.is_none() {
        return Ok(());
    }

    let temp_dir = std::env::temp_dir().join("paracord-upload-scan");
    tokio::fs::create_dir_all(&temp_dir)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let temp_file = temp_dir.join(format!(
        "scan-{}-{}.bin",
        attachment_id,
        uuid::Uuid::new_v4()
    ));
    tokio::fs::write(&temp_file, data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let (scan_bin, scan_args) = build_scanner_command(&temp_file, filename).unwrap_or_else(|| {
        (
            scan_bin.unwrap_or_default(),
            vec![temp_file.to_string_lossy().to_string()],
        )
    });

    let fail_closed = env_bool(MALWARE_SCAN_FAIL_CLOSED_ENV, true);
    let infected_codes = parse_infected_exit_codes();

    let output = tokio::process::Command::new(&scan_bin)
        .args(&scan_args)
        .output()
        .await;

    match output {
        Ok(result) if result.status.success() => {
            let _ = tokio::fs::remove_file(&temp_file).await;
            Ok(())
        }
        Ok(result) => {
            let exit_code = result.status.code().unwrap_or(-1);
            if infected_codes.contains(&exit_code) {
                move_to_quarantine(&temp_file, storage_path, attachment_id, filename).await;
                tracing::warn!(
                    "Malware scanner blocked upload id={} filename='{}' exit_code={}",
                    attachment_id,
                    sanitize_filename_for_disposition(filename),
                    exit_code
                );
                Err(ApiError::BadRequest(
                    "File upload blocked by malware scanning policy".into(),
                ))
            } else {
                let _ = tokio::fs::remove_file(&temp_file).await;
                if fail_closed {
                    Err(ApiError::ServiceUnavailable(
                        "Malware scanner failed; upload rejected".into(),
                    ))
                } else {
                    tracing::warn!(
                        "Malware scanner returned unexpected exit code {} for upload id={}; allowing due to fail-open configuration",
                        exit_code,
                        attachment_id
                    );
                    Ok(())
                }
            }
        }
        Err(err) => {
            let _ = tokio::fs::remove_file(&temp_file).await;
            if fail_closed {
                Err(ApiError::ServiceUnavailable(
                    "Malware scanner unavailable".into(),
                ))
            } else {
                tracing::warn!(
                    "Malware scanner command failed for upload id={}: {} (fail-open)",
                    attachment_id,
                    err
                );
                Ok(())
            }
        }
    }
}

fn mime_matches_pattern(content_type: &str, pattern: &str) -> bool {
    if pattern == "*" || pattern == "*/*" {
        return true;
    }
    if pattern.ends_with("/*") {
        let prefix = &pattern[..pattern.len() - 1];
        return content_type.starts_with(prefix);
    }
    content_type == pattern
}

async fn check_guild_upload_policy(
    state: &AppState,
    channel_id: i64,
    file_size: u64,
    content_type: &str,
) -> Result<(), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let guild_id = match channel.as_ref().and_then(|c| c.guild_id()) {
        Some(id) => id,
        None => return Ok(()),
    };

    let policy = paracord_db::guild_storage_policies::get_guild_storage_policy(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let Some(policy) = policy else {
        return Ok(());
    };

    if let Some(max_file_size) = policy.max_file_size {
        if file_size > max_file_size as u64 {
            return Err(ApiError::BadRequest(
                "File exceeds guild maximum file size limit".into(),
            ));
        }
    }

    if let Some(storage_quota) = policy.storage_quota {
        let current_usage =
            paracord_db::guild_storage_policies::get_guild_storage_usage(&state.db, guild_id)
                .await
                .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
        if (current_usage as u64).saturating_add(file_size) > storage_quota as u64 {
            return Err(ApiError::BadRequest(
                "Upload would exceed guild storage quota".into(),
            ));
        }
    }

    if let Some(ref allowed_json) = policy.allowed_types {
        if let Ok(allowed) = serde_json::from_str::<Vec<String>>(allowed_json) {
            if !allowed.is_empty()
                && !allowed
                    .iter()
                    .any(|pattern| mime_matches_pattern(content_type, pattern))
            {
                return Err(ApiError::BadRequest(
                    "File type not allowed by guild policy".into(),
                ));
            }
        }
    }

    if let Some(ref blocked_json) = policy.blocked_types {
        if let Ok(blocked) = serde_json::from_str::<Vec<String>>(blocked_json) {
            if blocked
                .iter()
                .any(|pattern| mime_matches_pattern(content_type, pattern))
            {
                return Err(ApiError::BadRequest(
                    "File type blocked by guild policy".into(),
                ));
            }
        }
    }

    Ok(())
}

async fn cleanup_expired_pending_attachments(state: &AppState) {
    let now = Utc::now();
    let expired = match paracord_db::attachments::get_expired_pending_attachments(
        &state.db,
        now,
        PENDING_ATTACHMENT_CLEANUP_BATCH,
    )
    .await
    {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("Failed loading expired pending attachments: {}", err);
            return;
        }
    };

    for attachment in expired {
        if let Err(err) =
            paracord_db::attachments::delete_attachment(&state.db, attachment.id).await
        {
            tracing::warn!(
                "Failed deleting expired attachment {} metadata: {}",
                attachment.id,
                err
            );
            continue;
        }

        let ext = std::path::Path::new(&attachment.filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin");
        let storage_key = format!("attachments/{}.{}", attachment.id, ext);
        let _ = state.storage_backend.delete(&storage_key).await;
    }
}

pub async fn upload_file(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(channel_id): Path<i64>,
    mut multipart: Multipart,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    cleanup_expired_pending_attachments(&state).await;

    // Verify channel exists and caller can send attachments.
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        paracord_core::permissions::require_permission(perms, Permissions::ATTACH_FILES)?;
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel_id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }

    let field = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
        .ok_or_else(|| ApiError::BadRequest("No file provided".into()))?;

    let filename = field.file_name().unwrap_or("upload").to_string();
    let claimed_content_type = field.content_type().map(|s| s.to_string());
    let data = field
        .bytes()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?;

    let size =
        u64::try_from(data.len()).map_err(|_| ApiError::BadRequest("File too large".into()))?;

    if size == 0 {
        return Err(ApiError::BadRequest("Empty file".into()));
    }

    if size > state.config.max_upload_size {
        return Err(ApiError::BadRequest("File too large".into()));
    }
    let db_size = i32::try_from(size).map_err(|_| ApiError::BadRequest("File too large".into()))?;

    // Compute SHA-256 content hash
    let mut hasher = Sha256::new();
    hasher.update(&data);
    let content_hash = format!("{:x}", hasher.finalize());

    // Check guild-level upload policy against the type that will be stored,
    // after active-content downgrades. Otherwise a forged Content-Type could
    // bypass an allowlist before being persisted as application/octet-stream.
    let content_type =
        resolve_stored_content_type(&filename, claimed_content_type.as_deref(), &data);
    check_guild_upload_policy(&state, channel_id, size, &content_type).await?;

    // Store file via storage backend
    let attachment_id = paracord_util::snowflake::generate(1);
    scan_upload_with_malware_hook(&data, &filename, &state.config.storage_path, attachment_id)
        .await?;

    let ext = std::path::Path::new(&filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let storage_key = format!("attachments/{}.{}", attachment_id, ext);

    let stored_payload = if let Some(cryptor) = state.config.file_cryptor.as_ref() {
        let aad = attachment_aad(attachment_id);
        cryptor
            .encrypt_with_aad(&data, aad.as_bytes())
            .map_err(|err| ApiError::Internal(anyhow::anyhow!(err.to_string())))?
    } else {
        data.to_vec()
    };

    state
        .storage_backend
        .store(&storage_key, &stored_payload)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let url = format!("/api/v1/attachments/{}", attachment_id);
    let expires_at = Utc::now() + Duration::minutes(PENDING_ATTACHMENT_TTL_MINUTES);

    let attachment = paracord_db::attachments::create_attachment(
        &state.db,
        attachment_id,
        None, // pending attachment; linked during message creation
        &filename,
        Some(&content_type),
        db_size,
        &url,
        None,
        None,
        Some(auth.user_id),
        Some(channel_id),
        Some(expires_at),
        Some(&content_hash),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "id": attachment.id.to_string(),
            "filename": attachment.filename,
            "size": attachment.size,
            "content_type": attachment.content_type,
            "url": attachment.url,
        })),
    ))
}

pub async fn download_file(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<impl IntoResponse, ApiError> {
    let attachment = paracord_db::attachments::get_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let message_id = attachment.message_id.ok_or(ApiError::NotFound)?;
    let message = paracord_db::messages::get_message(&state.db, message_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channel = paracord_db::channels::get_channel(&state.db, message.channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel.id,
            guild.owner_id,
            auth.user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        paracord_core::permissions::require_permission(perms, Permissions::READ_MESSAGE_HISTORY)?;
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel.id, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }

    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let storage_key = format!("attachments/{}.{}", attachment.id, ext);
    let stored_data = state
        .storage_backend
        .retrieve(&storage_key)
        .await
        .map_err(|_| ApiError::NotFound)?;
    let data = if let Some(cryptor) = state.config.file_cryptor.as_ref() {
        let aad = attachment_aad(attachment.id);
        match cryptor.decrypt_with_aad(&stored_data, aad.as_bytes()) {
            Ok(decrypted) => decrypted,
            Err(paracord_util::at_rest::FileCryptoError::PlaintextReadDisabled)
                if !paracord_util::at_rest::FileCryptor::payload_is_encrypted(&stored_data) =>
            {
                tracing::warn!(
                    "Serving legacy plaintext attachment {} while file encryption is enabled; re-encrypting in place",
                    attachment.id
                );
                match cryptor.encrypt_with_aad(&stored_data, aad.as_bytes()) {
                    Ok(reencrypted) => {
                        if let Err(err) = state
                            .storage_backend
                            .store(&storage_key, &reencrypted)
                            .await
                        {
                            tracing::warn!(
                                "Failed to re-encrypt attachment {} in storage: {}",
                                attachment.id,
                                err
                            );
                        }
                    }
                    Err(err) => {
                        tracing::warn!(
                            "Failed to encrypt legacy plaintext attachment {}: {}",
                            attachment.id,
                            err
                        );
                    }
                }
                stored_data
            }
            Err(err) => return Err(ApiError::Internal(anyhow::anyhow!(err.to_string()))),
        }
    } else {
        stored_data
    };
    let content_type = attachment
        .content_type
        .clone()
        .unwrap_or_else(|| "application/octet-stream".to_string());
    let allow_inline =
        is_inline_safe_content_type(&content_type) && !has_active_extension(&attachment.filename);
    let disposition = build_content_disposition(&attachment.filename, allow_inline);

    Ok((download_response_headers(&content_type, &disposition), data))
}

pub async fn delete_file(
    State(state): State<AppState>,
    _auth: AuthUser,
    Path(id): Path<i64>,
) -> Result<StatusCode, ApiError> {
    let attachment = paracord_db::attachments::get_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    if let Some(message_id) = attachment.message_id {
        let message = paracord_db::messages::get_message(&state.db, message_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        if message.author_id != _auth.user_id {
            return Err(ApiError::Forbidden);
        }
    } else if attachment.uploader_id != Some(_auth.user_id) {
        return Err(ApiError::Forbidden);
    }

    paracord_db::attachments::delete_attachment(&state.db, id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let ext = std::path::Path::new(&attachment.filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let storage_key = format!("attachments/{}.{}", attachment.id, ext);
    let _ = state.storage_backend.delete(&storage_key).await;

    Ok(StatusCode::NO_CONTENT)
}

// ── Shared file processing functions (used by both HTTP and QUIC paths) ──────

/// Validate that a user has permission to upload files to a channel.
pub async fn validate_upload_permissions(
    state: &AppState,
    channel_id: i64,
    user_id: i64,
) -> Result<(), ApiError> {
    let channel = paracord_db::channels::get_channel(&state.db, channel_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    if let Some(guild_id) = channel.guild_id() {
        paracord_core::permissions::ensure_guild_member(&state.db, guild_id, user_id).await?;
        let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
            .ok_or(ApiError::NotFound)?;
        let perms = paracord_core::permissions::compute_channel_permissions(
            &state.db,
            guild_id,
            channel_id,
            guild.owner_id,
            user_id,
        )
        .await?;
        paracord_core::permissions::require_permission(perms, Permissions::VIEW_CHANNEL)?;
        paracord_core::permissions::require_permission(perms, Permissions::ATTACH_FILES)?;
    } else if !paracord_db::dms::is_dm_recipient(&state.db, channel_id, user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
    {
        return Err(ApiError::Forbidden);
    }
    Ok(())
}

/// Process an uploaded file: malware scan, encrypt, store, and create DB record.
///
/// Returns the attachment JSON value on success.
pub async fn process_uploaded_file(
    state: &AppState,
    data: &[u8],
    filename: &str,
    claimed_content_type: Option<&str>,
    channel_id: i64,
    user_id: i64,
) -> Result<Value, ApiError> {
    let size =
        u64::try_from(data.len()).map_err(|_| ApiError::BadRequest("File too large".into()))?;
    if size == 0 {
        return Err(ApiError::BadRequest("Empty file".into()));
    }
    if size > state.config.max_upload_size {
        return Err(ApiError::BadRequest("File too large".into()));
    }
    let db_size = i32::try_from(size).map_err(|_| ApiError::BadRequest("File too large".into()))?;

    // Compute SHA-256 content hash
    let mut hasher = Sha256::new();
    hasher.update(data);
    let content_hash = format!("{:x}", hasher.finalize());

    // Check guild-level upload policy against the type that will be stored,
    // after active-content downgrades.
    let content_type = resolve_stored_content_type(filename, claimed_content_type, data);
    check_guild_upload_policy(state, channel_id, size, &content_type).await?;

    let attachment_id = paracord_util::snowflake::generate(1);
    scan_upload_with_malware_hook(data, filename, &state.config.storage_path, attachment_id)
        .await?;

    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("bin");
    let storage_key = format!("attachments/{}.{}", attachment_id, ext);

    let stored_payload = if let Some(cryptor) = state.config.file_cryptor.as_ref() {
        let aad = attachment_aad(attachment_id);
        cryptor
            .encrypt_with_aad(data, aad.as_bytes())
            .map_err(|err| ApiError::Internal(anyhow::anyhow!(err.to_string())))?
    } else {
        data.to_vec()
    };

    state
        .storage_backend
        .store(&storage_key, &stored_payload)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let url = format!("/api/v1/attachments/{}", attachment_id);
    let expires_at = Utc::now() + Duration::minutes(PENDING_ATTACHMENT_TTL_MINUTES);

    let attachment = paracord_db::attachments::create_attachment(
        &state.db,
        attachment_id,
        None,
        filename,
        Some(&content_type),
        db_size,
        &url,
        None,
        None,
        Some(user_id),
        Some(channel_id),
        Some(expires_at),
        Some(&content_hash),
    )
    .await
    .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    Ok(json!({
        "id": attachment.id.to_string(),
        "filename": attachment.filename,
        "size": attachment.size,
        "content_type": attachment.content_type,
        "url": attachment.url,
    }))
}

// ── Upload token endpoint (QUIC pre-authorization) ──────────────────────────

#[derive(Deserialize)]
pub struct UploadTokenRequest {
    pub filename: String,
    pub size: u64,
    #[serde(default = "default_content_type")]
    pub content_type: String,
}

fn default_content_type() -> String {
    "application/octet-stream".to_string()
}

#[derive(Serialize)]
struct FileTransferClaims {
    sub: i64,
    tid: String,
    cid: i64,
    fname: String,
    fsize: u64,
    exp: usize,
    iat: usize,
}

pub async fn upload_token(
    State(state): State<AppState>,
    auth: AuthUser,
    headers: HeaderMap,
    Path(channel_id): Path<i64>,
    Json(req): Json<UploadTokenRequest>,
) -> Result<Json<Value>, ApiError> {
    // 1. Validate permissions
    validate_upload_permissions(&state, channel_id, auth.user_id).await?;

    // 2. Validate file size
    if req.size == 0 {
        return Err(ApiError::BadRequest("Empty file".into()));
    }
    if req.size > state.config.max_upload_size {
        return Err(ApiError::BadRequest("File too large".into()));
    }

    // 2b. Check guild-level upload policy (size, quota, type restrictions).
    // The token path cannot inspect bytes yet, but it can still apply the
    // same extension/claimed-type active-content downgrades used at storage.
    let resolved_ct = resolve_stored_content_type(&req.filename, Some(&req.content_type), &[]);
    check_guild_upload_policy(&state, channel_id, req.size, &resolved_ct).await?;

    // 3. Generate transfer ID
    let transfer_id = paracord_util::snowflake::generate(1).to_string();

    // 4. Mint upload JWT (15 min expiry)
    let now = Utc::now();
    let claims = FileTransferClaims {
        sub: auth.user_id,
        tid: transfer_id.clone(),
        cid: channel_id,
        fname: req.filename.clone(),
        fsize: req.size,
        exp: (now.timestamp() + 900) as usize,
        iat: now.timestamp() as usize,
    };

    let upload_token = jsonwebtoken::encode(
        &JwtHeader::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(state.config.jwt_secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(anyhow::anyhow!("JWT encode error: {}", e)))?;

    // 5. Determine QUIC endpoint availability
    let cert_hash = state
        .native_media
        .as_ref()
        .map(|native| native.cert_hash.clone());
    let quic_available = cert_hash.is_some();
    let quic_endpoint = if quic_available {
        let host = headers
            .get("x-forwarded-host")
            .or_else(|| headers.get("host"))
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.split(',').next())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .unwrap_or("localhost");
        let host_no_port = host.split(':').next().unwrap_or(host);
        let proto = headers
            .get("x-forwarded-proto")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("https");
        format!(
            "{}://{}:{}/media",
            proto, host_no_port, state.config.native_media_port
        )
    } else {
        String::new()
    };

    Ok(Json(json!({
        "transfer_id": transfer_id,
        "upload_token": upload_token,
        "quic_endpoint": quic_endpoint,
        "quic_available": quic_available,
        "cert_hash": cert_hash,
    })))
}

// ── Federated file proxy ────────────────────────────────────────────────────

pub async fn download_federated_file(
    State(state): State<AppState>,
    auth: AuthUser,
    Path((origin_server, attachment_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, ApiError> {
    // Check that the user is a member of at least one guild federated with origin_server
    let space_mappings =
        paracord_db::federation::list_space_mappings_by_origin(&state.db, &origin_server)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let mut has_access = false;
    for mapping in &space_mappings {
        let member =
            paracord_db::members::get_member(&state.db, auth.user_id, mapping.local_guild_id)
                .await
                .ok()
                .flatten();
        if member.is_some() {
            has_access = true;
            break;
        }
    }
    if !has_access {
        return Err(ApiError::Forbidden);
    }

    let server = paracord_db::federation::get_federated_server(&state.db, &origin_server)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;

    let service = crate::routes::federation::build_federation_service();
    let client = crate::routes::federation::build_signed_federation_client(&service)
        .ok_or_else(|| ApiError::Internal(anyhow::anyhow!("federation client unavailable")))?;

    let room_id = space_mappings
        .first()
        .map(|m| format!("!{}:{}", m.remote_space_id, m.origin_server))
        .unwrap_or_default();
    let user = paracord_db::users::get_user_by_id(&state.db, auth.user_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let user_id = format!("@{}:{}", user.username, service.domain());

    let token_resp = client
        .request_file_token(
            &server.federation_endpoint,
            &paracord_federation::client::FederationFileTokenRequest {
                origin_server: service.server_name().to_string(),
                attachment_id: attachment_id.clone(),
                room_id,
                user_id,
            },
        )
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("failed to get file token: {}", e)))?;

    // Check federation file cache for a cached copy
    if let Ok(Some(cached)) = paracord_db::federation_file_cache::get_cached_file(
        &state.db,
        &origin_server,
        &attachment_id,
    )
    .await
    {
        let now_str = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let is_expired = cached
            .expires_at
            .as_deref()
            .is_some_and(|exp| exp < now_str.as_str());
        if !is_expired {
            let _ =
                paracord_db::federation_file_cache::update_cache_access_time(&state.db, cached.id)
                    .await;

            let data = state
                .storage_backend
                .retrieve(&cached.storage_key)
                .await
                .map_err(|_| ApiError::NotFound)?;

            let content_type = cached
                .content_type
                .clone()
                .unwrap_or_else(|| "application/octet-stream".to_string());
            let disposition = build_content_disposition(&cached.filename, false);

            return Ok((download_response_headers(&content_type, &disposition), data));
        }
    }

    // Download the file from origin
    let full_download_url = if token_resp.download_url.starts_with("http") {
        token_resp.download_url.clone()
    } else {
        format!(
            "{}{}",
            server
                .federation_endpoint
                .trim_end_matches('/')
                .trim_end_matches("/v1"),
            token_resp.download_url
        )
    };

    // Resolve cache settings before downloading so the operator-configured
    // maximum bounds the streamed body: download_federated_file_with_limit
    // rejects the transfer (up front via Content-Length and while streaming)
    // once it exceeds max_size, instead of buffering up to the 1 GiB default
    // into RAM before the post-download cache guard runs. Settings are read
    // from server_settings at request time so admin edits apply without a
    // restart.
    let cache_settings = resolve_federation_cache_settings(&state).await;

    let (file_data, resp_content_type, resp_filename) = client
        .download_federated_file_with_limit(&full_download_url, cache_settings.max_size)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!("failed to download file: {}", e)))?;

    let content_type = resp_content_type.unwrap_or_else(|| "application/octet-stream".to_string());
    let filename = resp_filename.unwrap_or_else(|| format!("federated_{}", attachment_id));

    // Optionally cache the file.
    if cache_settings.enabled {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(&file_data);
        let hash = format!("{:x}", hasher.finalize());

        let cache_key = format!("fed-cache/{}/{}", origin_server, attachment_id);
        let cache_size = paracord_db::federation_file_cache::get_total_cache_size(&state.db)
            .await
            .unwrap_or(0);
        if cache_size + file_data.len() as i64 <= cache_settings.max_size as i64 {
            if state
                .storage_backend
                .store(&cache_key, &file_data)
                .await
                .is_ok()
            {
                let expires =
                    chrono::Utc::now() + chrono::Duration::hours(cache_settings.ttl_hours as i64);
                let expires_str = expires.format("%Y-%m-%d %H:%M:%S").to_string();
                let _ = paracord_db::federation_file_cache::insert_cached_file(
                    &state.db,
                    &origin_server,
                    &attachment_id,
                    &hash,
                    &filename,
                    Some(&content_type),
                    file_data.len() as i64,
                    &cache_key,
                    Some(&expires_str),
                )
                .await;
            }
        }
    }

    let disposition = build_content_disposition(&filename, false);

    Ok((
        download_response_headers(&content_type, &disposition),
        file_data,
    ))
}

#[cfg(test)]
mod tests {
    use super::{
        build_content_disposition, is_inline_safe_content_type, resolve_stored_content_type,
    };

    #[test]
    fn forces_octet_stream_for_active_content() {
        let html = b"<!doctype html><html><script>alert(1)</script></html>";
        let content_type = resolve_stored_content_type("payload.html", Some("text/html"), html);
        assert_eq!(content_type, "application/octet-stream");
    }

    #[test]
    fn keeps_safe_image_content_type() {
        let png_header = b"\x89PNG\r\n\x1a\n";
        let content_type = resolve_stored_content_type("image.png", Some("image/png"), png_header);
        assert_eq!(content_type, "image/png");
        assert!(is_inline_safe_content_type(&content_type));
    }

    #[test]
    fn content_disposition_sanitizes_filename() {
        let disposition = build_content_disposition("bad\"name\r\n.js", false);
        assert_eq!(disposition, "attachment; filename=\"badname.js\"");
    }
}
