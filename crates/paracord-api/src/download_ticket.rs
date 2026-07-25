use axum::{extract::State, Json};
use chrono::Utc;
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
const MAX_PENDING_DOWNLOAD_TICKETS: usize = 100_000;

/// A minted multi-use download ticket, bound to the session that created it.
struct TicketEntry {
    user_id: i64,
    /// Minting session id + access-token jti, present when the minter
    /// authenticated with a user session (bot tokens have neither). Recorded so
    /// outstanding tickets can be invalidated when that session is revoked or the
    /// user logs out.
    session_id: Option<String>,
    jti: Option<String>,
    minted_at: Instant,
}

/// Multi-use download tickets: `ticket -> TicketEntry`. Unlike SSE stream
/// tickets these are not consumed on use — an image may load/re-render several
/// times within the TTL. Expired entries are swept opportunistically on each
/// mint.
fn download_tickets() -> &'static DashMap<String, TicketEntry> {
    static DOWNLOAD_TICKETS: OnceLock<DashMap<String, TicketEntry>> = OnceLock::new();
    DOWNLOAD_TICKETS.get_or_init(DashMap::new)
}

/// Look up a ticket enforcing only existence + TTL (no session recheck).
/// Returns the bound user id and — when minted from a user session — the
/// minting session id/jti for the caller to re-validate. Multi-use: not
/// consumed on lookup.
fn lookup_download_ticket(ticket: &str) -> Option<(i64, Option<String>, Option<String>)> {
    let entry = download_tickets().get(ticket)?;
    if entry.minted_at.elapsed() >= DOWNLOAD_TICKET_TTL {
        drop(entry);
        download_tickets().remove(ticket);
        return None;
    }
    Some((entry.user_id, entry.session_id.clone(), entry.jti.clone()))
}

/// Validate a download ticket, returning the bound user id if it exists, has not
/// expired, and — for tickets minted from a user session — that session's access
/// token is still active, so logout / session revocation drops any outstanding
/// tickets. Bot-minted tickets (no session) skip the active-session check. The
/// ticket remains valid for subsequent requests (multi-use).
///
/// `Ok(None)` means "this ticket does not authenticate anyone" (unknown, expired,
/// or its session was revoked). A database failure is reported as
/// `Err(ApiError::Internal)` instead of being folded into `None`: the ticket is
/// still never honored, but the caller must answer 5xx rather than tell the
/// client its credential was rejected.
pub async fn validate_download_ticket(
    state: &AppState,
    ticket: &str,
) -> Result<Option<i64>, ApiError> {
    let Some((user_id, session_id, jti)) = lookup_download_ticket(ticket) else {
        return Ok(None);
    };

    if let (Some(session_id), Some(jti)) = (session_id.as_deref(), jti.as_deref()) {
        let active = paracord_db::sessions::is_access_token_active(
            &state.db,
            user_id,
            session_id,
            jti,
            Utc::now(),
        )
        .await
        // Fail closed on a database error rather than honoring the ticket.
        .map_err(|_| ApiError::Internal(anyhow::anyhow!("database error")))?;
        if !active {
            download_tickets().remove(ticket);
            return Ok(None);
        }
    }

    Ok(Some(user_id))
}

/// Mint a short-lived multi-use ticket the client appends to image/federated-file
/// URLs instead of the raw access token. Requires a Bearer-authenticated user.
/// The ticket is bound to the minting session so it stops working once that
/// session is revoked.
pub async fn create_download_ticket(
    State(_state): State<AppState>,
    auth: AuthUser,
) -> Result<Json<Value>, ApiError> {
    let tickets = download_tickets();
    tickets.retain(|_, entry| entry.minted_at.elapsed() < DOWNLOAD_TICKET_TTL);
    if tickets.len() >= MAX_PENDING_DOWNLOAD_TICKETS {
        return Err(ApiError::RateLimited(1));
    }

    let ticket = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    tickets.insert(
        ticket.clone(),
        TicketEntry {
            user_id: auth.user_id,
            session_id: auth.session_id,
            jti: auth.token_jti,
            minted_at: Instant::now(),
        },
    );

    Ok(Json(json!({ "ticket": ticket })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_tickets_are_multi_use_within_ttl() {
        let ticket = format!("test-{}", Uuid::new_v4().simple());
        download_tickets().insert(
            ticket.clone(),
            TicketEntry {
                user_id: 42,
                session_id: None,
                jti: None,
                minted_at: Instant::now(),
            },
        );

        assert_eq!(lookup_download_ticket(&ticket), Some((42, None, None)));
        assert_eq!(lookup_download_ticket(&ticket), Some((42, None, None)));

        download_tickets().remove(&ticket);
    }

    #[test]
    fn expired_tickets_are_rejected_and_removed() {
        let ticket = format!("test-{}", Uuid::new_v4().simple());
        download_tickets().insert(
            ticket.clone(),
            TicketEntry {
                user_id: 7,
                session_id: Some("sess".into()),
                jti: Some("jti".into()),
                minted_at: Instant::now() - DOWNLOAD_TICKET_TTL,
            },
        );

        assert_eq!(lookup_download_ticket(&ticket), None);
        assert!(download_tickets().get(&ticket).is_none());
    }
}
