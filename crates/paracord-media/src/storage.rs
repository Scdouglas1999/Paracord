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
    #[error("storage backend error: {0}")]
    Backend(String),
    #[error("invalid storage key: {0}")]
    InvalidKey(String),
}

/// Validate a storage key before it is joined onto a filesystem root.
///
/// Storage keys are slash-delimited relative paths (e.g. `attachments/123.png`
/// or `fed-cache/{origin_server}/{id}`). Callers normally pass server-generated
/// snowflakes, but the trait is a security boundary and must not trust its input:
/// a key containing a `..` component, an absolute-path prefix, a Windows drive or
/// UNC prefix, or a backslash separator could otherwise escape the storage root.
///
/// This rejects such keys outright. Post-join canonicalization in
/// [`LocalStorage`] provides defence-in-depth for the local backend, but this
/// syntactic check keeps the contract uniform across every backend.
fn validate_key(key: &str) -> Result<(), StorageError> {
    if key.is_empty() {
        return Err(StorageError::InvalidKey("empty key".to_string()));
    }
    // Backslashes are path separators on Windows and must never appear in a key.
    if key.contains('\\') {
        return Err(StorageError::InvalidKey(format!(
            "key contains a backslash: {key}"
        )));
    }
    // Reject anything the platform would treat as absolute or as a drive/UNC
    // prefix (e.g. `/etc/...`, `C:\...`). This also covers a leading `/`.
    if Path::new(key).is_absolute() {
        return Err(StorageError::InvalidKey(format!(
            "key is not relative: {key}"
        )));
    }
    // Walk the components and reject any parent-dir (`..`) or root/prefix
    // component. Plain `.` components and normal names are allowed.
    for component in Path::new(key).components() {
        match component {
            std::path::Component::ParentDir => {
                return Err(StorageError::InvalidKey(format!(
                    "key contains a parent-directory component: {key}"
                )));
            }
            std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                return Err(StorageError::InvalidKey(format!(
                    "key contains a root or prefix component: {key}"
                )));
            }
            std::path::Component::CurDir | std::path::Component::Normal(_) => {}
        }
    }
    Ok(())
}

/// Unified storage backend trait for file persistence.
///
/// Implementations exist for local filesystem and S3-compatible object stores.
/// All keys are slash-delimited paths (e.g. `attachments/12345.png`).
#[allow(async_fn_in_trait)]
pub trait StorageBackend: Send + Sync {
    /// Store `data` under `key`, returning the canonical key.
    async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError>;

    /// Retrieve the raw bytes for `key`.
    async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError>;

    /// Delete the object at `key`. No-op if it does not exist.
    async fn delete(&self, key: &str) -> Result<(), StorageError>;

    /// Check whether `key` exists in the store.
    async fn exists(&self, key: &str) -> Result<bool, StorageError>;

    /// Return a URL suitable for the client to fetch this object.
    ///
    /// For local storage this returns the API download path (e.g. `/api/v1/attachments/123`).
    /// For S3 storage this can return a presigned URL.
    async fn get_url(&self, key: &str) -> Result<String, StorageError>;
}

/// Enum-dispatch wrapper that implements `StorageBackend` and is `Clone + Send + Sync`.
///
/// This avoids the dyn-safety limitations of `async fn in trait`.
#[derive(Clone)]
pub enum Storage {
    Local(LocalStorage),
    #[cfg(feature = "s3")]
    S3(crate::s3::S3Storage),
}

impl Storage {
    pub async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError> {
        match self {
            Storage::Local(s) => s.store(key, data).await,
            #[cfg(feature = "s3")]
            Storage::S3(s) => s.store(key, data).await,
        }
    }

    pub async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError> {
        match self {
            Storage::Local(s) => s.retrieve(key).await,
            #[cfg(feature = "s3")]
            Storage::S3(s) => s.retrieve(key).await,
        }
    }

