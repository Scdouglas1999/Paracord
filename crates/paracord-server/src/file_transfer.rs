//! Production WebTransport uploads, isolated from voice-session authentication.
//!
//! HTTP issues a short-lived, session-bound capability for one file. Admission
//! reserves that exact transfer and its declared bytes before accepting data;
//! storage uses the same permissions, scan, encryption and quota path as HTTP.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{bail, Context, Result};
use paracord_core::AppState;
use paracord_transport::control::{ControlMessage, StreamFrame};
use paracord_transport::file_transfer::{
    handle_authorized_upload_stream, FileTransferClaims, PartialUploadManager, TransferTracker,
    MAX_FILE_SIZE,
};
use paracord_transport::webtransport::WebTransportSession;
use serde::Deserialize;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

const AUTH_TIMEOUT: Duration = Duration::from_secs(10);
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);
const BYTE_UNIT: u64 = 1024 * 1024;

#[derive(Deserialize)]
struct UploadClaims {
    purpose: String,
    auth_sid: String,
    content_type: String,
    #[serde(flatten)]
    file: FileTransferClaims,
}

fn validate_token(token: &str, secret: &str, max_size: u64) -> Result<UploadClaims> {
    let mut validation = jsonwebtoken::Validation::new(jsonwebtoken::Algorithm::HS256);
    validation.leeway = 0;
    let claims = jsonwebtoken::decode::<UploadClaims>(
        token,
        &jsonwebtoken::DecodingKey::from_secret(secret.as_bytes()),
        &validation,
    )?
    .claims;
    let now = chrono::Utc::now().timestamp().max(0) as usize;
    if claims.purpose != "file_upload_v1"
        || claims.auth_sid.is_empty()
        || claims.file.sub <= 0
        || claims.file.cid <= 0
        || !claims.file.tid.bytes().all(|byte| byte.is_ascii_digit())
        || claims.file.tid.starts_with('0')
        || claims
            .file
            .tid
            .parse::<i64>()
            .ok()
            .filter(|id| *id > 0)
            .is_none()
        || claims.file.fsize == 0
        || claims.file.fsize > max_size.min(MAX_FILE_SIZE)
        || claims.file.iat > now.saturating_add(60)
        || claims.file.exp <= now
        || claims.file.exp > claims.file.iat.saturating_add(900)
        || claims.file.fname.chars().count() > 255
        || claims.content_type.chars().count() > 127
    {
        bail!("invalid upload capability");
    }
    Ok(claims)
}

#[derive(Default)]
struct ActiveUploads {
    transfers: HashSet<String>,
    users: HashMap<i64, usize>,
}

pub struct FileTransferRuntime {
    state: AppState,
    tracker: TransferTracker,
    partial: PartialUploadManager,
    active: Mutex<ActiveUploads>,
    connections: Arc<Semaphore>,
    bytes: Arc<Semaphore>,
}

struct Reservation<'a> {
    runtime: &'a FileTransferRuntime,
    transfer_id: String,
    user_id: i64,
    _bytes: OwnedSemaphorePermit,
}

impl Drop for Reservation<'_> {
    fn drop(&mut self) {
        let mut active = self.runtime.active.lock().unwrap();
        active.transfers.remove(&self.transfer_id);
        if let Some(count) = active.users.get_mut(&self.user_id) {
            *count -= 1;
            if *count == 0 {
                active.users.remove(&self.user_id);
            }
        }
    }
}

