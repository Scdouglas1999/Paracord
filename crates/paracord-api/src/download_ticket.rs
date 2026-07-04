use axum::{extract::State, Json};
use dashmap::DashMap;
use paracord_core::AppState;
use serde_json::{json, Value};
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use uuid::Uuid;

use crate::error::ApiError;
use crate::middleware::AuthUser;

/// Time a minted download ticket stays valid. Short by design: the client
/// refreshes proactively before expiry so `<img>` loads never carry a raw JWT.
const DOWNLOAD_TICKET_TTL: Duration = Duration::from_secs(240);

/// Multi-use download tickets: `ticket -> (user_id, minted_at)`. Unlike SSE
/// stream tickets these are not consumed on use — an image may load/re-render
/// several times within the TTL. Expired entries are swept opportunistically on
/// each mint.
fn download_tickets() -> &'static DashMap<String, (i64, Instant)> {
    static DOWNLOAD_TICKETS: OnceLock<DashMap<String, (i64, Instant)>> = OnceLock::new();
    DOWNLOAD_TICKETS.get_or_init(DashMap::new)
}

/// Validate a download ticket, returning the bound user id if it exists and has
/// not expired. The ticket remains valid for subsequent requests (multi-use).
pub fn validate_download_ticket(ticket: &str) -> Option<i64> {
    let entry = download_tickets().get(ticket)?;
    let (user_id, minted_at) = *entry;
    if minted_at.elapsed() >= DOWNLOAD_TICKET_TTL {
        drop(entry);
        download_tickets().remove(ticket);
        return None;
    }
    Some(user_id)
}

/// Mint a short-lived multi-use ticket the client appends to image/federated-file
/// URLs instead of the raw access token. Requires a Bearer-authenticated user.
pub async fn create_download_ticket(
    State(_state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let tickets = download_tickets();
    tickets.retain(|_, (_, minted_at)| minted_at.elapsed() < DOWNLOAD_TICKET_TTL);

    let ticket = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    tickets.insert(ticket.clone(), (auth.user_id, Instant::now()));

    Ok(Json(json!({ "ticket": ticket })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_tickets_are_multi_use_within_ttl() {
        let ticket = format!("test-{}", Uuid::new_v4().simple());
        download_tickets().insert(ticket.clone(), (42, Instant::now()));

        assert_eq!(validate_download_ticket(&ticket), Some(42));
        assert_eq!(validate_download_ticket(&ticket), Some(42));

        download_tickets().remove(&ticket);
    }
}
