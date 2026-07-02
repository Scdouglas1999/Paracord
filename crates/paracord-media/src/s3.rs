/// Configuration for S3-compatible object storage.
#[derive(Debug, Clone, serde::Deserialize, serde::Serialize)]
pub struct S3Config {
    /// S3 bucket name.
    pub bucket: String,
    /// AWS region (e.g. `us-east-1`). Also used for non-AWS providers.
    #[serde(default = "default_region")]
    pub region: String,
    /// Custom endpoint URL for S3-compatible providers (MinIO, R2, DigitalOcean Spaces, etc.).
    /// Leave unset to use the default AWS endpoint for the region.
    pub endpoint_url: Option<String>,
    /// Optional key prefix prepended to all object keys (e.g. `paracord/`).
    #[serde(default)]
    pub prefix: String,
    /// Access key ID for the configured S3-compatible provider.
    pub access_key_id: Option<String>,
    /// Secret access key.
    pub secret_access_key: Option<String>,
    /// Opt in to the AWS SDK credential chain when static credentials are not set.
    ///
    /// Disabled by default so self-hosted deployments do not unexpectedly read
    /// ambient AWS profile, SSO, environment, or instance metadata credentials.
    #[serde(default)]
    pub use_aws_credential_chain: bool,
    /// Optional CDN/public base URL for serving files (e.g. `https://cdn.example.com`).
    /// When set, `get_url` returns `{cdn_url}/{prefix}{key}` instead of a presigned URL.
    pub cdn_url: Option<String>,
    /// Presigned URL expiry in seconds (default: 3600).
    #[serde(default = "default_presign_expiry")]
    pub presign_expiry_seconds: u64,
    /// Force path-style addressing (required for MinIO and some providers).
    #[serde(default)]
    pub force_path_style: bool,
}

fn default_region() -> String {
    "us-east-1".into()
}

fn default_presign_expiry() -> u64 {
    3600
}

impl Default for S3Config {
    fn default() -> Self {
        Self {
            bucket: String::new(),
            region: default_region(),
            endpoint_url: None,
            prefix: String::new(),
            access_key_id: None,
            secret_access_key: None,
            use_aws_credential_chain: false,
            cdn_url: None,
            presign_expiry_seconds: default_presign_expiry(),
            force_path_style: false,
        }
    }
}

#[cfg(feature = "s3")]
mod inner {
    use super::*;
    use crate::storage::{StorageBackend, StorageError};
    use aws_config::BehaviorVersion;
    use aws_sdk_s3::config::{Credentials, Region};
    use aws_sdk_s3::presigning::PresigningConfig;
    use aws_sdk_s3::Client;
    use std::time::Duration;

    /// S3-compatible storage backend.
    #[derive(Clone)]
    pub struct S3Storage {
        client: Client,
        bucket: String,
        prefix: String,
        cdn_url: Option<String>,
        presign_expiry: Duration,
    }

    impl S3Storage {
        /// Create a new S3Storage from the given config.
        pub async fn new(config: &S3Config) -> Result<Self, StorageError> {
            let region = Region::new(config.region.clone());

            let mut s3_config_builder = aws_sdk_s3::Config::builder()
                .region(region.clone())
                .behavior_version(BehaviorVersion::latest())
                .force_path_style(config.force_path_style);

            if let Some(ref endpoint) = config.endpoint_url {
                s3_config_builder = s3_config_builder.endpoint_url(endpoint);
            }

            match (&config.access_key_id, &config.secret_access_key) {
                (Some(key_id), Some(secret)) => {
                    let credentials =
                        Credentials::new(key_id, secret, None, None, "paracord-static");
                    s3_config_builder = s3_config_builder.credentials_provider(credentials);
                }
                (None, None) if config.use_aws_credential_chain => {
                    let aws_config = aws_config::defaults(BehaviorVersion::latest())
                        .region(region)
                        .load()
                        .await;
                    let cred_provider = aws_config
                        .credentials_provider()
                        .ok_or_else(|| {
                            StorageError::Backend(
                                "No AWS credentials found in the opted-in AWS credential chain"
                                    .into(),
                            )
                        })?
                        .clone();
                    s3_config_builder = s3_config_builder.credentials_provider(cred_provider);
                }
                (None, None) => {
                    return Err(StorageError::Backend(
                        "S3 storage requires access_key_id and secret_access_key, or explicit use_aws_credential_chain = true".into(),
                    ));
                }
                _ => {
                    return Err(StorageError::Backend(
                        "S3 storage requires both access_key_id and secret_access_key when static credentials are used".into(),
                    ));
                }
            }

            let s3_config = s3_config_builder.build();
            let client = Client::from_conf(s3_config);

            Ok(Self {
                client,
                bucket: config.bucket.clone(),
                prefix: config.prefix.clone(),
                cdn_url: config.cdn_url.clone(),
                presign_expiry: Duration::from_secs(config.presign_expiry_seconds),
            })
        }