// Called while the runtime's active-transfer lock is held.
fn reserve_byte_capacity(
    budget: &Arc<Semaphore>,
    directory: &std::path::Path,
    active: &HashSet<String>,
    transfer_id: &str,
    size: u64,
) -> Result<OwnedSemaphorePermit> {
    let mut idle_units = 0u64;
    match std::fs::read_dir(directory) {
        Ok(entries) => {
            for entry in entries {
                let entry = entry?;
                let path = entry.path();
                if path.extension().and_then(|value| value.to_str()) != Some("part") {
                    continue;
                }
                let id = path
                    .file_stem()
                    .and_then(|value| value.to_str())
                    .unwrap_or("");
                if id == transfer_id || active.contains(id) {
                    continue;
                }
                let metadata = match entry.metadata() {
                    Ok(value) => value,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                };
                idle_units = idle_units.saturating_add(metadata.len().div_ceil(BYTE_UNIT).max(1));
                if idle_units > MAX_FILE_SIZE / BYTE_UNIT {
                    bail!("retained upload capacity reached");
                }
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let requested_units = size.div_ceil(BYTE_UNIT) as u32;
    if u64::from(requested_units) + idle_units > budget.available_permits() as u64 {
        bail!("active and retained upload byte capacity reached");
    }
    let bytes = budget.clone().try_acquire_many_owned(requested_units)?;
    Ok(bytes)
}

impl FileTransferRuntime {
    pub fn new(state: AppState) -> Self {
        let partial = PartialUploadManager::new(&state.config.storage_path);
        Self {
            state,
            tracker: TransferTracker::new(),
            partial,
            active: Mutex::new(ActiveUploads::default()),
            connections: Arc::new(Semaphore::new(16)),
            // Bound aggregate admitted file bytes, in addition to connection
            // count. A configured 1 GiB upload remains possible on its own.
            bytes: Arc::new(Semaphore::new((MAX_FILE_SIZE / BYTE_UNIT) as usize)),
        }
    }

    fn reserve(&self, claims: &FileTransferClaims) -> Result<Reservation<'_>> {
        let mut active = self.active.lock().unwrap();
        if active.transfers.contains(&claims.tid)
            || active.users.get(&claims.sub).copied().unwrap_or(0) >= 2
        {
            bail!("upload already active or user upload limit reached");
        }
        // Retained resumable files consume the same budget as active uploads.
        // Serialize admission with the active-ID set so a peer cannot fill the
        // disk by minting tokens, sending partial data, and disconnecting. A
        // requested transfer replaces its own partial, so resuming a full-size
        // upload does not require a second file's worth of quota.
        let bytes = reserve_byte_capacity(
            &self.bytes,
            &std::path::Path::new(&self.state.config.storage_path).join("partial"),
            &active.transfers,
            &claims.tid,
            claims.fsize,
        )?;
        active.transfers.insert(claims.tid.clone());
        *active.users.entry(claims.sub).or_default() += 1;
        Ok(Reservation {
            runtime: self,
            transfer_id: claims.tid.clone(),
            user_id: claims.sub,
            _bytes: bytes,
        })
    }

    async fn authorize(&self, claims: &UploadClaims) -> Result<()> {
        if claims.file.exp <= chrono::Utc::now().timestamp().max(0) as usize
            || !super::is_media_session_active(&self.state.db, claims.file.sub, &claims.auth_sid)
                .await
        {
            bail!("upload session expired or revoked");
        }
        paracord_api::routes::files::validate_upload_permissions(
            &self.state,
            claims.file.cid,
            claims.file.sub,
        )
        .await
        .map_err(|_| anyhow::anyhow!("upload permission denied"))?;
        // Committed transfer IDs live in the database, so successful capability
        // replay is rejected across connections and server restarts.
        let attachment_id = claims.file.tid.parse::<i64>()?;
        if paracord_db::attachments::get_attachment(&self.state.db, attachment_id)
            .await?
            .is_some()
        {
            bail!("upload capability already committed");
        }
        Ok(())
    }

    pub async fn handle_session(
        &self,
        session: &mut WebTransportSession,
        permit: paracord_transport::admission::AdmissionGuard,
    ) {
        if let Err(error) = self.run_session(session, permit).await {
            // Never log the JWT, original filename or payload.
            tracing::debug!(reason = %error, "WebTransport file upload rejected");
        }
    }

    async fn run_session(
        &self,
        session: &mut WebTransportSession,
        permit: paracord_transport::admission::AdmissionGuard,
    ) -> Result<()> {
        let (mut auth_send, token, claims) = tokio::time::timeout(AUTH_TIMEOUT, async {
            let (send, mut recv) = session.accept_bi().await?;
            let mut length = [0u8; 4];
            recv.read_exact(&mut length).await?;
            let length = u32::from_be_bytes(length) as usize;
            if length == 0 || length > 8192 {
                bail!("invalid upload auth frame size");
            }
            let mut payload = vec![0u8; length];
            recv.read_exact(&mut payload).await?;
            let ControlMessage::Auth { token } = serde_json::from_slice(&payload)? else {
                bail!("file session requires authentication");
            };
            let claims = validate_token(
                &token,
                &self.state.config.jwt_secret,
                self.state.config.max_upload_size,
            )?;
            Ok::<_, anyhow::Error>((send, token, claims))
        })
        .await
        .context("upload auth timed out")??;

        let _connection = self
            .connections
            .clone()
            .try_acquire_owned()
            .context("upload capacity reached")?;
        let _reservation = self.reserve(&claims.file)?;
        self.authorize(&claims).await?;
        drop(permit);
        tokio::time::timeout(
            AUTH_TIMEOUT,
            auth_send.write_all(&ControlMessage::Pong.encode()?),
        )
        .await??;
        auth_send.finish()?;

        let (mut send, mut recv) =
            tokio::time::timeout(AUTH_TIMEOUT, session.accept_bi()).await??;
        let result = tokio::time::timeout(UPLOAD_TIMEOUT, async {
            self.authorize(&claims).await?;
            let upload = handle_authorized_upload_stream(
                &mut send,
                &mut recv,
                &self.state.config.jwt_secret,
                &self.tracker,
                &self.partial,
                &token,
            )
            .await?;
            self.authorize(&claims).await?;
            let stored = paracord_api::routes::files::process_uploaded_file_with_id(
                &self.state,
                &upload.data,
                &upload.filename,
                Some(&claims.content_type),
                upload.channel_id,
                upload.user_id,
                claims.file.tid.parse::<i64>()?,
            )
            .await
            .map_err(|_| anyhow::anyhow!("upload rejected by storage policy"))?;
            send.write_all(
                &StreamFrame::Control(ControlMessage::FileTransferDone {
                    transfer_id: claims.file.tid.clone(),
                    attachment_id: stored
                        .get("id")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    url: stored
                        .get("url")
                        .and_then(|value| value.as_str())
                        .map(str::to_owned),
                    attachment: Some(stored.clone()),
                })
                .encode()?,
            )
            .await?;
            Ok::<_, anyhow::Error>(())
        })
        .await;
        match result {
            Ok(Ok(())) => {}
            _ => {
                let error = StreamFrame::Control(ControlMessage::FileTransferError {
                    transfer_id: claims.file.tid.clone(),
                    code: 1,
                    message: "Upload rejected or timed out".to_string(),
                })
                .encode()?;
                let _ = tokio::time::timeout(Duration::from_secs(2), send.write_all(&error)).await;
            }
        }
        send.finish()?;
        // Let the final reply reach the browser before dropping its CONNECT
        // stream/H3 session. stopped resolves once FIN/data are acknowledged.
        let _ = tokio::time::timeout(Duration::from_secs(2), send.stopped()).await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn retained_partial_bytes_share_active_budget_and_allow_own_resume() {
        let directory = tempfile::tempdir().unwrap();
        let retained = directory.path().join("100.part");
        std::fs::File::create(&retained)
            .unwrap()
            .set_len(700 * BYTE_UNIT)
            .unwrap();
        let budget = Arc::new(Semaphore::new((MAX_FILE_SIZE / BYTE_UNIT) as usize));
        let mut active = HashSet::new();
        assert!(
            reserve_byte_capacity(&budget, directory.path(), &active, "200", 400 * BYTE_UNIT)
                .is_err()
        );
        let resume =
            reserve_byte_capacity(&budget, directory.path(), &active, "100", MAX_FILE_SIZE)
                .unwrap();
        active.insert("100".to_string());
        assert!(reserve_byte_capacity(&budget, directory.path(), &active, "200", 1).is_err());
        drop(resume);
        active.clear();
        let upload =
            reserve_byte_capacity(&budget, directory.path(), &active, "200", 324 * BYTE_UNIT)
                .unwrap();
        active.insert("200".to_string());
        assert!(reserve_byte_capacity(&budget, directory.path(), &active, "300", 1).is_err());
        drop(upload);
        std::fs::File::create(directory.path().join("300.part")).unwrap();
        assert!(
            reserve_byte_capacity(&budget, directory.path(), &active, "400", 324 * BYTE_UNIT)
                .is_err(),
            "empty retained files must consume capacity too"
        );
    }

    #[test]
    fn upload_capabilities_reject_media_tokens_wrong_purpose_and_invalid_bounds() {
        let now = chrono::Utc::now().timestamp();
        let valid = json!({"purpose":"file_upload_v1","auth_sid":"auth-session","content_type":"application/octet-stream",
            "sub":1,"tid":"123","cid":2,"fname":"file.bin","fsize":1024,"iat":now,"exp":now+900});
        let encode = |claims: &serde_json::Value| {
            jsonwebtoken::encode(
                &jsonwebtoken::Header::default(),
                claims,
                &jsonwebtoken::EncodingKey::from_secret(b"test-secret"),
            )
            .unwrap()
        };
        assert!(validate_token(&encode(&valid), "test-secret", 1024).is_ok());
        assert!(validate_token(&encode(&valid), "wrong-secret", 1024).is_err());
        for (key, value) in [
            ("purpose", json!("media")),
            ("auth_sid", json!("")),
            ("tid", json!("../x")),
            ("fsize", json!(0)),
            ("fsize", json!(1025)),
            ("exp", json!(now)),
            ("exp", json!(now + 901)),
            ("iat", json!(now + 61)),
        ] {
            let mut claims = valid.clone();
            claims[key] = value;
            assert!(
                validate_token(&encode(&claims), "test-secret", 1024).is_err(),
                "accepted invalid {key}"
            );
        }
        let media =
            json!({"sub":1,"sid":"voice","auth_sid":"auth-session","room":"1:2","exp":now+900});
        assert!(validate_token(&encode(&media), "test-secret", 1024).is_err());
    }
}
