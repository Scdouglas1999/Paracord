//! QUIC file transfer handler.
//!
//! Manages upload and download streams over QUIC bidirectional connections,
//! with support for resumable uploads via partial temp files.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use dashmap::DashMap;
use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;
use tracing;

use crate::control::{ControlMessage, StreamFrame, StreamFrameCodec, StreamFrameError};

/// Default chunk size for file transfer data frames (256 KiB).
pub const DEFAULT_CHUNK_SIZE: u32 = 256 * 1024;

/// Progress ACK interval in bytes (~1 MiB).
pub const PROGRESS_ACK_INTERVAL: u64 = 1024 * 1024;

/// Maximum file size for QUIC transfer (1 GiB).
pub const MAX_FILE_SIZE: u64 = 1024 * 1024 * 1024;

/// JWT claims for file transfer upload tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTransferClaims {
    /// User ID.
    pub sub: i64,
    /// Transfer ID.
    pub tid: String,
    /// Channel ID.
    pub cid: i64,
    /// Original filename.
    pub fname: String,
    /// File size in bytes.
    pub fsize: u64,
    /// Expiry timestamp.
    pub exp: usize,
    /// Issued at timestamp.
    pub iat: usize,
}

/// Validates a file transfer JWT token.
pub fn validate_file_transfer_token(
    token: &str,
    jwt_secret: &str,
) -> Result<FileTransferClaims, FileTransferError> {
    let validation = Validation::new(Algorithm::HS256);
    let token_data = decode::<FileTransferClaims>(
        token,
        &DecodingKey::from_secret(jwt_secret.as_bytes()),
        &validation,
    )
    .map_err(|e| FileTransferError::AuthFailed(e.to_string()))?;
    Ok(token_data.claims)
}

/// Tracks an in-progress file transfer.
#[derive(Debug)]
pub struct TransferState {
    pub transfer_id: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub filename: String,
    pub total_size: u64,
    pub bytes_received: u64,
    pub temp_path: PathBuf,
    pub cancelled: bool,
}

/// Manages in-progress transfers for progress tracking, cancellation, and resume.
pub struct TransferTracker {
    transfers: DashMap<String, TransferState>,
}

impl TransferTracker {
    pub fn new() -> Self {
        Self {
            transfers: DashMap::new(),
        }
    }

    pub fn insert(&self, state: TransferState) {
        self.transfers.insert(state.transfer_id.clone(), state);
    }

    fn reserve(&self, state: TransferState) -> Result<ActiveTransfer<'_>, FileTransferError> {
        let transfer_id = state.transfer_id.clone();
        match self.transfers.entry(transfer_id.clone()) {
            dashmap::mapref::entry::Entry::Vacant(entry) => {
                entry.insert(state);
                Ok(ActiveTransfer {
                    tracker: self,
                    transfer_id,
                })
            }
            dashmap::mapref::entry::Entry::Occupied(_) => Err(FileTransferError::Rejected(
                "transfer is already active".into(),
            )),
        }
    }

    pub fn get_bytes_received(&self, transfer_id: &str) -> Option<u64> {
        self.transfers.get(transfer_id).map(|s| s.bytes_received)
    }

    pub fn update_bytes_received(&self, transfer_id: &str, bytes: u64) {
        if let Some(mut state) = self.transfers.get_mut(transfer_id) {
            state.bytes_received = bytes;
        }
    }

    pub fn cancel(&self, transfer_id: &str) -> bool {
        if let Some(mut state) = self.transfers.get_mut(transfer_id) {
            state.cancelled = true;
            true
        } else {
            false
        }
    }

    pub fn is_cancelled(&self, transfer_id: &str) -> bool {
        self.transfers
            .get(transfer_id)
            .map(|s| s.cancelled)
            .unwrap_or(false)
    }

    pub fn remove(&self, transfer_id: &str) -> Option<TransferState> {
        self.transfers.remove(transfer_id).map(|(_, v)| v)
    }
}

impl Default for TransferTracker {
    fn default() -> Self {
        Self::new()
    }
}

/// Every exit releases the reservation, including protocol/I/O errors and task
/// cancellation. A second stream must not truncate or append the same partial.
struct ActiveTransfer<'a> {
    tracker: &'a TransferTracker,
    transfer_id: String,
}

impl Drop for ActiveTransfer<'_> {
    fn drop(&mut self) {
        self.tracker.remove(&self.transfer_id);
    }
}

/// Manages partial upload temp files for resume support.
pub struct PartialUploadManager {
    partial_dir: PathBuf,
}