    pub async fn delete(&self, key: &str) -> Result<(), StorageError> {
        match self {
            Storage::Local(s) => s.delete(key).await,
            #[cfg(feature = "s3")]
            Storage::S3(s) => s.delete(key).await,
        }
    }

    pub async fn exists(&self, key: &str) -> Result<bool, StorageError> {
        match self {
            Storage::Local(s) => s.exists(key).await,
            #[cfg(feature = "s3")]
            Storage::S3(s) => s.exists(key).await,
        }
    }

    pub async fn get_url(&self, key: &str) -> Result<String, StorageError> {
        match self {
            Storage::Local(s) => s.get_url(key).await,
            #[cfg(feature = "s3")]
            Storage::S3(s) => s.get_url(key).await,
        }
    }
}

// ── Local filesystem backend ─────────────────────────────────────────────────

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

    /// Validate `key` and resolve it to an absolute path inside `base_path`.
    ///
    /// After the syntactic [`validate_key`] check, the resolved path's parent
    /// directory is canonicalized (if it already exists) and asserted to remain
    /// under the canonicalized `base_path`. This is defence-in-depth against
    /// symlinks or edge cases the syntactic check does not model; the join
    /// target file itself need not exist yet.
    fn resolve_path(&self, key: &str) -> Result<PathBuf, StorageError> {
        validate_key(key)?;
        let path = self.base_path.join(key);

        // Canonicalize the base once so containment comparisons are symlink-safe.
        // If the base does not exist yet, fall back to the configured path.
        let canonical_base = self
            .base_path
            .canonicalize()
            .unwrap_or_else(|_| self.base_path.clone());

        // The target file may not exist yet (store), so canonicalize the nearest
        // existing ancestor and confirm it is still within the base.
        let mut ancestor = path.as_path();
        loop {
            match ancestor.canonicalize() {
                Ok(canonical) => {
                    if !canonical.starts_with(&canonical_base) {
                        return Err(StorageError::InvalidKey(format!(
                            "key escapes storage root: {key}"
                        )));
                    }
                    break;
                }
                Err(_) => match ancestor.parent() {
                    Some(parent) => ancestor = parent,
                    // Reached the filesystem root without matching the base:
                    // the syntactic guard already rejects absolute keys, so a
                    // relative key that gets here is confined to base_path.
                    None => break,
                },
            }
        }

        Ok(path)
    }
}

