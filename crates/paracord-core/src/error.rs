use thiserror::Error;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error("not found")]
    NotFound,
    #[error("forbidden")]
    Forbidden,
    #[error("missing permission")]
    MissingPermission,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("conflict: {0}")]
    Conflict(String),
    /// Slowmode rate limit. The value is seconds until the user can send again.
    #[error("rate limited")]
    RateLimited(i64),
    #[error("database error: {0}")]
    Database(#[from] paracord_db::DbError),
    #[error("internal error: {0}")]
    Internal(String),
}