impl PartialUploadManager {
    pub fn new(storage_path: &str) -> Self {
        let partial_dir = Path::new(storage_path).join("partial");
        Self { partial_dir }
    }

    /// Ensure the partial directory exists.
    pub async fn ensure_dir(&self) -> Result<(), FileTransferError> {
        tokio::fs::create_dir_all(&self.partial_dir)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
        Ok(())
    }

    /// Get the temp file path for a transfer. The ID is an opaque filename
    /// component, never a path supplied by the token holder.
    pub fn temp_path(&self, transfer_id: &str) -> Result<PathBuf, FileTransferError> {
        if transfer_id.is_empty()
            || transfer_id.len() > 128
            || !transfer_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(FileTransferError::Protocol("invalid transfer_id".into()));
        }
        // Device names remain special on Windows even with the .part suffix.
        let upper = transfer_id.to_ascii_uppercase();
        if matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
            || (upper.len() == 4
                && (upper.starts_with("COM") || upper.starts_with("LPT"))
                && matches!(upper.as_bytes()[3], b'1'..=b'9'))
        {
            return Err(FileTransferError::Protocol("invalid transfer_id".into()));
        }
        Ok(self.partial_dir.join(format!("{}.part", transfer_id)))
    }

    /// Get the current size of a partial upload (for resume).
    pub async fn get_partial_size(&self, transfer_id: &str) -> Result<u64, FileTransferError> {
        let path = self.temp_path(transfer_id)?;
        match tokio::fs::metadata(&path).await {
            Ok(meta) => Ok(meta.len()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(error) => Err(FileTransferError::Io(error.to_string())),
        }
    }

    /// Create or open a temp file for writing (append mode for resume).
    pub async fn open_for_append(
        &self,
        transfer_id: &str,
    ) -> Result<tokio::fs::File, FileTransferError> {
        let path = self.temp_path(transfer_id)?;
        tokio::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))
    }

    /// Read the complete temp file contents.
    pub async fn read_complete(&self, transfer_id: &str) -> Result<Vec<u8>, FileTransferError> {
        let path = self.temp_path(transfer_id)?;
        tokio::fs::read(&path)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))
    }

    /// Remove a temp file.
    pub async fn remove(&self, transfer_id: &str) -> Result<(), FileTransferError> {
        let path = self.temp_path(transfer_id)?;
        match tokio::fs::remove_file(&path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(FileTransferError::Io(error.to_string())),
        }
    }

    /// Truncate a partial file to a specific size (for resume correction).
    pub async fn truncate_to(&self, transfer_id: &str, size: u64) -> Result<(), FileTransferError> {
        let path = self.temp_path(transfer_id)?;
        let file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
        file.set_len(size)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
        Ok(())
    }

    /// Spawn a background task that cleans up partial files older than 1 hour.
    pub fn spawn_cleanup_task(partial_dir: PathBuf, shutdown: Arc<tokio::sync::Notify>) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(300));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tokio::select! {
                    _ = shutdown.notified() => break,
                    _ = interval.tick() => {
                        if let Err(e) = cleanup_old_partials(&partial_dir, Duration::from_secs(3600)).await {
                            tracing::warn!("Partial upload cleanup error: {}", e);
                        }
                    }
                }
            }
        });
    }
}

