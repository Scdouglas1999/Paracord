use axum::{
    extract::Request,
    http::{Method, StatusCode},
    middleware::{from_fn, Next},
    response::Response,
    response::IntoResponse,
    routing::{any, delete, get, patch, post, put},
    Json, Router,
};
use paracord_core::AppState;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

pub mod error;
pub mod middleware;
pub mod routes;

pub fn build_router(allowed_origins: &[String], public_url: Option<&str>) -> Router<AppState> {
    let cors = build_cors_layer(allowed_origins, public_url);
    Router::new()
        // Health
        .route("/health", get(health))
        .route("/api/v1/health", get(health))
        .route("/metrics", get(metrics))
        .route("/api/v1/metrics", get(metrics))
        // Federation discovery and transport
        .route(
            "/.well-known/paracord/server",
            get(routes::federation::well_known),
        )
        .route(
            "/_paracord/federation/v1/keys",
            get(routes::federation::get_keys),
        )
        .route(
            "/_paracord/federation/v1/event",
            post(routes::federation::ingest_event),
        )
        .route(
            "/_paracord/federation/v1/event/{event_id}",
            get(routes::federation::get_event),
        )
        // Auth
        .route("/api/v1/auth/register", post(routes::auth::register))
        .route("/api/v1/auth/login", post(routes::auth::login))
        .route("/api/v1/auth/refresh", post(routes::auth::refresh))
        .route("/api/v1/auth/challenge", post(routes::auth::challenge))
        .route("/api/v1/auth/verify", post(routes::auth::verify))
        .route(
            "/api/v1/auth/attach-public-key",
            post(routes::auth::attach_public_key),
        )
        // Users
        .route(
            "/api/v1/users/@me",
            get(routes::users::get_me).patch(routes::users::update_me),
        )
        .route(
            "/api/v1/users/@me/settings",
            get(routes::users::get_settings).patch(routes::users::update_settings),
        )
        .route("/api/v1/users/@me/guilds", get(routes::guilds::list_guilds))
        .route(
            "/api/v1/users/@me/dms",
            get(routes::dms::list_dms).post(routes::dms::create_dm),
        )
        .route(
            "/api/v1/users/@me/read-states",
            get(routes::users::get_read_states),
        )
        // Guilds
        .route("/api/v1/guilds", post(routes::guilds::create_guild))
        .route(
            "/api/v1/guilds/{guild_id}",
            get(routes::guilds::get_guild)
                .patch(routes::guilds::update_guild)
                .delete(routes::guilds::delete_guild),
        )
        .route(
            "/api/v1/guilds/{guild_id}/owner",
            post(routes::guilds::transfer_ownership),
        )
        .route(
            "/api/v1/guilds/{guild_id}/channels",
            get(routes::guilds::get_channels).post(routes::channels::create_channel),
        )
        .route(
            "/api/v1/guilds/{guild_id}/members",
            get(routes::members::list_members),
        )
        .route(
            "/api/v1/guilds/{guild_id}/members/{user_id}",
            patch(routes::members::update_member).delete(routes::members::kick_member),
        )
        .route(
            "/api/v1/guilds/{guild_id}/members/@me",
            delete(routes::members::leave_guild),
        )
        .route(
            "/api/v1/guilds/{guild_id}/bans",
            get(routes::bans::list_bans),
        )
        .route(
            "/api/v1/guilds/{guild_id}/bans/{user_id}",
            put(routes::bans::ban_member).delete(routes::bans::unban_member),
        )
        .route(
            "/api/v1/guilds/{guild_id}/roles",
            get(routes::roles::list_roles).post(routes::roles::create_role),
        )
        .route(
            "/api/v1/guilds/{guild_id}/roles/{role_id}",
            patch(routes::roles::update_role).delete(routes::roles::delete_role),
        )
        .route(
            "/api/v1/guilds/{guild_id}/invites",
            get(routes::invites::list_guild_invites),
        )
        .route(
            "/api/v1/guilds/{guild_id}/audit-logs",
            get(routes::audit_logs::get_audit_logs),
        )
        // Channels
        .route(
            "/api/v1/channels/{channel_id}",
            get(routes::channels::get_channel)
                .patch(routes::channels::update_channel)
                .delete(routes::channels::delete_channel),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages",
            get(routes::channels::get_messages).post(routes::channels::send_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages/search",
            get(routes::channels::search_messages),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages/bulk-delete",
            post(routes::channels::bulk_delete_messages),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages/{message_id}",
            patch(routes::channels::edit_message).delete(routes::channels::delete_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/pins",
            get(routes::channels::get_pins),
        )
        .route(
            "/api/v1/channels/{channel_id}/pins/{message_id}",
            put(routes::channels::pin_message).delete(routes::channels::unpin_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/typing",
            post(routes::channels::typing),
        )
        .route(
            "/api/v1/channels/{channel_id}/read",
            put(routes::channels::update_read_state),
        )
        .route(
            "/api/v1/channels/{channel_id}/overwrites",
            get(routes::channels::list_channel_overwrites),
        )
        .route(
            "/api/v1/channels/{channel_id}/overwrites/{target_id}",
            put(routes::channels::upsert_channel_overwrite)
                .delete(routes::channels::delete_channel_overwrite),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages/{message_id}/reactions/{emoji}/@me",
            put(routes::channels::add_reaction).delete(routes::channels::remove_reaction),
        )
        // Invites
        .route(
            "/api/v1/channels/{channel_id}/invites",
            post(routes::invites::create_invite),
        )
        .route(
            "/api/v1/invites/{code}",
            get(routes::invites::get_invite)
                .post(routes::invites::accept_invite)
                .delete(routes::invites::delete_invite),
        )
        // Voice
        .route(
            "/api/v1/voice/{channel_id}/join",
            get(routes::voice::join_voice),
        )
        .route(
            "/api/v1/voice/{channel_id}/stream",
            post(routes::voice::start_stream),
        )
        .route(
            "/api/v1/voice/{channel_id}/stream/stop",
            post(routes::voice::stop_stream),
        )
        .route(
            "/api/v1/voice/{channel_id}/leave",
            post(routes::voice::leave_voice),
        )
        .route(
            "/api/v1/voice/livekit/webhook",
            post(routes::voice::livekit_webhook),
        )
        // Files
        .route(
            "/api/v1/channels/{channel_id}/attachments",
            post(routes::files::upload_file),
        )
        .route(
            "/api/v1/attachments/{id}",
            get(routes::files::download_file).delete(routes::files::delete_file),
        )
        // Relationships
        .route(
            "/api/v1/users/@me/relationships",
            get(routes::relationships::list_relationships)
                .post(routes::relationships::add_friend),
        )
        .route(
            "/api/v1/users/@me/relationships/{user_id}",
            put(routes::relationships::accept_friend)
                .delete(routes::relationships::remove_relationship),
        )
        // Admin
        .route(
            "/api/v1/admin/stats",
            get(routes::admin::get_stats),
        )
        .route(
            "/api/v1/admin/settings",
            get(routes::admin::get_settings).patch(routes::admin::update_settings),
        )
        .route(
            "/api/v1/admin/users",
            get(routes::admin::list_users),
        )
        .route(
            "/api/v1/admin/users/{user_id}",
            patch(routes::admin::update_user).delete(routes::admin::delete_user),
        )
        .route(
            "/api/v1/admin/guilds",
            get(routes::admin::list_guilds),
        )
        .route(
            "/api/v1/admin/guilds/{guild_id}",
            patch(routes::admin::update_guild).delete(routes::admin::delete_guild),
        )
        .route(
            "/api/v1/admin/restart-update",
            post(routes::admin::restart_update),
        )
        // LiveKit reverse proxy (voice signaling + Twirp API on the same port)
        .route("/livekit/{*path}", any(routes::livekit_proxy::livekit_proxy))
        // Middleware layers
        .layer(cors)
        .layer(from_fn(rate_limit_middleware))
        .layer(tower_http::trace::TraceLayer::new_for_http())
}

fn build_cors_layer(allowed_origins: &[String], public_url: Option<&str>) -> tower_http::cors::CorsLayer {
    use tower_http::cors::{AllowOrigin, Any};

    let methods = [Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE];

    // Tauri desktop client origins that must always be allowed.
    const TAURI_ORIGINS: &[&str] = &["tauri://localhost", "http://tauri.localhost"];

    // Build the explicit origin list (if any).
    let mut origins: Vec<String> = allowed_origins.to_vec();

    // If no explicit origins but a public_url is set, derive from it.
    if origins.is_empty() {
        if let Some(url) = public_url {
            origins.push(url.trim_end_matches('/').to_string());
        }
    }

    if origins.is_empty() {
        // Development mode: no restrictions.
        tower_http::cors::CorsLayer::new()
            .allow_origin(Any)
            .allow_methods(methods)
            .allow_headers(Any)
    } else {
        // Production mode: explicit origin list + Tauri origins.
        for tauri in TAURI_ORIGINS {
            let s = (*tauri).to_string();
            if !origins.contains(&s) {
                origins.push(s);
            }
        }

        let header_list = vec![
            axum::http::header::AUTHORIZATION,
            axum::http::header::CONTENT_TYPE,
            axum::http::header::ACCEPT,
        ];

        let parsed: Vec<axum::http::HeaderValue> = origins
            .iter()
            .filter_map(|o| o.parse().ok())
            .collect();

        tower_http::cors::CorsLayer::new()
            .allow_origin(AllowOrigin::list(parsed))
            .allow_methods(methods)
            .allow_headers(header_list)
            .allow_credentials(true)
    }
}

async fn health() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({ "status": "ok", "service": "paracord" })),
    )
}

