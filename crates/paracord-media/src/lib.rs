pub mod livekit;
pub mod s3;
pub mod storage;
pub mod streaming;
pub mod voice;

pub use livekit::{AudioBitrate, LiveKitConfig, WebhookEvent};
pub use s3::S3Config;
pub use storage::{
    LocalStorage, Storage, StorageBackend, StorageConfig, StorageError, StorageManager, StoredFile,
};
pub use streaming::{
    ScreenCaptureConfig, SimulcastLayer, StreamConfig, StreamMetadata, StreamQualityPreset,
    ViewerQuality,
};
pub use voice::{StreamStartResponse, VoiceJoinResponse, VoiceManager};

/// Create a `Storage` enum from the server configuration.
///
/// - `storage_type = "local"` (default): uses `LocalStorage` rooted at `base_path`.
/// - `storage_type = "s3"`: uses `S3Storage` (requires the `s3` feature).
pub async fn create_storage_backend(
    storage_type: &str,
    base_path: &str,
    s3_config: Option<&S3Config>,
) -> Result<Storage, StorageError> {
    match storage_type {
        "local" | "" => {
            tracing::info!("Using local filesystem storage backend ({})", base_path);
            Ok(Storage::Local(LocalStorage::new(base_path)))
        }
        "s3" => {
            #[cfg(feature = "s3")]
            {
                let cfg = s3_config.ok_or_else(|| {
                    StorageError::Backend(
                        "storage_type is 's3' but no [s3] configuration section found".into(),
                    )
                })?;
                if cfg.bucket.is_empty() {
                    return Err(StorageError::Backend(
                        "S3 bucket name must not be empty".into(),
                    ));
                }
                tracing::info!(
                    "Using S3 storage backend (bucket={}, region={}, endpoint={:?})",
                    cfg.bucket,
                    cfg.region,
                    cfg.endpoint_url
                );
                let s3 = s3::S3Storage::new(cfg).await?;
                Ok(Storage::S3(s3))
            }
            #[cfg(not(feature = "s3"))]
            {
                let _ = s3_config;
                Err(StorageError::Backend(
                    "S3 storage backend requested but the 's3' feature is not enabled. \
                     Rebuild with `cargo build --features s3`."
                        .into(),
                ))
            }
        }
        other => Err(StorageError::Backend(format!(
            "Unknown storage_type '{}'. Supported: local, s3",
            other
        ))),
    }
}
