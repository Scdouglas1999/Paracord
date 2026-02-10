use std::path::{Path, PathBuf};
use thiserror::Error;
use tokio::fs;
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("file too large: {0}")]
    TooLarge(String),
}

#[allow(async_fn_in_trait)]
pub trait Storage: Send + Sync {
    async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError>;
    async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError>;
    async fn delete(&self, key: &str) -> Result<(), StorageError>;
}

#[derive(Clone)]
pub struct LocalStorage {
    base_path: PathBuf,
}

impl LocalStorage {
    pub fn new(base_path: impl Into<PathBuf>) -> Self {
        Self {
            base_path: base_path.into(),
        }
    }
}

impl Storage for LocalStorage {
    async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError> {
        let path = self.base_path.join(key);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&path, data).await?;
        Ok(key.to_string())
    }

    async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError> {
        let path = self.base_path.join(key);
        if !Path::new(&path).exists() {
            return Err(StorageError::NotFound(key.to_string()));
        }
        Ok(fs::read(&path).await?)
    }

    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        let path = self.base_path.join(key);
        if path.exists() {
            fs::remove_file(&path).await?;
        }
        Ok(())
    }
}

// --- File sharing storage ---

#[derive(Debug, Clone)]
pub struct StorageConfig {
    pub base_path: PathBuf,
    pub max_file_size: u64,
    pub p2p_threshold: u64,
    pub allowed_extensions: Option<Vec<String>>,
}

pub struct StorageManager {
    config: StorageConfig,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct StoredFile {
    pub id: String,
    pub filename: String,
    pub size: u64,
    pub content_type: String,
    pub path: PathBuf,
    pub url: String,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct P2PTransferRequest {
    pub transfer_id: String,
    pub filename: String,
    pub size: u64,
    pub sender_id: i64,
    pub recipient_ids: Vec<i64>,
    pub chunks: u64,
    pub chunk_size: u64,
}

impl StorageManager {
    pub fn new(config: StorageConfig) -> Self {
        Self { config }
    }

    /// Store a file on the server (for files under the size limit).
    pub async fn store_file(
        &self,
        guild_id: i64,
        channel_id: i64,
        filename: &str,
        data: &[u8],
    ) -> Result<StoredFile, anyhow::Error> {
        let size = data.len() as u64;

        if size > self.config.max_file_size {
            anyhow::bail!(
                "File too large for server storage. Use P2P transfer for files over {}MB",
                self.config.max_file_size / 1_000_000
            );
        }

        let file_id = Uuid::new_v4().to_string();
        let content_type = mime_guess::from_path(filename)
            .first_or_octet_stream()
            .to_string();

        // Create directory structure: base_path/guild_id/channel_id/
        let dir = self
            .config
            .base_path
            .join(guild_id.to_string())
            .join(channel_id.to_string());
        fs::create_dir_all(&dir).await?;

        // Store with UUID filename to prevent collisions
        let ext = Path::new(filename)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("");
        let stored_name = if ext.is_empty() {
            file_id.clone()
        } else {
            format!("{}.{}", file_id, ext)
        };
        let file_path = dir.join(&stored_name);

        let mut file = fs::File::create(&file_path).await?;
        file.write_all(data).await?;
        file.flush().await?;

        let url = format!(
            "/api/attachments/{}/{}",
            file_id,
            urlencoding::encode(filename)
        );

        Ok(StoredFile {
            id: file_id,
            filename: filename.to_string(),
            size,
            content_type,
            path: file_path,
            url,
        })
    }

    /// Delete a stored file.
    pub async fn delete_file(
        &self,
        guild_id: i64,
        channel_id: i64,
        file_id: &str,
    ) -> Result<(), anyhow::Error> {
        let dir = self
            .config
            .base_path
            .join(guild_id.to_string())
            .join(channel_id.to_string());

        let mut entries = fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(file_id))
            {
                fs::remove_file(entry.path()).await?;
                return Ok(());
            }
        }

        anyhow::bail!("File not found: {}", file_id)
    }

    /// Get file path for serving.
    pub async fn get_file_path(
        &self,
        guild_id: i64,
        channel_id: i64,
        file_id: &str,
    ) -> Result<PathBuf, anyhow::Error> {
        let dir = self
            .config
            .base_path
            .join(guild_id.to_string())
            .join(channel_id.to_string());

        let mut entries = fs::read_dir(&dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            if entry
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with(file_id))
            {
                return Ok(entry.path());
            }
        }

        anyhow::bail!("File not found: {}", file_id)
    }

    /// Create a P2P transfer request for large files.
    pub fn create_p2p_transfer(
        &self,
        filename: &str,
        size: u64,
        sender_id: i64,
        recipient_ids: Vec<i64>,
    ) -> P2PTransferRequest {
        let chunk_size: u64 = 256 * 1024; // 256KB chunks
        let chunks = size.div_ceil(chunk_size);

        P2PTransferRequest {
            transfer_id: Uuid::new_v4().to_string(),
            filename: filename.to_string(),
            size,
            sender_id,
            recipient_ids,
            chunks,
            chunk_size,
        }
    }

    /// Get storage usage for a guild.
    pub async fn get_guild_storage_usage(&self, guild_id: i64) -> Result<u64, anyhow::Error> {
        let guild_dir = self.config.base_path.join(guild_id.to_string());
        if !guild_dir.exists() {
            return Ok(0);
        }

        let mut total: u64 = 0;
        let mut stack = vec![guild_dir];

        while let Some(dir) = stack.pop() {
            if let Ok(mut entries) = fs::read_dir(&dir).await {
                while let Some(entry) = entries.next_entry().await? {
                    let metadata = entry.metadata().await?;
                    if metadata.is_file() {
                        total += metadata.len();
                    } else if metadata.is_dir() {
                        stack.push(entry.path());
                    }
                }
            }
        }

        Ok(total)
    }
}
