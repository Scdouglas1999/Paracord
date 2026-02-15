use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden: {0}")]
    Forbidden(String),
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("rate limited")]
    RateLimited,
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("internal server error")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            ApiError::NotFound => (StatusCode::NOT_FOUND, self.to_string()),
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, self.to_string()),
            ApiError::Forbidden(_) => (StatusCode::FORBIDDEN, self.to_string()),
            ApiError::BadRequest(_) => (StatusCode::BAD_REQUEST, self.to_string()),
            ApiError::Conflict(_) => (StatusCode::CONFLICT, self.to_string()),
            ApiError::RateLimited => (StatusCode::TOO_MANY_REQUESTS, "rate limited".to_string()),
            ApiError::ServiceUnavailable(_) => (StatusCode::SERVICE_UNAVAILABLE, self.to_string()),
            ApiError::Internal(err) => {
                tracing::error!("API internal error: {err:#}");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "internal server error".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message, "message": message }))).into_response()
    }
}

impl From<paracord_core::error::CoreError> for ApiError {
    fn from(e: paracord_core::error::CoreError) -> Self {
        match e {
            paracord_core::error::CoreError::NotFound => ApiError::NotFound,
            paracord_core::error::CoreError::Forbidden => ApiError::Forbidden("forbidden".into()),
            paracord_core::error::CoreError::MissingPermission => ApiError::Forbidden("missing permission".into()),
            paracord_core::error::CoreError::BadRequest(msg) => ApiError::BadRequest(msg),
            paracord_core::error::CoreError::Conflict(msg) => ApiError::Conflict(msg),
            paracord_core::error::CoreError::Database(_) => {
                ApiError::Internal(anyhow::anyhow!("database error"))
            }
            paracord_core::error::CoreError::Internal(msg) => {
                ApiError::Internal(anyhow::anyhow!(msg))
            }
        }
    }
}

impl From<paracord_db::DbError> for ApiError {
    fn from(e: paracord_db::DbError) -> Self {
        match e {
            paracord_db::DbError::NotFound => ApiError::NotFound,
            paracord_db::DbError::Sqlx(_) => ApiError::Internal(anyhow::anyhow!("database error")),
        }
    }
}