impl StorageBackend for LocalStorage {
    async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError> {
        let path = self.resolve_path(key)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).await?;
        }
        fs::write(&path, data).await?;
        Ok(key.to_string())
    }

    async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError> {
        let path = self.resolve_path(key)?;
        if !Path::new(&path).exists() {
            return Err(StorageError::NotFound(key.to_string()));
        }
        Ok(fs::read(&path).await?)
    }

    async fn delete(&self, key: &str) -> Result<(), StorageError> {
        let path = self.resolve_path(key)?;
        if path.exists() {
            fs::remove_file(&path).await?;
        }
        Ok(())
    }

    async fn exists(&self, key: &str) -> Result<bool, StorageError> {
        let path = self.resolve_path(key)?;
        Ok(path.exists())
    }

    async fn get_url(&self, key: &str) -> Result<String, StorageError> {
        validate_key(key)?;
        // Extract the attachment ID from the key for the API path.
        // Keys are formatted as `attachments/{id}.{ext}`.
        let stem = Path::new(key)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(key);
        Ok(format!("/api/v1/attachments/{}", stem))
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
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn local_storage() -> (TempDir, LocalStorage) {
        let dir = tempfile::tempdir().expect("tempdir");
        let storage = LocalStorage::new(dir.path());
        (dir, storage)
    }

    #[test]
    fn validate_key_accepts_normal_keys() {
        assert!(validate_key("attachments/12345.png").is_ok());
        assert!(validate_key("fed-cache/example.org/98765.webp").is_ok());
        assert!(validate_key("plainfile").is_ok());
    }

    #[test]
    fn validate_key_rejects_parent_traversal() {
        assert!(matches!(
            validate_key("../secret"),
            Err(StorageError::InvalidKey(_))
        ));
        assert!(matches!(
            validate_key("attachments/../../etc/passwd"),
            Err(StorageError::InvalidKey(_))
        ));
        assert!(matches!(
            validate_key("fed-cache/../../../etc/passwd"),
            Err(StorageError::InvalidKey(_))
        ));
    }

    #[test]
    fn validate_key_rejects_absolute_paths() {
        assert!(matches!(
            validate_key("/etc/passwd"),
            Err(StorageError::InvalidKey(_))
        ));
        assert!(matches!(
            validate_key("/tmp/attachments/1.png"),
            Err(StorageError::InvalidKey(_))
        ));
    }

    #[test]
    fn validate_key_rejects_backslashes() {
        assert!(matches!(
            validate_key("..\\..\\secret"),
            Err(StorageError::InvalidKey(_))
        ));
        assert!(matches!(
            validate_key("attachments\\1.png"),
            Err(StorageError::InvalidKey(_))
        ));
    }

    #[test]
    fn validate_key_rejects_empty() {
        assert!(matches!(validate_key(""), Err(StorageError::InvalidKey(_))));
    }

    #[tokio::test]
    async fn store_and_retrieve_normal_key_roundtrips() {
        let (_dir, storage) = local_storage();
        let key = "attachments/12345.png";
        let data = b"hello world";

        let returned = storage.store(key, data).await.expect("store");
        assert_eq!(returned, key);
        assert!(storage.exists(key).await.expect("exists"));

        let read_back = storage.retrieve(key).await.expect("retrieve");
        assert_eq!(read_back, data);

        storage.delete(key).await.expect("delete");
        assert!(!storage.exists(key).await.expect("exists after delete"));
    }

    #[tokio::test]
    async fn fed_cache_key_roundtrips() {
        let (_dir, storage) = local_storage();
        let key = "fed-cache/example.org/98765.webp";
        storage.store(key, b"cached").await.expect("store");
        assert_eq!(storage.retrieve(key).await.expect("retrieve"), b"cached");
    }

    #[tokio::test]
    async fn store_rejects_traversal_and_does_not_escape_root() {
        let (dir, storage) = local_storage();
        let payload = b"escaped";

        for key in ["../escaped.txt", "attachments/../../escaped.txt"] {
            let err = storage.store(key, payload).await.unwrap_err();
            assert!(matches!(err, StorageError::InvalidKey(_)), "key={key}");
        }

        // Nothing should have been written outside the storage root.
        let escaped = dir.path().parent().map(|p| p.join("escaped.txt"));
        if let Some(escaped) = escaped {
            assert!(!escaped.exists(), "traversal wrote outside the root");
        }
    }

    #[tokio::test]
    async fn store_rejects_absolute_key() {
        let (_dir, storage) = local_storage();
        let err = storage
            .store("/etc/paracord-should-not-exist", b"x")
            .await
            .unwrap_err();
        assert!(matches!(err, StorageError::InvalidKey(_)));
    }

    #[tokio::test]
    async fn store_rejects_backslash_key() {
        let (_dir, storage) = local_storage();
        let err = storage.store("attachments\\1.png", b"x").await.unwrap_err();
        assert!(matches!(err, StorageError::InvalidKey(_)));
    }

    #[tokio::test]
    async fn retrieve_delete_exists_reject_traversal() {
        let (_dir, storage) = local_storage();
        let key = "../../etc/passwd";

        assert!(matches!(
            storage.retrieve(key).await.unwrap_err(),
            StorageError::InvalidKey(_)
        ));
        assert!(matches!(
            storage.delete(key).await.unwrap_err(),
            StorageError::InvalidKey(_)
        ));
        assert!(matches!(
            storage.exists(key).await.unwrap_err(),
            StorageError::InvalidKey(_)
        ));
    }
}