        fn full_key(&self, key: &str) -> String {
            if self.prefix.is_empty() {
                key.to_string()
            } else {
                format!("{}{}", self.prefix, key)
            }
        }
    }

    impl StorageBackend for S3Storage {
        async fn store(&self, key: &str, data: &[u8]) -> Result<String, StorageError> {
            let full_key = self.full_key(key);
            let content_type = mime_guess::from_path(key)
                .first_raw()
                .unwrap_or("application/octet-stream");

            self.client
                .put_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .body(data.to_vec().into())
                .content_type(content_type)
                .send()
                .await
                .map_err(|e| StorageError::Backend(format!("S3 PutObject failed: {}", e)))?;

            tracing::debug!("S3: stored object {}", full_key);
            Ok(key.to_string())
        }

        async fn retrieve(&self, key: &str) -> Result<Vec<u8>, StorageError> {
            let full_key = self.full_key(key);

            let resp = self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .send()
                .await
                .map_err(|e| {
                    let msg = format!("{}", e);
                    if msg.contains("NoSuchKey") || msg.contains("404") {
                        StorageError::NotFound(key.to_string())
                    } else {
                        StorageError::Backend(format!("S3 GetObject failed: {}", e))
                    }
                })?;

            let bytes = resp
                .body
                .collect()
                .await
                .map_err(|e| StorageError::Backend(format!("S3 read body failed: {}", e)))?
                .into_bytes();

            Ok(bytes.to_vec())
        }

        async fn delete(&self, key: &str) -> Result<(), StorageError> {
            let full_key = self.full_key(key);

            self.client
                .delete_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .send()
                .await
                .map_err(|e| StorageError::Backend(format!("S3 DeleteObject failed: {}", e)))?;

            tracing::debug!("S3: deleted object {}", full_key);
            Ok(())
        }

        async fn exists(&self, key: &str) -> Result<bool, StorageError> {
            let full_key = self.full_key(key);

            match self
                .client
                .head_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .send()
                .await
            {
                Ok(_) => Ok(true),
                Err(e) => {
                    let msg = format!("{}", e);
                    if msg.contains("NotFound") || msg.contains("404") || msg.contains("NoSuchKey")
                    {
                        Ok(false)
                    } else {
                        Err(StorageError::Backend(format!(
                            "S3 HeadObject failed: {}",
                            e
                        )))
                    }
                }
            }
        }

        async fn get_url(&self, key: &str) -> Result<String, StorageError> {
            let full_key = self.full_key(key);

            // If a CDN URL is configured, build a direct public URL.
            if let Some(ref cdn_base) = self.cdn_url {
                let base = cdn_base.trim_end_matches('/');
                return Ok(format!("{}/{}", base, full_key));
            }

            // Otherwise, generate a presigned URL.
            let presign_config = PresigningConfig::expires_in(self.presign_expiry)
                .map_err(|e| StorageError::Backend(format!("presign config error: {}", e)))?;

            let presigned = self
                .client
                .get_object()
                .bucket(&self.bucket)
                .key(&full_key)
                .presigned(presign_config)
                .await
                .map_err(|e| StorageError::Backend(format!("S3 presigned URL failed: {}", e)))?;

            Ok(presigned.uri().to_string())
        }
    }
}

#[cfg(feature = "s3")]
pub use inner::S3Storage;

#[cfg(all(test, feature = "s3"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn s3_requires_explicit_credentials_by_default() {
        let config = S3Config {
            bucket: "paracord-test".to_string(),
            ..S3Config::default()
        };

        let err = match S3Storage::new(&config).await {
            Ok(_) => panic!("missing credentials should fail without opt-in chain"),
            Err(err) => err,
        };

        assert!(format!("{err}").contains("requires access_key_id and secret_access_key"));
    }

    #[tokio::test]
    async fn s3_rejects_partial_static_credentials() {
        let config = S3Config {
            bucket: "paracord-test".to_string(),
            access_key_id: Some("key".to_string()),
            ..S3Config::default()
        };

        let err = match S3Storage::new(&config).await {
            Ok(_) => panic!("partial credentials should fail"),
            Err(err) => err,
        };

        assert!(format!("{err}").contains("requires both access_key_id and secret_access_key"));
    }
}
