//! Profile and server banners: one still image per owner, stored on disk next
//! to avatars and served from a stable API path. The stored `banner_hash` is
//! that path plus a `?v=` version, so a replaced banner is a new URL and no
//! browser keeps painting the old one from its HTTP cache.

use axum::{
    extract::Multipart,
    http::{header, HeaderValue},
    response::{IntoResponse, Response},
};
use std::path::PathBuf;

use crate::error::ApiError;

pub(crate) const MAX_BANNER_IMAGE_SIZE: usize = 8 * 1024 * 1024;

const FORMATS: [(&str, &str); 5] = [
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// Where a kind of banner lives: `users` → `banners/`, `guilds` → `guild-banners/`.
#[derive(Clone, Copy)]
pub(crate) enum BannerOwner {
    User,
    Guild,
}

impl BannerOwner {
    fn dir(self, storage_path: &str) -> PathBuf {
        PathBuf::from(storage_path).join(match self {
            BannerOwner::User => "banners",
            BannerOwner::Guild => "guild-banners",
        })
    }

    /// The URL the client loads, which is also what `banner_hash` stores.
    pub(crate) fn api_path(self, id: i64) -> String {
        match self {
            BannerOwner::User => format!("/api/v1/users/{id}/banner"),
            BannerOwner::Guild => format!("/api/v1/guilds/{id}/banner"),
        }
    }
}

/// Read the image part of a banner upload (`banner`, `image` or `file`).
pub(crate) async fn read_banner_upload(
    multipart: &mut Multipart,
) -> Result<(Vec<u8>, Option<String>), ApiError> {
    let mut image: Option<(Vec<u8>, Option<String>)> = None;
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(e.to_string()))?
    {
        if matches!(
            field.name().unwrap_or("").trim(),
            "banner" | "image" | "file"
        ) {
            let content_type = field.content_type().map(str::to_string);
            let bytes = field
                .bytes()
                .await
                .map_err(|e| ApiError::BadRequest(e.to_string()))?
                .to_vec();
            image = Some((bytes, content_type));
        }
    }
    let (bytes, content_type) =
        image.ok_or_else(|| ApiError::BadRequest("Missing banner image".into()))?;
    if bytes.is_empty() || bytes.len() > MAX_BANNER_IMAGE_SIZE {
        return Err(ApiError::BadRequest(
            "Banner must be between 1 byte and 8 MB".into(),
        ));
    }
    Ok((bytes, content_type))
}

/// The file extension for a banner, from its magic bytes. A declared content
/// type that disagrees with the bytes is refused.
fn banner_extension(data: &[u8], declared: Option<&str>) -> Result<&'static str, ApiError> {
    let (content_type, ext) = match data {
        [0x89, b'P', b'N', b'G', ..] => ("image/png", "png"),
        [0xFF, 0xD8, 0xFF, ..] => ("image/jpeg", "jpg"),
        [b'G', b'I', b'F', b'8', ..] => ("image/gif", "gif"),
        [b'R', b'I', b'F', b'F', _, _, _, _, b'W', b'E', b'B', b'P', ..] => ("image/webp", "webp"),
        _ => {
            return Err(ApiError::BadRequest(
                "Banner image must be PNG, JPEG, GIF, or WebP".into(),
            ));
        }
    };
    if let Some(declared) = declared {
        let declared = declared.split(';').next().unwrap_or(declared).trim();
        if !declared.is_empty()
            && !declared.eq_ignore_ascii_case(content_type)
            && !(declared.eq_ignore_ascii_case("image/jpg") && content_type == "image/jpeg")
        {
            return Err(ApiError::BadRequest(
                "Banner content type does not match the image".into(),
            ));
        }
    }
    Ok(ext)
}

/// Remove every stored format of this owner's banner.
pub(crate) async fn remove_banner_files(storage_path: &str, owner: BannerOwner, id: i64) {
    let dir = owner.dir(storage_path);
    for (ext, _) in FORMATS {
        let _ = tokio::fs::remove_file(dir.join(format!("{id}.{ext}"))).await;
    }
}

/// Validate and write a banner, replacing any earlier one. Returns the
/// versioned path to store in `banner_hash`.
pub(crate) async fn store_banner(
    storage_path: &str,
    owner: BannerOwner,
    id: i64,
    data: &[u8],
    declared: Option<&str>,
) -> Result<String, ApiError> {
    let ext = banner_extension(data, declared)?;
    let dir = owner.dir(storage_path);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    remove_banner_files(storage_path, owner, id).await;
    tokio::fs::write(dir.join(format!("{id}.{ext}")), data)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    Ok(format!(
        "{}?v={}",
        owner.api_path(id),
        chrono::Utc::now().timestamp_millis()
    ))
}

/// Serve the stored banner when `banner_hash` points at it.
pub(crate) async fn serve_banner(
    storage_path: &str,
    owner: BannerOwner,
    id: i64,
    banner_hash: Option<&str>,
) -> Result<Response, ApiError> {
    let stored_path = banner_hash.map(|hash| hash.split_once('?').map_or(hash, |(path, _)| path));
    if stored_path != Some(owner.api_path(id).as_str()) {
        return Err(ApiError::NotFound);
    }
    let dir = owner.dir(storage_path);
    for (ext, content_type) in FORMATS {
        let path = dir.join(format!("{id}.{ext}"));
        if !tokio::fs::try_exists(&path).await.unwrap_or(false) {
            continue;
        }
        let data = tokio::fs::read(&path)
            .await
            .map_err(|_| ApiError::NotFound)?;
        return Ok((
            [
                (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
                (
                    header::CACHE_CONTROL,
                    HeaderValue::from_static("private, max-age=3600"),
                ),
                (
                    header::X_CONTENT_TYPE_OPTIONS,
                    HeaderValue::from_static("nosniff"),
                ),
            ],
            data,
        )
            .into_response());
    }
    Err(ApiError::NotFound)
}