async fn cleanup_old_partials(dir: &Path, max_age: Duration) -> Result<(), std::io::Error> {
    if !dir.exists() {
        return Ok(());
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) == Some("part") {
            if let Ok(meta) = tokio::fs::metadata(&path).await {
                if let Ok(modified) = meta.modified() {
                    if let Ok(age) = modified.elapsed() {
                        if age > max_age {
                            tracing::info!("Removing stale partial upload: {:?}", path);
                            let _ = tokio::fs::remove_file(&path).await;
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

#[derive(Debug, thiserror::Error)]
pub enum FileTransferError {
    #[error("authentication failed: {0}")]
    AuthFailed(String),
    #[error("transfer rejected: {0}")]
    Rejected(String),
    #[error("transfer canceled")]
    Cancelled,
    #[error("file too large: {size} bytes (max {MAX_FILE_SIZE})")]
    FileTooLarge { size: u64 },
    #[error("protocol error: {0}")]
    Protocol(String),
    #[error("io error: {0}")]
    Io(String),
    #[error("stream frame error: {0}")]
    Frame(#[from] StreamFrameError),
}

/// Handle an incoming upload stream.
///
/// Reads FileTransferInit, validates the token, streams data chunks to a temp
/// file, sends periodic progress ACKs, and returns the completed file data.
pub async fn handle_upload_stream(
    send: &mut quinn::SendStream,
    recv: &mut quinn::RecvStream,
    jwt_secret: &str,
    tracker: &TransferTracker,
    partial_mgr: &PartialUploadManager,
) -> Result<UploadResult, FileTransferError> {
    handle_upload_stream_inner(send, recv, jwt_secret, tracker, partial_mgr, None).await
}

/// Receive an upload whose exact capability was authenticated and authorized
/// by the caller before opening this stream. A connection cannot substitute
/// another user's, channel's, or transfer's token after admission.
pub async fn handle_authorized_upload_stream(
    send: &mut quinn::SendStream,
    recv: &mut quinn::RecvStream,
    jwt_secret: &str,
    tracker: &TransferTracker,
    partial_mgr: &PartialUploadManager,
    authorized_token: &str,
) -> Result<UploadResult, FileTransferError> {
    handle_upload_stream_inner(
        send,
        recv,
        jwt_secret,
        tracker,
        partial_mgr,
        Some(authorized_token),
    )
    .await
}

async fn handle_upload_stream_inner(
    send: &mut quinn::SendStream,
    recv: &mut quinn::RecvStream,
    jwt_secret: &str,
    tracker: &TransferTracker,
    partial_mgr: &PartialUploadManager,
    authorized_token: Option<&str>,
) -> Result<UploadResult, FileTransferError> {
    let mut codec = StreamFrameCodec::new();
    let mut buf = vec![0u8; 32 * 1024];

    // 1. Read the init message
    let init_msg = read_next_control(recv, &mut codec, &mut buf).await?;
    let (transfer_id, upload_token, resume_offset) = match init_msg {
        ControlMessage::FileTransferInit {
            transfer_id,
            upload_token,
            resume_offset,
        } => (transfer_id, upload_token, resume_offset),
        _ => {
            return Err(FileTransferError::Protocol(
                "expected FileTransferInit".into(),
            ))
        }
    };

    if authorized_token.is_some_and(|expected| expected != upload_token) {
        return Err(FileTransferError::AuthFailed(
            "upload capability mismatch".into(),
        ));
    }

    // 2. Validate the upload token
    let claims = validate_file_transfer_token(&upload_token, jwt_secret)?;
    if claims.tid != transfer_id {
        return Err(FileTransferError::Protocol("transfer_id mismatch".into()));
    }
    if claims.fsize > MAX_FILE_SIZE {
        let reject = StreamFrame::Control(ControlMessage::FileTransferReject {
            transfer_id: transfer_id.clone(),
            reason: "file too large".into(),
        });
        let _ = send.write_all(&reject.encode()?).await;
        return Err(FileTransferError::FileTooLarge { size: claims.fsize });
    }

    let temp_path = partial_mgr.temp_path(&transfer_id)?;
    let _active = tracker.reserve(TransferState {
        transfer_id: transfer_id.clone(),
        user_id: claims.sub,
        channel_id: claims.cid,
        filename: claims.fname.clone(),
        total_size: claims.fsize,
        bytes_received: 0,
        temp_path,
        cancelled: false,
    })?;

    // 3. Handle resume
    partial_mgr.ensure_dir().await?;
    let existing_size = partial_mgr.get_partial_size(&transfer_id).await?;
    let resume_from = if let Some(requested_offset) = resume_offset {
        if requested_offset > claims.fsize || existing_size > claims.fsize {
            return Err(FileTransferError::Protocol(
                "resume offset or partial exceeds declared size".into(),
            ));
        }
        // Client wants to resume - use the minimum of what they think and what we have
        let confirmed = requested_offset.min(existing_size);
        if confirmed < existing_size {
            partial_mgr.truncate_to(&transfer_id, confirmed).await?;
        }
        confirmed
    } else {
        // Fresh upload - remove any stale partial
        if existing_size > 0 {
            partial_mgr.remove(&transfer_id).await?;
        }
        0
    };

    // 4. Send accept
    let accept = StreamFrame::Control(ControlMessage::FileTransferAccept {
        transfer_id: transfer_id.clone(),
        chunk_size: DEFAULT_CHUNK_SIZE,
        offset: resume_from,
    });
    send.write_all(&accept.encode()?)
        .await
        .map_err(|e| FileTransferError::Io(e.to_string()))?;

    tracker.update_bytes_received(&transfer_id, resume_from);

    // 6. Open temp file for writing
    let mut file = partial_mgr.open_for_append(&transfer_id).await?;
    let mut bytes_received = resume_from;
    let mut last_ack_at = bytes_received;

    // 7. Read data chunks until EndOfData
    loop {
        if tracker.is_cancelled(&transfer_id) {
            let cancel = StreamFrame::Control(ControlMessage::FileTransferCancel {
                transfer_id: transfer_id.clone(),
            });
            let _ = send.write_all(&cancel.encode()?).await;
            drop(file);
            let _ = partial_mgr.remove(&transfer_id).await;
            return Err(FileTransferError::Cancelled);
        }

        // Init, data and EndOfData may arrive in one QUIC read. Drain complete
        // buffered frames before waiting for bytes the sender need not send.
        while let Some(frame) = codec.decode_next()? {
            match frame {
                StreamFrame::Data(data) => {
                    if bytes_received + data.len() as u64 > claims.fsize {
                        let err_msg = StreamFrame::Control(ControlMessage::FileTransferError {
                            transfer_id: transfer_id.clone(),
                            code: 1,
                            message: "received more data than declared file size".into(),
                        });
                        let _ = send.write_all(&err_msg.encode()?).await;
                        drop(file);
                        let _ = partial_mgr.remove(&transfer_id).await;
                        return Err(FileTransferError::Protocol(
                            "data exceeds declared size".into(),
                        ));
                    }

                    file.write_all(&data)
                        .await
                        .map_err(|e| FileTransferError::Io(e.to_string()))?;
                    bytes_received += data.len() as u64;
                    tracker.update_bytes_received(&transfer_id, bytes_received);

                    // Send progress ACK every ~1MB
                    if bytes_received - last_ack_at >= PROGRESS_ACK_INTERVAL {
                        let progress = StreamFrame::Control(ControlMessage::FileTransferProgress {
                            transfer_id: transfer_id.clone(),
                            bytes_received,
                        });
                        send.write_all(&progress.encode()?)
                            .await
                            .map_err(|e| FileTransferError::Io(e.to_string()))?;
                        last_ack_at = bytes_received;
                    }
                }
                StreamFrame::EndOfData => {
                    file.flush()
                        .await
                        .map_err(|e| FileTransferError::Io(e.to_string()))?;
                    drop(file);

                    if bytes_received != claims.fsize {
                        // Retain the authenticated partial for a corrected
                        // resume, but never report a truncated file as success.
                        return Err(FileTransferError::Protocol(
                            "upload ended before declared size".into(),
                        ));
                    }

                    let data = partial_mgr.read_complete(&transfer_id).await?;
                    partial_mgr.remove(&transfer_id).await?;
                    if data.len() as u64 != claims.fsize {
                        return Err(FileTransferError::Protocol(
                            "partial file size changed during upload".into(),
                        ));
                    }

                    return Ok(UploadResult {
                        transfer_id,
                        user_id: claims.sub,
                        channel_id: claims.cid,
                        filename: claims.fname,
                        content_type: None, // Will be resolved by the caller
                        data,
                    });
                }
                StreamFrame::Control(ControlMessage::FileTransferCancel { .. }) => {
                    drop(file);
                    let _ = partial_mgr.remove(&transfer_id).await;
                    return Err(FileTransferError::Cancelled);
                }
                _ => {
                    // Ignore unexpected control messages
                }
            }
        }

        let n = recv
            .read(&mut buf)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
        let Some(n) = n else {
            // Stream closed unexpectedly - keep partial for resume.
            file.flush()
                .await
                .map_err(|e| FileTransferError::Io(e.to_string()))?;
            return Err(FileTransferError::Io("stream closed unexpectedly".into()));
        };
        codec.feed(&buf[..n]);
    }
}

/// Result of a successful upload.
pub struct UploadResult {
    pub transfer_id: String,
    pub user_id: i64,
    pub channel_id: i64,
    pub filename: String,
    pub content_type: Option<String>,
    pub data: Vec<u8>,
}

/// Handle an incoming download stream.
///
/// Streams caller-authorized file data after reading FileDownloadRequest.
///
/// The caller MUST authenticate the connection and authorize this attachment
/// before providing `file_data`. This framing helper does not authenticate the
/// request's token; the legacy `jwt_secret` argument is retained for API
/// compatibility only. The requested ID is checked against the already
/// authorized `attachment_id`, and a range cannot exceed the supplied data.
pub async fn handle_download_stream(
    send: &mut quinn::SendStream,
    recv: &mut quinn::RecvStream,
    _jwt_secret: &str,
    file_data: &[u8],
    filename: &str,
    content_type: &str,
    attachment_id: &str,
) -> Result<(), FileTransferError> {
    let mut codec = StreamFrameCodec::new();
    let mut buf = vec![0u8; 32 * 1024];

    // 1. Read download request
    let req_msg = read_next_control(recv, &mut codec, &mut buf).await?;
    let (req_attachment_id, _auth_token, range_start) = match req_msg {
        ControlMessage::FileDownloadRequest {
            attachment_id,
            auth_token,
            range_start,
            ..
        } => (attachment_id, auth_token, range_start),
        _ => {
            return Err(FileTransferError::Protocol(
                "expected FileDownloadRequest".into(),
            ))
        }
    };

    if req_attachment_id != attachment_id {
        return Err(FileTransferError::Protocol("attachment_id mismatch".into()));
    }
    if file_data.len() as u64 > MAX_FILE_SIZE {
        return Err(FileTransferError::FileTooLarge {
            size: file_data.len() as u64,
        });
    }
    let requested_offset = range_start.unwrap_or(0);
    if requested_offset > file_data.len() as u64 {
        return Err(FileTransferError::Protocol(
            "download range exceeds file size".into(),
        ));
    }
    let offset = requested_offset as usize;
    let data_to_send = &file_data[offset..];

    // 2. Send accept
    let accept = StreamFrame::Control(ControlMessage::FileDownloadAccept {
        attachment_id: req_attachment_id.clone(),
        filename: filename.to_string(),
        size: data_to_send.len() as u64,
        content_type: content_type.to_string(),
        offset: offset as u64,
    });
    send.write_all(&accept.encode()?)
        .await
        .map_err(|e| FileTransferError::Io(e.to_string()))?;

    // 3. Send data in chunks
    let chunk_size = DEFAULT_CHUNK_SIZE as usize;
    for chunk in data_to_send.chunks(chunk_size) {
        let frame = StreamFrame::Data(Bytes::copy_from_slice(chunk));
        send.write_all(&frame.encode()?)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
    }

    // 4. Send end of data
    let end = StreamFrame::EndOfData;
    send.write_all(&end.encode()?)
        .await
        .map_err(|e| FileTransferError::Io(e.to_string()))?;

    // 5. Send done
    let done = StreamFrame::Control(ControlMessage::FileTransferDone {
        transfer_id: req_attachment_id.clone(),
        attachment_id: Some(attachment_id.to_string()),
        url: None,
        attachment: None,
    });
    send.write_all(&done.encode()?)
        .await
        .map_err(|e| FileTransferError::Io(e.to_string()))?;

    Ok(())
}

/// Helper to read the next control message from a stream.
async fn read_next_control(
    recv: &mut quinn::RecvStream,
    codec: &mut StreamFrameCodec,
    buf: &mut [u8],
) -> Result<ControlMessage, FileTransferError> {
    loop {
        // Try to decode from existing buffer first
        if let Some(frame) = codec.decode_next()? {
            match frame {
                StreamFrame::Control(msg) => return Ok(msg),
                _ => continue, // skip non-control frames
            }
        }

        // Read more data
        let n = recv
            .read(buf)
            .await
            .map_err(|e| FileTransferError::Io(e.to_string()))?;
        let Some(n) = n else {
            return Err(FileTransferError::Io("stream closed".into()));
        };
        codec.feed(&buf[..n]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_transfer_claims_roundtrip() {
        let claims = FileTransferClaims {
            sub: 12345,
            tid: "transfer-1".to_string(),
            cid: 67890,
            fname: "photo.png".to_string(),
            fsize: 4096000,
            exp: 9999999999,
            iat: 1000000000,
        };
        let json = serde_json::to_string(&claims).unwrap();
        let parsed: FileTransferClaims = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.sub, 12345);
        assert_eq!(parsed.tid, "transfer-1");
        assert_eq!(parsed.cid, 67890);
        assert_eq!(parsed.fname, "photo.png");
        assert_eq!(parsed.fsize, 4096000);
    }

    #[test]
    fn transfer_tracker_basic_ops() {
        let tracker = TransferTracker::new();
        let state = TransferState {
            transfer_id: "t1".into(),
            user_id: 1,
            channel_id: 2,
            filename: "test.txt".into(),
            total_size: 1000,
            bytes_received: 0,
            temp_path: PathBuf::from("/tmp/t1.part"),
            cancelled: false,
        };
        tracker.insert(state);
        assert_eq!(tracker.get_bytes_received("t1"), Some(0));

        tracker.update_bytes_received("t1", 500);
        assert_eq!(tracker.get_bytes_received("t1"), Some(500));

        assert!(!tracker.is_cancelled("t1"));
        assert!(tracker.cancel("t1"));
        assert!(tracker.is_cancelled("t1"));

        let removed = tracker.remove("t1");
        assert!(removed.is_some());
        assert_eq!(tracker.get_bytes_received("t1"), None);
    }

    #[tokio::test]
    async fn partial_upload_manager_temp_path() {
        let mgr = PartialUploadManager::new("/tmp/test-storage");
        let path = mgr.temp_path("transfer-123").unwrap();
        assert!(path.to_str().unwrap().contains("partial"));
        assert!(path.to_str().unwrap().contains("transfer-123.part"));
    }

    #[tokio::test]
    async fn partial_upload_paths_reject_untrusted_components_at_every_boundary() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PartialUploadManager::new(dir.path().to_str().unwrap());
        mgr.ensure_dir().await.unwrap();
        let victim = dir.path().join("victim.part");
        tokio::fs::write(&victim, b"must remain unchanged")
            .await
            .unwrap();
        let too_long = "a".repeat(129);
        for transfer_id in [
            "",
            ".",
            "..",
            "../victim",
            "..\\victim",
            "/tmp/victim",
            "C:\\victim",
            "a/b",
            "a\\b",
            "a:b",
            "a\0b",
            "a b",
            "é",
            "CON",
            "com1",
            "LPT9",
            &too_long,
        ] {
            assert!(mgr.temp_path(transfer_id).is_err(), "{transfer_id:?}");
            assert!(mgr.get_partial_size(transfer_id).await.is_err());
            assert!(mgr.open_for_append(transfer_id).await.is_err());
            assert!(mgr.read_complete(transfer_id).await.is_err());
            assert!(mgr.truncate_to(transfer_id, 0).await.is_err());
            assert!(mgr.remove(transfer_id).await.is_err());
        }
        assert_eq!(
            tokio::fs::read(victim).await.unwrap(),
            b"must remain unchanged"
        );
        for transfer_id in ["123456789", "transfer-123", "transfer_123"] {
            assert_eq!(
                mgr.temp_path(transfer_id).unwrap().parent(),
                Some(mgr.partial_dir.as_path())
            );
        }
    }

    async fn connected_quic_pair() -> (
        crate::endpoint::MediaEndpoint,
        crate::endpoint::MediaEndpoint,
        quinn::Connection,
        quinn::Connection,
    ) {
        use crate::endpoint::{certificate_hash, generate_self_signed_cert, MediaEndpoint};
        let tls = generate_self_signed_cert().unwrap();
        let pin = certificate_hash(&tls.cert_chain[0]);
        let server = MediaEndpoint::bind("127.0.0.1:0".parse().unwrap(), tls).unwrap();
        let client = MediaEndpoint::client("127.0.0.1:0".parse().unwrap()).unwrap();
        let connecting = client
            .connect_pinned(server.local_addr().unwrap(), "localhost", &pin)
            .unwrap();
        let incoming = server.accept().await.unwrap();
        let server_connection = incoming.accept().unwrap().await.unwrap();
        let client_connection = connecting.await.unwrap();
        (server, client, server_connection, client_connection)
    }

    fn upload_wire(
        transfer_id: &str,
        total_size: u64,
        resume_offset: Option<u64>,
        data: &[u8],
    ) -> Vec<u8> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs() as usize;
        let claims = FileTransferClaims {
            sub: 1,
            tid: transfer_id.into(),
            cid: 2,
            fname: "test.bin".into(),
            fsize: total_size,
            exp: now + 60,
            iat: now,
        };
        let token = jsonwebtoken::encode(
            &jsonwebtoken::Header::default(),
            &claims,
            &jsonwebtoken::EncodingKey::from_secret(b"test-transfer-secret"),
        )
        .unwrap();
        let mut wire = StreamFrame::Control(ControlMessage::FileTransferInit {
            transfer_id: transfer_id.into(),
            upload_token: token,
            resume_offset,
        })
        .encode()
        .unwrap()
        .to_vec();
        for chunk in data.chunks(DEFAULT_CHUNK_SIZE as usize) {
            wire.extend_from_slice(
                &StreamFrame::Data(Bytes::copy_from_slice(chunk))
                    .encode()
                    .unwrap(),
            );
        }
        wire.extend_from_slice(&StreamFrame::EndOfData.encode().unwrap());
        wire
    }

    fn decode_frames(data: &[u8]) -> Vec<StreamFrame> {
        let mut codec = StreamFrameCodec::new();
        codec.feed(data);
        let mut frames = Vec::new();
        while let Some(frame) = codec.decode_next().unwrap() {
            frames.push(frame);
        }
        frames
    }

    async fn upload_over_quic(
        tracker: &TransferTracker,
        mgr: &PartialUploadManager,
        wire: &[u8],
    ) -> (Result<UploadResult, FileTransferError>, Vec<StreamFrame>) {
        tokio::time::timeout(Duration::from_secs(10), async {
            let (_server_endpoint, _client_endpoint, server, client) = connected_quic_pair().await;
            let server_task = async {
                let (mut send, mut recv) = server.accept_bi().await.unwrap();
                let result = handle_upload_stream(
                    &mut send,
                    &mut recv,
                    "test-transfer-secret",
                    tracker,
                    mgr,
                )
                .await;
                send.finish().unwrap();
                result
            };
            let client_task = async {
                let (mut send, mut recv) = client.open_bi().await.unwrap();
                // Keep the send half open: EndOfData must be sufficient for
                // completion even when init and data arrive in one read.
                send.write_all(wire).await.unwrap();
                let reply = recv.read_to_end(1024 * 1024).await.unwrap();
                drop(send);
                decode_frames(&reply)
            };
            tokio::join!(server_task, client_task)
        })
        .await
        .expect("upload stream must complete without waiting for an extra frame")
    }

    #[tokio::test]
    async fn upload_coalesced_frames_complete_and_progress_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PartialUploadManager::new(dir.path().to_str().unwrap());
        let tracker = TransferTracker::new();
        for data in [
            vec![],
            b"abc".to_vec(),
            vec![0x5a; PROGRESS_ACK_INTERVAL as usize + 64],
        ] {
            let wire = upload_wire("coalesced", data.len() as u64, None, &data);
            let (result, frames) = upload_over_quic(&tracker, &mgr, &wire).await;
            assert_eq!(result.unwrap().data, data);
            assert!(matches!(
                frames.first(),
                Some(StreamFrame::Control(ControlMessage::FileTransferAccept {
                    offset: 0,
                    ..
                }))
            ));
            if data.len() as u64 > PROGRESS_ACK_INTERVAL {
                assert!(frames.iter().any(|frame| matches!(frame, StreamFrame::Control(ControlMessage::FileTransferProgress { bytes_received, .. }) if *bytes_received >= PROGRESS_ACK_INTERVAL)));
            }
            assert_eq!(tracker.get_bytes_received("coalesced"), None);
            assert_eq!(mgr.get_partial_size("coalesced").await.unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn upload_early_end_is_rejected_and_partial_can_resume() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PartialUploadManager::new(dir.path().to_str().unwrap());
        let tracker = TransferTracker::new();
        let (result, _) =
            upload_over_quic(&tracker, &mgr, &upload_wire("resume", 8, None, b"abc")).await;
        assert!(matches!(result, Err(FileTransferError::Protocol(_))));
        assert_eq!(mgr.read_complete("resume").await.unwrap(), b"abc");
        assert_eq!(tracker.get_bytes_received("resume"), None);
        let (result, frames) =
            upload_over_quic(&tracker, &mgr, &upload_wire("resume", 8, Some(3), b"defgh")).await;
        assert_eq!(result.unwrap().data, b"abcdefgh");
        assert!(matches!(
            frames.first(),
            Some(StreamFrame::Control(ControlMessage::FileTransferAccept {
                offset: 3,
                ..
            }))
        ));
    }

    #[tokio::test]
    async fn upload_resume_rejects_oversized_offsets_or_partials_before_mutation() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PartialUploadManager::new(dir.path().to_str().unwrap());
        let tracker = TransferTracker::new();
        mgr.ensure_dir().await.unwrap();
        for (partial, requested) in [(b"abc".as_slice(), 7), (b"abcdefg".as_slice(), 3)] {
            tokio::fs::write(mgr.temp_path("resume").unwrap(), partial)
                .await
                .unwrap();
            let (result, frames) = upload_over_quic(
                &tracker,
                &mgr,
                &upload_wire("resume", 6, Some(requested), b""),
            )
            .await;
            assert!(matches!(result, Err(FileTransferError::Protocol(_))));
            assert!(frames.is_empty(), "invalid resume must not be accepted");
            assert_eq!(mgr.read_complete("resume").await.unwrap(), partial);
            assert_eq!(tracker.get_bytes_received("resume"), None);
        }
        // A valid smaller confirmed offset still truncates a stale tail.
        tokio::fs::write(mgr.temp_path("resume").unwrap(), b"abcXY")
            .await
            .unwrap();
        let (result, frames) =
            upload_over_quic(&tracker, &mgr, &upload_wire("resume", 6, Some(3), b"def")).await;
        assert_eq!(result.unwrap().data, b"abcdef");
        assert!(matches!(
            frames.first(),
            Some(StreamFrame::Control(ControlMessage::FileTransferAccept {
                offset: 3,
                ..
            }))
        ));
    }

    #[tokio::test]
    async fn upload_rejects_oversize_data_and_same_id_concurrent_streams() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = PartialUploadManager::new(dir.path().to_str().unwrap());
        let tracker = TransferTracker::new();
        let (result, _) =
            upload_over_quic(&tracker, &mgr, &upload_wire("size", 3, None, b"abcd")).await;
        assert!(matches!(result, Err(FileTransferError::Protocol(_))));
        assert_eq!(tracker.get_bytes_received("size"), None);
        assert_eq!(mgr.get_partial_size("size").await.unwrap(), 0);

        tokio::fs::write(mgr.temp_path("busy").unwrap(), b"abc")
            .await
            .unwrap();
        let active = tracker
            .reserve(TransferState {
                transfer_id: "busy".into(),
                user_id: 1,
                channel_id: 2,
                filename: "test.bin".into(),
                total_size: 6,
                bytes_received: 3,
                temp_path: mgr.temp_path("busy").unwrap(),
                cancelled: false,
            })
            .unwrap();
        let (result, frames) =
            upload_over_quic(&tracker, &mgr, &upload_wire("busy", 6, Some(0), b"abcdef")).await;
        assert!(matches!(result, Err(FileTransferError::Rejected(_))));
        assert!(frames.is_empty());
        assert_eq!(mgr.read_complete("busy").await.unwrap(), b"abc");
        assert_eq!(tracker.get_bytes_received("busy"), Some(3));
        drop(active);
        assert_eq!(tracker.get_bytes_received("busy"), None);
    }

    #[tokio::test]
    async fn download_binds_authorized_attachment_and_validates_resume_range() {
        for (requested_id, offset, expected) in [
            ("other", 0, None),
            ("allowed", u64::MAX, None),
            ("allowed", 2, Some(b"cdef".as_slice())),
            ("allowed", 6, Some(b"".as_slice())),
        ] {
            let (result, frames) = tokio::time::timeout(Duration::from_secs(10), async {
                let (_server_endpoint, _client_endpoint, server, client) =
                    connected_quic_pair().await;
                let server_task = async {
                    let (mut send, mut recv) = server.accept_bi().await.unwrap();
                    let result = handle_download_stream(
                        &mut send,
                        &mut recv,
                        "",
                        b"abcdef",
                        "test.txt",
                        "text/plain",
                        "allowed",
                    )
                    .await;
                    send.finish().unwrap();
                    result
                };
                let client_task = async {
                    let (mut send, mut recv) = client.open_bi().await.unwrap();
                    let request = StreamFrame::Control(ControlMessage::FileDownloadRequest {
                        attachment_id: requested_id.into(),
                        auth_token: String::new(),
                        range_start: Some(offset),
                        range_end: None,
                    });
                    send.write_all(&request.encode().unwrap()).await.unwrap();
                    let reply = recv.read_to_end(1024).await.unwrap();
                    decode_frames(&reply)
                };
                tokio::join!(server_task, client_task)
            })
            .await
            .unwrap();
            if let Some(expected) = expected {
                result.unwrap();
                assert!(
                    matches!(frames.first(), Some(StreamFrame::Control(ControlMessage::FileDownloadAccept { attachment_id, offset: actual_offset, size, .. })) if attachment_id == "allowed" && *actual_offset == offset && *size == expected.len() as u64)
                );
                let data: Vec<u8> = frames
                    .iter()
                    .filter_map(|frame| match frame {
                        StreamFrame::Data(bytes) => Some(bytes.as_ref()),
                        _ => None,
                    })
                    .flatten()
                    .copied()
                    .collect();
                assert_eq!(data, expected);
                assert!(frames
                    .iter()
                    .any(|frame| matches!(frame, StreamFrame::EndOfData)));
            } else {
                assert!(matches!(result, Err(FileTransferError::Protocol(_))));
                assert!(
                    frames.is_empty(),
                    "unauthorized target or invalid range cannot send bytes"
                );
            }
        }
    }
}
