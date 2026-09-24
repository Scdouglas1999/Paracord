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
    #[error("Database history changed; refresh this account before retrying.")]
    HistoryChanged,
    #[error("This message was already delivered and has since been deleted.")]
    DeliveryAlreadyDeleted,
    #[error("This message delivery was canceled before it was created.")]
    DeliveryCanceled,
    #[error("This message edit was canceled before it committed.")]
    EditCanceled,
    /// An AutoMod rule rejected the content. The message is operator-authored
    /// and shown verbatim to the author.
    #[error("{0}")]
    AutomodBlocked(String),
    #[error("upgrade required: {0}")]
    UpgradeRequired(String),
    /// Account creation refused because this instance is invite-only and the
    /// request carried no usable invite. The message is shown to the person
    /// verbatim, and the distinct code lets a client explain it without
    /// matching on words.
    #[error("{0}")]
    InviteRequired(String),
    /// An admin change the server could not save (the config file is not
    /// writable, or an environment variable decides the value). The message
    /// says what to do instead and is shown verbatim.
    #[error("{0}")]
    SettingNotSaved(String),
    /// Rate limited. The i64 value is retry_after in seconds (0 = generic rate limit).
    #[error("rate limited")]
    RateLimited(i64),
    #[error("service unavailable: {0}")]
    ServiceUnavailable(String),
    /// An optional capability this deployment has not configured. The wire
    /// contract is the same 503 a real outage produces, but the answer is the
    /// deployment's own settled state, so request logging records it as the
    /// expected answer it is instead of a server fault.
    #[error("service unavailable: {0}")]
    NotConfigured(String),
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
            ApiError::HistoryChanged => "HISTORY_CHANGED",
            ApiError::DeliveryAlreadyDeleted => "DELIVERY_ALREADY_DELETED",
            ApiError::DeliveryCanceled => "DELIVERY_CANCELLED",
            ApiError::EditCanceled => "EDIT_CANCELLED",
            ApiError::AutomodBlocked(_) => "AUTOMOD_BLOCKED",
            ApiError::UpgradeRequired(_) => "UPGRADE_REQUIRED",
            ApiError::InviteRequired(_) => "INVITE_REQUIRED",
            ApiError::SettingNotSaved(_) => "SETTING_NOT_SAVED",
            ApiError::RateLimited(_) => "RATE_LIMITED",
            ApiError::ServiceUnavailable(_) => "SERVICE_UNAVAILABLE",
            ApiError::NotConfigured(_) => "SERVICE_UNAVAILABLE",
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
            ApiError::HistoryChanged => StatusCode::CONFLICT,
            ApiError::DeliveryAlreadyDeleted => StatusCode::GONE,
            ApiError::DeliveryCanceled => StatusCode::GONE,
            ApiError::EditCanceled => StatusCode::GONE,
            ApiError::AutomodBlocked(_) => StatusCode::FORBIDDEN,
            ApiError::UpgradeRequired(_) => StatusCode::UPGRADE_REQUIRED,
            ApiError::InviteRequired(_) => StatusCode::FORBIDDEN,
            ApiError::SettingNotSaved(_) => StatusCode::CONFLICT,
            ApiError::RateLimited(_) => StatusCode::TOO_MANY_REQUESTS,
            ApiError::ServiceUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::NotConfigured(_) => StatusCode::SERVICE_UNAVAILABLE,
            ApiError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

/// Marks a response whose status the deployment settled on deliberately, so
/// request logging records it at the level the operator needs rather than the
/// level the status code alone implies.
#[derive(Clone, Copy, Debug)]
pub struct ExpectedResponse;

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = self.status_code();
        let code = self.error_code();
        let expected = matches!(self, ApiError::NotConfigured(_));

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
        if expected {
            response.extensions_mut().insert(ExpectedResponse);
        }
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
            paracord_core::error::CoreError::AutomodBlocked(msg) => ApiError::AutomodBlocked(msg),
            paracord_core::error::CoreError::Database(error) => error.into(),
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
            paracord_db::DbError::Conflict(message) => ApiError::Conflict(message),
            paracord_db::DbError::DeliveryAlreadyDeleted => ApiError::DeliveryAlreadyDeleted,
            paracord_db::DbError::DeliveryCanceled => ApiError::DeliveryCanceled,
            paracord_db::DbError::EditCanceled => ApiError::EditCanceled,
            paracord_db::DbError::LimitReached(msg) => ApiError::Conflict(msg),
            paracord_db::DbError::Sqlx(_) => ApiError::Internal(anyhow::anyhow!("database error")),
        }
    }
}