async fn metrics() -> impl IntoResponse {
    let requests = REQUEST_COUNT.load(Ordering::Relaxed);
    let limited = RATE_LIMITED_COUNT.load(Ordering::Relaxed);
    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        format!(
            "paracord_up 1\nparacord_http_requests_total {}\nparacord_http_rate_limited_total {}\n",
            requests, limited
        ),
    )
}

static RATE_LIMIT_STATE: OnceLock<Mutex<HashMap<String, (i64, u32)>>> = OnceLock::new();
static REQUEST_COUNT: AtomicU64 = AtomicU64::new(0);
static RATE_LIMITED_COUNT: AtomicU64 = AtomicU64::new(0);

fn rate_limit_state() -> &'static Mutex<HashMap<String, (i64, u32)>> {
    RATE_LIMIT_STATE.get_or_init(|| Mutex::new(HashMap::new()))
}

async fn rate_limit_middleware(req: Request, next: Next) -> Response {
    REQUEST_COUNT.fetch_add(1, Ordering::Relaxed);
    let now = chrono::Utc::now().timestamp();
    let key = req
        .headers()
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.split(',').next())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("local")
        .to_string();

    let allowed = {
        let mut map = match rate_limit_state().lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        let entry = map.entry(key).or_insert((now, 0));
        if entry.0 != now {
            *entry = (now, 0);
        }
        if entry.1 >= 300 {
            false
        } else {
            entry.1 += 1;
            true
        }
    };

    if !allowed {
        RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
        return crate::error::ApiError::RateLimited.into_response();
    }

    next.run(req).await
}
