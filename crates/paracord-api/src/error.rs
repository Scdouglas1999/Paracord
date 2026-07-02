use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ApiError {
    #[error("not found")]
    NotFound,
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("upgrade required: {0}")]
    UpgradeRequired(String),
    /// Rate limited. The i64 value is retry_after in seconds (0 = generic rate limit).
    #[error("rate limited")]
    RateLimited(i64),
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),
    #[error("internal server error")]
    Internal(#[from] anyhow::Error),
}

impl ApiError {
    /// Machine-readable error code string.
    fn error_code(&self) -> &'static str {
        match self {
            ApiError::NotFound => "NOT_FOUND",
            ApiError::Unauthorized => "UNAUTHORIZED",
            ApiError::Forbidden => "FORBIDDEN",
            ApiError::BadRequest(_) => "BAD_REQUEST",
            ApiError::Conflict(_) => "CONFLICT",
            ApiError::UpgradeRequired(_) => "UPGRADE_REQUIRED",
            ApiError::RateLimited(_) => "RATE_LIMITED",
            ApiError::ServiceUnavailable(_) => "SERVICE_UNAVAILABLE",
            ApiError::Internal(_) => "INTERNAL_ERROR",
        }
    }

    fn status_code(&self) -> StatusCode {
        match self {
            ApiError::NotFound => StatusCode::NOT_FOUND,
            ApiError::Unauthorized => StatusCode::UNAUTHORIZED,
            ApiError::Forbidden => StatusCode::FORBIDDEN,
            ApiError::BadRequest(_) => StatusCode::BAD_REQUEST,
            ApiError::Conflict(_) => StatusCode::CONFLICT,
            ApiError::UpgradeRequired(_) => StatusCode::UPGRADE_REQUIRED,
            ApiError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code();

        let (message, retry_after) = match &self {
            ApiError::Internal(err) => {
                tracing::error!("API internal error: {err:#}");
                ("internal server error".to_string(), None)
            }
            ApiError::RateLimited(secs) if *secs > 0 => (self.to_string(), Some(*secs)),
            other => (other.to_string(), None),
        };

        let mut body = json!({
            "code": code,
            "message": message,
            // Keep legacy "error" field for backwards compatibility
            "error": message,
            "details": Value::Null,
        });
        if let Some(secs) = retry_after {
            body["retry_after"] = json!(secs);
        }

        let mut response = (status, Json(body)).into_response();
        if let Some(secs) = retry_after {
            if let Ok(value) = axum::http::HeaderValue::from_str(&secs.to_string()) {
                response
                    .headers_mut()
                    .insert(axum::http::header::RETRY_AFTER, value);
            }
        }
        response
    }
}

impl From<paracord_core::error::CoreError> for ApiError {
    fn from(e: paracord_core::error::CoreError) -> Self {
        match e {
            paracord_core::error::CoreError::NotFound => ApiError::NotFound,
            paracord_core::error::CoreError::Forbidden => ApiError::Forbidden,
            paracord_core::error::CoreError::MissingPermission => ApiError::Forbidden,
            paracord_core::error::CoreError::BadRequest(msg) => ApiError::BadRequest(msg),
            paracord_core::error::CoreError::Conflict(msg) => ApiError::Conflict(msg),
            paracord_core::error::CoreError::RateLimited(secs) => ApiError::RateLimited(secs),
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
