#![allow(
    clippy::clone_on_copy,
    clippy::collapsible_if,
    clippy::collapsible_match,
    clippy::collapsible_str_replace,
    clippy::manual_contains,
    clippy::manual_is_multiple_of,
    clippy::manual_pattern_char_comparison,
    clippy::manual_range_contains,
    clippy::mut_mutex_lock,
    clippy::too_many_arguments,
    clippy::type_complexity,
    clippy::while_let_on_iterator
)]

use axum::{
    extract::{ConnectInfo, DefaultBodyLimit, Request},
    http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode},
    middleware::{from_fn, Next},
    response::IntoResponse,
    response::Response,
    routing::{any, delete, get, patch, post, put},
    Json, Router,
};
use dashmap::DashMap;
use paracord_core::{observability, AppState};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Notify;
use uuid::Uuid;

pub mod ai;
pub mod error;
pub mod middleware;
pub mod opengraph;
pub mod routes;

const DEFAULT_REQUEST_BODY_LIMIT_BYTES: usize = 2 * 1024 * 1024;
const ATTACHMENT_REQUEST_BODY_LIMIT_BYTES: usize = 64 * 1024 * 1024;
const TRACE_ID_HEADER: &str = "x-paracord-trace-id";
const ACCESS_COOKIE_NAME: &str = "paracord_access";
const CSRF_COOKIE_NAME: &str = "paracord_csrf";
const CSRF_HEADER_NAME: &str = "x-paracord-csrf";

pub fn build_router() -> Router<AppState> {
    let cors = build_cors_layer();
    Router::new()
        // Health
        .route("/health", get(health))
        .route("/api/v1/health", get(health))
        .route("/metrics", get(metrics))
        .route("/api/v1/metrics", get(metrics))
        .route("/api/docs", get(routes::docs::swagger_ui))
        .route("/api/docs/openapi.json", get(routes::docs::openapi_spec))
        // Realtime v2 (SSE + HTTP command bus)
        .route("/api/v2/rt/session", post(routes::realtime::create_session))
        .route("/api/v2/rt/events", get(routes::realtime::stream_events))
        .route("/api/v2/rt/commands", post(routes::realtime::post_command))
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
        .route(
            "/_paracord/federation/v1/events",
            get(routes::federation::list_events),
        )
        .route(
            "/_paracord/federation/v1/invite",
            post(routes::federation::invite),
        )
        .route(
            "/_paracord/federation/v1/join",
            post(routes::federation::join),
        )
        .route(
            "/_paracord/federation/v1/leave",
            post(routes::federation::leave),
        )
        .route(
            "/_paracord/federation/v1/media/token",
            post(routes::federation::media_token),
        )
        .route(
            "/_paracord/federation/v1/media/relay",
            post(routes::federation::media_relay),
        )
        .route(
            "/_paracord/federation/v1/file/token",
            post(routes::federation::file_token),
        )
        .route(
            "/_paracord/federation/v1/file/{attachment_id}",
            get(routes::federation::file_download),
        )
        // Federation server management (admin)
        .route(
            "/_paracord/federation/v1/servers",
            get(routes::federation::list_servers).post(routes::federation::add_server),
        )
        .route(
            "/_paracord/federation/v1/servers/{server_name}",
            get(routes::federation::get_server).delete(routes::federation::delete_server),
        )
        .route(
            "/_paracord/federation/v1/moderation/state",
            get(routes::federation::list_peer_trust_state),
        )
        .route(
            "/_paracord/federation/v1/moderation/apply",
            post(routes::federation::apply_moderation_list),
        )
        .route(
            "/_paracord/federation/v1/moderation/subscriptions",
            get(routes::federation::list_moderation_subscriptions)
                .post(routes::federation::upsert_moderation_subscription),
        )
        .route(
            "/_paracord/federation/v1/moderation/subscriptions/{subscription_id}",
            delete(routes::federation::delete_moderation_subscription),
        )
        // Auth
        .route("/api/v1/auth/register", post(routes::auth::register))
        .route("/api/v1/auth/login", post(routes::auth::login))
        .route("/api/v1/auth/options", get(routes::auth::auth_options))
        .route("/api/v1/auth/refresh", post(routes::auth::refresh))
        .route("/api/v1/auth/logout", post(routes::auth::logout))
        .route("/api/v1/auth/challenge", post(routes::auth::challenge))
        .route("/api/v1/auth/verify", post(routes::auth::verify))
        .route(
            "/api/v1/auth/attach-public-key",
            post(routes::auth::attach_public_key),
        )
        .route("/api/v1/auth/sessions", get(routes::auth::list_sessions))
        .route(
            "/api/v1/auth/sessions/{session_id}",
            delete(routes::auth::revoke_session),
        )
        .route(
            "/api/v1/auth/forgot-password",
            post(routes::auth::forgot_password),
        )
        .route(
            "/api/v1/auth/reset-password",
            post(routes::auth::reset_password),
        )
        .route(
            "/api/v1/auth/verify-email",
            post(routes::auth::verify_email),
        )
        .route("/api/v1/auth/mfa/setup", post(routes::auth::mfa_setup))
        .route("/api/v1/auth/mfa/verify", post(routes::auth::mfa_verify))
        .route("/api/v1/auth/mfa/disable", post(routes::auth::mfa_disable))
        .route("/api/v1/auth/mfa/status", get(routes::auth::mfa_status))
        .route("/api/v1/auth/mfa/login", post(routes::auth::mfa_login))
        // Users
        .route(
            "/api/v1/users/@me",
            get(routes::users::get_me)
                .patch(routes::users::update_me)
                .delete(routes::users::delete_me),
        )
        .route(
            "/api/v1/users/@me/settings",
            get(routes::users::get_settings).patch(routes::users::update_settings),
        )
        .route(
            "/api/v1/users/@me/password",
            put(routes::users::change_password),
        )
        .route("/api/v1/users/@me/email", put(routes::users::change_email))
        .route(
            "/api/v1/users/@me/data-export",
            get(routes::users::export_my_data),
        )
        .route(
            "/api/v1/users/@me/export",
            post(routes::users::export_identity),
        )
        .route(
            "/api/v1/users/@me/import",
            post(routes::users::import_identity),
        )
        .route(
            "/api/v1/users/{user_id}/profile",
            get(routes::users::get_user_profile),
        )
        .route("/api/v1/users/@me/guilds", get(routes::guilds::list_guilds))
        .route(
            "/api/v1/users/@me/dms",
            get(routes::dms::list_dms).post(routes::dms::create_dm),
        )
        .route(
            "/api/v1/users/@me/channels",
            post(routes::dms::create_group_dm),
        )
        .route(
            "/api/v1/channels/{channel_id}/recipients/{user_id}",
            put(routes::dms::add_group_dm_recipient).delete(routes::dms::remove_group_dm_recipient),
        )
        .route(
            "/api/v1/channels/{channel_id}/recipients",
            get(routes::dms::list_group_dm_recipients),
        )
        .route(
            "/api/v1/dms/{channel_id}/voice/join",
            post(routes::dms::join_dm_voice),
        )
        .route(
            "/api/v1/dms/{channel_id}/voice/leave",
            post(routes::dms::leave_dm_voice),
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
            get(routes::guilds::get_channels)
                .post(routes::channels::create_channel)
                .patch(routes::guilds::update_channel_positions),
        )
        .route(
            "/api/v1/guilds/{guild_id}/channels/visible",
            get(routes::channels::get_visible_channels),
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
            "/api/v1/guilds/{guild_id}/economy/me",
            get(routes::economy::get_my_progress),
        )
        .route(
            "/api/v1/guilds/{guild_id}/economy/leaderboard",
            get(routes::economy::get_leaderboard),
        )
        .route(
            "/api/v1/guilds/{guild_id}/economy/level-roles",
            get(routes::economy::list_level_roles).put(routes::economy::update_level_roles),
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
            "/api/v1/guilds/{guild_id}/emojis",
            get(routes::emojis::list_guild_emojis).post(routes::emojis::create_emoji),
        )
        .route(
            "/api/v1/guilds/{guild_id}/emojis/{emoji_id}",
            patch(routes::emojis::update_emoji).delete(routes::emojis::delete_emoji),
        )
        .route(
            "/api/v1/guilds/{guild_id}/emojis/{emoji_id}/image",
            get(routes::emojis::get_emoji_image),
        )
        .route(
            "/api/v1/guilds/{guild_id}/stickers",
            get(routes::stickers::list_guild_stickers).post(routes::stickers::create_sticker),
        )
        .route(
            "/api/v1/guilds/{guild_id}/stickers/{sticker_id}",
            delete(routes::stickers::delete_sticker),
        )
        .route(
            "/api/v1/guilds/{guild_id}/stickers/{sticker_id}/image",
            get(routes::stickers::get_sticker_image),
        )
        .route(
            "/api/v1/guilds/{guild_id}/webhooks",
            get(routes::webhooks::list_guild_webhooks).post(routes::webhooks::create_webhook),
        )
        .route(
            "/api/v1/guilds/{guild_id}/events",
            get(routes::events::list_events).post(routes::events::create_event),
        )
        .route(
            "/api/v1/guilds/{guild_id}/events.ics",
            get(routes::events::export_guild_ical),
        )
        .route(
            "/api/v1/guilds/{guild_id}/events/{event_id}",
            get(routes::events::get_event)
                .patch(routes::events::update_event)
                .delete(routes::events::delete_event),
        )
        .route(
            "/api/v1/guilds/{guild_id}/events/{event_id}/ical",
            get(routes::events::export_event_ical),
        )
        .route(
            "/api/v1/guilds/{guild_id}/events/{event_id}/rsvp",
            put(routes::events::add_rsvp).delete(routes::events::remove_rsvp),
        )
        .route(
            "/api/v1/guilds/{guild_id}/onboarding",
            get(routes::onboarding::get_guild_onboarding)
                .patch(routes::onboarding::update_guild_onboarding),
        )
        .route(
            "/api/v1/guilds/{guild_id}/onboarding/me",
            get(routes::onboarding::get_my_onboarding_state)
                .put(routes::onboarding::update_my_onboarding_state),
        )
        .route(
            "/api/v1/guilds/{guild_id}/bots",
            get(routes::bots::list_guild_bots),
        )
        .route(
            "/api/v1/guilds/{guild_id}/bots/{bot_app_id}",
            delete(routes::bots::remove_guild_bot),
        )
        .route(
            "/api/v1/guilds/{guild_id}/storage",
            get(routes::guilds::get_storage).patch(routes::guilds::update_storage),
        )
        .route(
            "/api/v1/guilds/{guild_id}/files",
            get(routes::guilds::list_files).delete(routes::guilds::delete_files),
        )
        .route(
            "/api/v1/guilds/{guild_id}/vanity-url",
            get(routes::guilds::get_vanity_url).patch(routes::guilds::update_vanity_url),
        )
        .route(
            "/api/v1/guilds/{guild_id}/audit-logs",
            get(routes::audit_logs::get_audit_logs),
        )
        .route(
            "/api/v1/guilds/{guild_id}/reports",
            get(routes::reports::list_reports).post(routes::reports::create_report),
        )
        .route(
            "/api/v1/guilds/{guild_id}/reports/{report_id}",
            patch(routes::reports::resolve_report),
        )
        .route(
            "/api/v1/guilds/{guild_id}/moderation/templates",
            get(routes::moderation_templates::list_templates)
                .post(routes::moderation_templates::create_template),
        )
        .route(
            "/api/v1/guilds/{guild_id}/moderation/templates/{template_id}",
            delete(routes::moderation_templates::delete_template),
        )
        .route(
            "/api/v1/guilds/{guild_id}/moderation/templates/{template_id}/apply",
            post(routes::moderation_templates::apply_template),
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
            "/api/v1/channels/{channel_id}/summary",
            get(routes::channels::summarize_channel),
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
            "/api/v1/channels/{channel_id}/features",
            get(routes::message_features::get_channel_feature_settings)
                .patch(routes::message_features::update_channel_feature_settings),
        )
        .route(
            "/api/v1/channels/{channel_id}/scheduled-messages",
            get(routes::message_features::list_scheduled_messages)
                .post(routes::message_features::create_scheduled_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/scheduled-messages/{scheduled_message_id}",
            delete(routes::message_features::delete_scheduled_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/anonymous/deanonymize/{message_id}",
            get(routes::message_features::deanonymize_message),
        )
        .route(
            "/api/v1/channels/{channel_id}/e2ee/sender-keys",
            post(routes::message_features::post_group_sender_keys)
                .get(routes::message_features::get_group_sender_keys),
        )
        .route(
            "/api/v1/channels/{channel_id}/e2ee/sender-keys/ack",
            post(routes::message_features::ack_group_sender_keys),
        )
        .route(
            "/api/v1/channels/{channel_id}/messages/{message_id}/edits",
            get(routes::channels::get_edit_history),
        )
        .route(
            "/api/v1/channels/{channel_id}/polls",
            post(routes::channels::create_poll),
        )
        .route(
            "/api/v1/channels/{channel_id}/polls/{poll_id}",
            get(routes::channels::get_poll),
        )
        .route(
            "/api/v1/channels/{channel_id}/polls/{poll_id}/votes/{option_id}",
            put(routes::channels::add_poll_vote).delete(routes::channels::remove_poll_vote),
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
        .route(
            "/api/v1/channels/{channel_id}/webhooks",
            get(routes::webhooks::list_channel_webhooks),
        )
        // Threads
        .route(
            "/api/v1/channels/{channel_id}/threads",
            post(routes::channels::create_thread).get(routes::channels::get_threads),
        )
        .route(
            "/api/v1/channels/{channel_id}/threads/archived",
            get(routes::channels::get_archived_threads),
        )
        .route(
            "/api/v1/channels/{channel_id}/threads/{thread_id}",
            patch(routes::channels::update_thread).delete(routes::channels::delete_thread),
        )
        .route(
            "/api/v1/channels/{channel_id}/forum/posts",
            get(routes::channels::get_forum_posts).post(routes::channels::create_forum_post),
        )
        .route(
            "/api/v1/channels/{channel_id}/forum/tags",
            get(routes::channels::list_forum_tags).post(routes::channels::create_forum_tag),
        )
        .route(
            "/api/v1/channels/{channel_id}/forum/tags/{tag_id}",
            delete(routes::channels::delete_forum_tag),
        )
        .route(
            "/api/v1/channels/{channel_id}/forum/sort",
            patch(routes::channels::update_forum_sort_order),
        )
        // Channel follows (announcement channels)
        .route(
            "/api/v1/channels/{channel_id}/followers",
            get(routes::channels::list_channel_follows).post(routes::channels::add_channel_follow),
        )
        .route(
            "/api/v1/channels/{channel_id}/followers/{target_channel_id}",
            delete(routes::channels::remove_channel_follow),
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
        .route(
            "/api/v1/webhooks/{webhook_id}",
            get(routes::webhooks::get_webhook)
                .patch(routes::webhooks::update_webhook)
                .delete(routes::webhooks::delete_webhook),
        )
        .route(
            "/api/v1/webhooks/{webhook_id}/{token}",
            post(routes::webhooks::execute_webhook),
        )
        .route(
            "/api/v1/webhooks/{webhook_id}/{token}/messages/{message_id}",
            patch(routes::webhooks::edit_webhook_message)
                .delete(routes::webhooks::delete_webhook_message),
        )
        .route(
            "/api/v1/discovery/guilds",
            get(routes::discovery::list_discoverable_guilds),
        )
        // Guild templates
        .route(
            "/api/v1/guilds/{guild_id}/template",
            post(routes::templates::create_template_from_guild),
        )
        .route("/api/v1/templates", get(routes::templates::list_templates))
        .route(
            "/api/v1/templates/{template_id}/apply",
            post(routes::templates::apply_template),
        )
        .route(
            "/api/v1/templates/{template_id}",
            delete(routes::templates::delete_template),
        )
        .route(
            "/api/v1/bots/applications",
            get(routes::bots::list_bot_applications).post(routes::bots::create_bot_application),
        )
        .route(
            "/api/v1/bots/applications/{bot_app_id}",
            get(routes::bots::get_bot_application)
                .patch(routes::bots::update_bot_application)
                .delete(routes::bots::delete_bot_application),
        )
        .route(
            "/api/v1/bots/applications/{bot_app_id}/public",
            get(routes::bots::get_public_bot_application),
        )
        .route(
            "/api/v1/bots/applications/{bot_app_id}/token",
            post(routes::bots::regenerate_bot_token),
        )
        .route(
            "/api/v1/bots/applications/{bot_app_id}/installs",
            get(routes::bots::list_bot_application_installs),
        )
        .route(
            "/api/v1/bots/applications/{bot_app_id}/metrics",
            get(routes::bots::get_bot_application_metrics),
        )
        // Application command management
        .route(
            "/api/v1/applications/{app_id}/commands",
            get(routes::commands::list_global_commands)
                .post(routes::commands::create_global_command)
                .put(routes::commands::bulk_overwrite_global_commands),
        )
        .route(
            "/api/v1/applications/{app_id}/commands/{cmd_id}",
            get(routes::commands::get_global_command)
                .patch(routes::commands::update_global_command)
                .delete(routes::commands::delete_global_command),
        )
        .route(
            "/api/v1/applications/{app_id}/guilds/{guild_id}/commands",
            get(routes::commands::list_guild_commands)
                .post(routes::commands::create_guild_command)
                .put(routes::commands::bulk_overwrite_guild_commands),
        )
        .route(
            "/api/v1/applications/{app_id}/guilds/{guild_id}/commands/{cmd_id}",
            get(routes::commands::get_guild_command)
                .patch(routes::commands::update_guild_command)
                .delete(routes::commands::delete_guild_command),
        )
        .route(
            "/api/v1/guilds/{guild_id}/commands",
            get(routes::commands::list_guild_available_commands_handler),
        )
        // Interaction lifecycle
        .route(
            "/api/v1/interactions",
            post(routes::interactions::invoke_interaction),
        )
        .route(
            "/api/v1/interactions/{interaction_id}/{token}/callback",
            post(routes::interactions::interaction_callback),
        )
        .route(
            "/api/v1/interactions/{app_id}/{token}/messages/@original",
            patch(routes::interactions::edit_original_response)
                .delete(routes::interactions::delete_original_response),
        )
        .route(
            "/api/v1/interactions/{app_id}/{token}/followup",
            post(routes::interactions::create_followup_message),
        )
        .route(
            "/api/v1/oauth2/authorize",
            post(routes::bots::oauth2_authorize),
        )
        // Bot presence
        .route(
            "/api/v1/bots/@me/presence",
            patch(routes::bots::update_bot_presence),
        )
        // Tenor GIF proxy
        .route("/api/v1/tenor/search", get(routes::tenor::search))
        .route("/api/v1/tenor/trending", get(routes::tenor::trending))
        // Bot store (public discovery)
        .route("/api/v1/bots/store", get(routes::bots::store_search))
        .route(
            "/api/v1/bots/store/featured",
            get(routes::bots::store_featured),
        )
        .route(
            "/api/v1/bots/store/categories",
            get(routes::bots::store_categories),
        )
        .route(
            "/api/v1/bots/store/{bot_app_id}/reviews",
            get(routes::bots::list_store_bot_reviews),
        )
        .route(
            "/api/v1/bots/store/{bot_app_id}/reviews/@me",
            put(routes::bots::upsert_store_bot_review),
        )
        // Signal prekey management
        .route("/api/v1/users/@me/keys", put(routes::keys::upload_keys))
        .route(
            "/api/v1/users/@me/keys/count",
            get(routes::keys::get_key_count),
        )
        .route("/api/v1/users/{user_id}/keys", get(routes::keys::get_keys))
        .route(
            "/api/v1/channels/{channel_id}/stage-instance",
            get(routes::stage::get_stage_instance_for_channel),
        )
        // Stage Instances
        .route(
            "/api/v1/stage-instances",
            post(routes::stage::create_stage_instance),
        )
        .route(
            "/api/v1/stage-instances/{stage_id}",
            patch(routes::stage::update_stage_instance)
                .delete(routes::stage::delete_stage_instance),
        )
        .route(
            "/api/v1/stage-instances/{stage_id}/speakers/{user_id}",
            post(routes::stage::invite_speaker).delete(routes::stage::remove_speaker),
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
        .route(
            "/api/v2/voice/{channel_id}/join",
            post(routes::voice_v2::join_voice_v2),
        )
        .route(
            "/api/v2/voice/{channel_id}/leave",
            post(routes::voice_v2::leave_voice_v2),
        )
        .route(
            "/api/v2/voice/state",
            post(routes::voice_v2::update_voice_state_v2),
        )
        .route(
            "/api/v2/voice/recover",
            post(routes::voice_v2::recover_voice_v2),
        )
        // Files
        .route(
            "/api/v1/channels/{channel_id}/attachments",
            post(routes::files::upload_file)
                .layer(DefaultBodyLimit::max(ATTACHMENT_REQUEST_BODY_LIMIT_BYTES)),
        )
        .route(
            "/api/v1/attachments/{id}",
            get(routes::files::download_file).delete(routes::files::delete_file),
        )
        // QUIC file transfer pre-authorization
        .route(
            "/api/v2/channels/{channel_id}/upload-token",
            post(routes::files::upload_token),
        )
        // Federated file proxy
        .route(
            "/api/v1/federated-files/{origin_server}/{attachment_id}",
            get(routes::files::download_federated_file),
        )
        // Relationships
        .route(
            "/api/v1/users/@me/relationships",
            get(routes::relationships::list_relationships).post(routes::relationships::add_friend),
        )
        .route(
            "/api/v1/users/@me/relationships/{user_id}",
            put(routes::relationships::accept_friend)
                .delete(routes::relationships::remove_relationship),
        )
        // Admin
        .route("/api/v1/admin/stats", get(routes::admin::get_stats))
        .route(
            "/api/v1/admin/security-events",
            get(routes::admin::list_security_events),
        )
        .route(
            "/api/v1/admin/settings",
            get(routes::admin::get_settings).patch(routes::admin::update_settings),
        )
        .route("/api/v1/admin/users", get(routes::admin::list_users))
        .route(
            "/api/v1/admin/users/{user_id}",
            patch(routes::admin::update_user).delete(routes::admin::delete_user),
        )
        .route("/api/v1/admin/guilds", get(routes::admin::list_guilds))
        .route(
            "/api/v1/admin/guilds/{guild_id}",
            patch(routes::admin::update_guild).delete(routes::admin::delete_guild),
        )
        .route(
            "/api/v1/admin/restart-update",
            post(routes::admin::restart_update),
        )
        // Admin backups
        .route("/api/v1/admin/backup", post(routes::admin::create_backup))
        .route("/api/v1/admin/backups", get(routes::admin::list_backups))
        .route("/api/v1/admin/restore", post(routes::admin::restore_backup))
        .route(
            "/api/v1/admin/backups/{name}",
            get(routes::admin::download_backup).delete(routes::admin::delete_backup),
        )
        // LiveKit reverse proxy (voice signaling + Twirp API on the same port)
        .route(
            "/livekit/{*path}",
            any(routes::livekit_proxy::livekit_proxy),
        )
        // Middleware layers
        .layer(DefaultBodyLimit::max(DEFAULT_REQUEST_BODY_LIMIT_BYTES))
        .layer(from_fn(metrics_middleware))
        .layer(from_fn(rate_limit_middleware))
        .layer(from_fn(csrf_middleware))
        .layer(from_fn(security_headers_middleware))
        .layer(cors)
        .layer(
            tower_http::trace::TraceLayer::new_for_http()
                .make_span_with(|request: &Request| {
                    let req_id = HTTP_TRACE_REQUEST_ID
                        .fetch_add(1, Ordering::Relaxed)
                        .saturating_add(1);
                    let matched_path = request
                        .extensions()
                        .get::<axum::extract::MatchedPath>()
                        .map(axum::extract::MatchedPath::as_str)
                        .unwrap_or_else(|| request.uri().path());
                    tracing::info_span!(
                        "http",
                        req_id,
                        method = %request.method(),
                        path = %matched_path
                    )
                })
                .on_request(|request: &Request, _span: &tracing::Span| {
                    if observability::wire_trace_enabled() {
                        let request_bytes = request
                            .headers()
                            .get(header::CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok());
                        let content_type = request
                            .headers()
                            .get(header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok());
                        tracing::info!(
                            target: "wire",
                            kind = "http_request_in",
                            request_bytes,
                            content_type,
                            query = request.uri().query(),
                            "server_in"
                        );
                    }
                })
                .on_response(
                    |response: &Response, latency: Duration, _span: &tracing::Span| {
                        let status = response.status();
                        let latency_ms = latency.as_millis();
                        let response_bytes = response
                            .headers()
                            .get(header::CONTENT_LENGTH)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|v| v.parse::<u64>().ok());
                        let response_content_type = response
                            .headers()
                            .get(header::CONTENT_TYPE)
                            .and_then(|v| v.to_str().ok());
                        if observability::wire_trace_enabled() {
                            tracing::info!(
                                target: "wire",
                                kind = "http_response_out",
                                status = %status.as_u16(),
                                latency_ms,
                                response_bytes,
                                response_content_type,
                                "server_out"
                            );
                        }
                        if status.is_server_error() {
                            tracing::error!(status = %status.as_u16(), latency_ms, "request");
                        } else if status.is_client_error() {
                            tracing::warn!(status = %status.as_u16(), latency_ms, "request");
                        } else {
                            tracing::info!(status = %status.as_u16(), latency_ms, "request");
                        }
                    },
                ),
        )
        .layer(from_fn(request_trace_middleware))
}

fn build_cors_layer() -> tower_http::cors::CorsLayer {
    let mut allowed_origins: std::collections::BTreeSet<String> = [
        "tauri://localhost",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "http://localhost:1420",
        "http://127.0.0.1:1420",
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ]
    .into_iter()
    .map(str::to_string)
    .collect();

    if let Ok(public_url) = std::env::var("PARACORD_PUBLIC_URL") {
        let trimmed = public_url.trim();
        if !trimmed.is_empty() {
            allowed_origins.insert(trimmed.to_string());
        }
    }
    if let Ok(raw) = std::env::var("PARACORD_CORS_ALLOWED_ORIGINS") {
        for origin in raw.split(',').map(str::trim).filter(|v| !v.is_empty()) {
            allowed_origins.insert(origin.to_string());
        }
    }

    let allow_any = allowed_origins.contains("*");
    let mut cors = tower_http::cors::CorsLayer::new()
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::ACCEPT,
            header::ORIGIN,
        ])
        .max_age(Duration::from_secs(600));

    if allow_any {
        tracing::warn!(
            "PARACORD_CORS_ALLOWED_ORIGINS contains '*'; disabling credentialed CORS for safety"
        );
        cors = cors
            .allow_origin(tower_http::cors::Any)
            .allow_credentials(false);
    } else {
        let values: Vec<HeaderValue> = allowed_origins
            .into_iter()
            .filter_map(|origin| HeaderValue::from_str(&origin).ok())
            .collect();
        cors = cors.allow_origin(values).allow_credentials(true);
    }

    cors
}

async fn health() -> impl IntoResponse {
    (
        StatusCode::OK,
        Json(json!({ "status": "ok", "service": "paracord" })),
    )
}

async fn metrics(headers: HeaderMap) -> impl IntoResponse {
    let public_metrics = std::env::var("PARACORD_ENABLE_PUBLIC_METRICS")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);
    if !public_metrics {
        let expected = std::env::var("PARACORD_METRICS_TOKEN")
            .ok()
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let Some(expected) = expected else {
            return (
                StatusCode::FORBIDDEN,
                [("content-type", "text/plain; charset=utf-8")],
                "metrics disabled".to_string(),
            );
        };

        let presented = headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.strip_prefix("Bearer "))
            .map(str::trim);
        if presented != Some(expected.as_str()) {
            return (
                StatusCode::UNAUTHORIZED,
                [("content-type", "text/plain; charset=utf-8")],
                "unauthorized".to_string(),
            );
        }
    }

    let requests = REQUEST_COUNT.load(Ordering::Relaxed);
    let limited = RATE_LIMITED_COUNT.load(Ordering::Relaxed);

    let s2xx = STATUS_2XX.load(Ordering::Relaxed);
    let s4xx = STATUS_4XX.load(Ordering::Relaxed);
    let s5xx = STATUS_5XX.load(Ordering::Relaxed);

    let ws_snapshot = paracord_core::observability::ws_metrics_snapshot();
    let ws_active = ws_snapshot.active_connections;
    let ws_events = ws_snapshot.total_events;

    let dur_sum_us = DURATION_SUM_US.load(Ordering::Relaxed);
    let dur_count = DURATION_COUNT.load(Ordering::Relaxed);
    let dur_sum_s = dur_sum_us as f64 / 1_000_000.0;

    let mut body = format!(
        "# HELP paracord_up Whether the server is up.\n\
         # TYPE paracord_up gauge\n\
         paracord_up 1\n\
         # HELP paracord_http_requests_total Total HTTP requests.\n\
         # TYPE paracord_http_requests_total counter\n\
         paracord_http_requests_total {requests}\n\
         # HELP paracord_http_rate_limited_total Requests rejected by rate limiter.\n\
         # TYPE paracord_http_rate_limited_total counter\n\
         paracord_http_rate_limited_total {limited}\n\
         # HELP paracord_http_responses_total HTTP responses by status class.\n\
         # TYPE paracord_http_responses_total counter\n\
         paracord_http_responses_total{{status_class=\"2xx\"}} {s2xx}\n\
         paracord_http_responses_total{{status_class=\"4xx\"}} {s4xx}\n\
         paracord_http_responses_total{{status_class=\"5xx\"}} {s5xx}\n\
         # HELP paracord_http_request_duration_seconds HTTP request duration histogram.\n\
         # TYPE paracord_http_request_duration_seconds histogram\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.005\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.01\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.025\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.05\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.1\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.25\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"0.5\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"1.0\"}} {}\n\
         paracord_http_request_duration_seconds_bucket{{le=\"+Inf\"}} {}\n\
         paracord_http_request_duration_seconds_sum {dur_sum_s}\n\
         paracord_http_request_duration_seconds_count {dur_count}\n\
         # HELP paracord_ws_connections_active Active WebSocket gateway connections.\n\
         # TYPE paracord_ws_connections_active gauge\n\
         paracord_ws_connections_active {ws_active}\n\
         # HELP paracord_ws_events_total Total WebSocket events dispatched.\n\
         # TYPE paracord_ws_events_total counter\n\
         paracord_ws_events_total {ws_events}\n\
         # HELP paracord_ws_events_by_type_total Total WebSocket events dispatched by event type.\n\
         # TYPE paracord_ws_events_by_type_total counter\n",
        DURATION_LE_5.load(Ordering::Relaxed),
        DURATION_LE_10.load(Ordering::Relaxed),
        DURATION_LE_25.load(Ordering::Relaxed),
        DURATION_LE_50.load(Ordering::Relaxed),
        DURATION_LE_100.load(Ordering::Relaxed),
        DURATION_LE_250.load(Ordering::Relaxed),
        DURATION_LE_500.load(Ordering::Relaxed),
        DURATION_LE_1000.load(Ordering::Relaxed),
        DURATION_LE_INF.load(Ordering::Relaxed),
    );
    for (event_type, count) in ws_snapshot.events_by_type {
        body.push_str(&format!(
            "paracord_ws_events_by_type_total{{event_type=\"{}\"}} {}\n",
            prometheus_escape_label_value(&event_type),
            count
        ));
    }

    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4")],
        body,
    )
}

struct RateBucket {
    count: u32,
    window_start: i64,
}

pub struct HttpRateLimiter {
    buckets: DashMap<String, Mutex<RateBucket>>,
}

impl HttpRateLimiter {
    fn new() -> Self {
        Self {
            buckets: DashMap::new(),
        }
    }

    /// Returns `None` if the request is allowed, or `Some(retry_after_seconds)` if rate-limited.
    fn check_rate_limit(&self, key: &str, window_seconds: i64, max_count: u32) -> Option<i64> {
        let now = chrono::Utc::now().timestamp();
        let bucket = self.buckets.entry(key.to_string()).or_insert_with(|| {
            Mutex::new(RateBucket {
                count: 0,
                window_start: now,
            })
        });
        let mut guard = match bucket.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if now.saturating_sub(guard.window_start) >= window_seconds {
            guard.window_start = now;
            guard.count = 0;
        }
        guard.count = guard.count.saturating_add(1);
        if guard.count <= max_count {
            None
        } else {
            // Time remaining until the current window resets
            let elapsed = now.saturating_sub(guard.window_start);
            let retry_after = (window_seconds - elapsed).max(1);
            Some(retry_after)
        }
    }

    fn cleanup_stale(&self, max_age_seconds: i64) {
        let now = chrono::Utc::now().timestamp();
        self.buckets.retain(|_, bucket| {
            let guard = match bucket.lock() {
                Ok(guard) => guard,
                Err(poisoned) => poisoned.into_inner(),
            };
            now.saturating_sub(guard.window_start) <= max_age_seconds
        });
    }
}

static HTTP_RATE_LIMITER: OnceLock<HttpRateLimiter> = OnceLock::new();
static HTTP_TRACE_REQUEST_ID: AtomicU64 = AtomicU64::new(0);
static REQUEST_COUNT: AtomicU64 = AtomicU64::new(0);
static RATE_LIMITED_COUNT: AtomicU64 = AtomicU64::new(0);

// ── Observability: request duration histogram buckets ──────────────────────
// We track durations in discrete buckets (in milliseconds) using atomics.
static DURATION_LE_5: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_10: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_25: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_50: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_100: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_250: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_500: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_1000: AtomicU64 = AtomicU64::new(0);
static DURATION_LE_INF: AtomicU64 = AtomicU64::new(0);
static DURATION_SUM_US: AtomicU64 = AtomicU64::new(0);
static DURATION_COUNT: AtomicU64 = AtomicU64::new(0);

// ── Observability: HTTP status code counters ───────────────────────────────
static STATUS_2XX: AtomicU64 = AtomicU64::new(0);
static STATUS_4XX: AtomicU64 = AtomicU64::new(0);
static STATUS_5XX: AtomicU64 = AtomicU64::new(0);
static HTTP_SLOW_REQUEST_THRESHOLD_MS: OnceLock<u64> = OnceLock::new();

fn slow_request_threshold_ms() -> u64 {
    *HTTP_SLOW_REQUEST_THRESHOLD_MS.get_or_init(|| {
        std::env::var("PARACORD_HTTP_SLOW_MS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .filter(|v| *v > 0)
            .unwrap_or(500)
    })
}

fn prometheus_escape_label_value(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            _ => escaped.push(ch),
        }
    }
    escaped
}

fn record_request_duration(elapsed_ms: u64) {
    if elapsed_ms <= 5 {
        DURATION_LE_5.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 10 {
        DURATION_LE_10.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 25 {
        DURATION_LE_25.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 50 {
        DURATION_LE_50.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 100 {
        DURATION_LE_100.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 250 {
        DURATION_LE_250.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 500 {
        DURATION_LE_500.fetch_add(1, Ordering::Relaxed);
    }
    if elapsed_ms <= 1000 {
        DURATION_LE_1000.fetch_add(1, Ordering::Relaxed);
    }
    DURATION_LE_INF.fetch_add(1, Ordering::Relaxed);
    DURATION_SUM_US.fetch_add(elapsed_ms.saturating_mul(1000), Ordering::Relaxed);
    DURATION_COUNT.fetch_add(1, Ordering::Relaxed);
}

fn record_status_code(status: u16) {
    match status {
        200..=299 => {
            STATUS_2XX.fetch_add(1, Ordering::Relaxed);
        }
        400..=499 => {
            STATUS_4XX.fetch_add(1, Ordering::Relaxed);
        }
        500..=599 => {
            STATUS_5XX.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
}

pub fn install_http_rate_limiter() {
    let _ = HTTP_RATE_LIMITER.set(HttpRateLimiter::new());
}

pub fn spawn_http_rate_limiter_cleanup(shutdown: Arc<Notify>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(60));
        loop {
            tokio::select! {
                _ = shutdown.notified() => break,
                _ = ticker.tick() => {
                    if let Some(limiter) = HTTP_RATE_LIMITER.get() {
                        limiter.cleanup_stale(600);
                    }
                }
            }
        }
    });
}

async fn rate_limit_middleware(req: Request, next: Next) -> Response {
    const GLOBAL_LIMIT_PER_SECOND: u32 = 120;
    const AUTH_LIMIT_PER_MINUTE: u32 = 60;
    const BOT_LIMIT_PER_MINUTE: u32 = 300;
    const BOT_WRITE_LIMIT_PER_SECOND: u32 = 5;

    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    let path = req.uri().path().to_string();
    if path == "/livekit" || path.starts_with("/livekit/") {
        // LiveKit signaling is authenticated by its own token and is highly
        // latency-sensitive. Keeping it out of the DB-backed HTTP rate limiter
        // avoids intermittent join stalls under database contention.
        return next.run(req).await;
    }

    REQUEST_COUNT.fetch_add(1, Ordering::Relaxed);
    let method = req.method().clone();
    let is_auth_path = path.starts_with("/api/v1/auth/");
    let is_write_method = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    let trust_proxy = std::env::var("PARACORD_TRUST_PROXY")
        .ok()
        .map(|v| v.eq_ignore_ascii_case("true") || v == "1")
        .unwrap_or(false);
    let peer_ip = req
        .extensions()
        .get::<ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip().to_string());
    let trusted_proxy_ips = if trust_proxy {
        std::env::var("PARACORD_TRUSTED_PROXY_IPS")
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let can_trust_forwarded = trust_proxy
        && peer_ip
            .as_deref()
            .is_some_and(|ip| trusted_proxy_ips.iter().any(|trusted| trusted == ip));

    let key = if can_trust_forwarded {
        req.headers()
            .get("x-forwarded-for")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.split(',').next())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or_else(|| peer_ip.clone())
            .unwrap_or_else(|| "unknown".to_string())
    } else {
        peer_ip.unwrap_or_else(|| "unknown".to_string())
    };

    if let Some(limiter) = HTTP_RATE_LIMITER.get() {
        let global_key = format!("http:global:{key}");
        if let Some(retry_after) = limiter.check_rate_limit(&global_key, 1, GLOBAL_LIMIT_PER_SECOND)
        {
            RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
            return crate::error::ApiError::RateLimited(retry_after).into_response();
        }

        if let Some(bot_token) = req
            .headers()
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|raw| raw.strip_prefix("Bot "))
            .map(str::trim)
            .filter(|token| !token.is_empty())
        {
            let token_hash = paracord_db::bot_applications::hash_token(bot_token);
            let bot_key = format!("http:bot:{}", &token_hash[..24]);
            if let Some(retry_after) = limiter.check_rate_limit(&bot_key, 60, BOT_LIMIT_PER_MINUTE)
            {
                RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
                return crate::error::ApiError::RateLimited(retry_after).into_response();
            }

            // Stricter limit for write operations (POST/PUT/PATCH/DELETE)
            if is_write_method {
                let bot_write_key = format!("http:bot:write:{}", &token_hash[..24]);
                if let Some(retry_after) =
                    limiter.check_rate_limit(&bot_write_key, 1, BOT_WRITE_LIMIT_PER_SECOND)
                {
                    RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
                    return crate::error::ApiError::RateLimited(retry_after).into_response();
                }
            }
        }

        if is_auth_path {
            let auth_key = format!("http:auth:{key}");
            if let Some(retry_after) =
                limiter.check_rate_limit(&auth_key, 60, AUTH_LIMIT_PER_MINUTE)
            {
                RATE_LIMITED_COUNT.fetch_add(1, Ordering::Relaxed);
                return crate::error::ApiError::RateLimited(retry_after).into_response();
            }
        }
    }

    next.run(req).await
}

fn get_cookie_value(headers: &HeaderMap, cookie_name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        let trimmed = part.trim();
        let Some((name, value)) = trimmed.split_once('=') else {
            continue;
        };
        if name == cookie_name {
            return Some(value.to_string());
        }
    }
    None
}

fn has_header_auth(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .map(|raw| raw.starts_with("Bearer ") || raw.starts_with("Bot "))
        .unwrap_or(false)
}

fn requires_csrf_check(method: &Method, path: &str) -> bool {
    (method == Method::POST
        || method == Method::PUT
        || method == Method::PATCH
        || method == Method::DELETE)
        && path.starts_with("/api/")
}

async fn csrf_middleware(req: Request, next: Next) -> Response {
    if !requires_csrf_check(req.method(), req.uri().path()) {
        return next.run(req).await;
    }

    if has_header_auth(req.headers()) {
        // Bearer/Bot auth is not ambient and not CSRF-prone.
        return next.run(req).await;
    }

    let has_access_cookie = get_cookie_value(req.headers(), ACCESS_COOKIE_NAME)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    if !has_access_cookie {
        // Unauthenticated or token body-based requests don't use ambient auth cookies.
        return next.run(req).await;
    }

    let csrf_cookie = get_cookie_value(req.headers(), CSRF_COOKIE_NAME)
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());
    let csrf_header = req
        .headers()
        .get(CSRF_HEADER_NAME)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string);

    if csrf_cookie.is_none() || csrf_header.is_none() || csrf_cookie != csrf_header {
        return crate::error::ApiError::Forbidden.into_response();
    }

    next.run(req).await
}

async fn security_headers_middleware(req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let is_https = req
        .headers()
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("https"))
        .unwrap_or(false);

    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(header::X_FRAME_OPTIONS, HeaderValue::from_static("DENY"));
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-opener-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    if path == "/health"
        || path == "/metrics"
        || path.starts_with("/api/")
        || path.starts_with("/_paracord/")
        || path.starts_with("/.well-known/")
    {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static("default-src 'none'; frame-ancestors 'none'; base-uri 'none'"),
        );
    } else {
        headers.insert(
            header::CONTENT_SECURITY_POLICY,
            HeaderValue::from_static(
                "default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob: https: http:; connect-src 'self' ws: wss:; media-src 'self' data: blob: https: http:",
            ),
        );
    }
    if is_https {
        headers.insert(
            header::STRICT_TRANSPORT_SECURITY,
            HeaderValue::from_static("max-age=31536000; includeSubDomains"),
        );
    }

    response
}

/// Middleware that records request duration and response status for the /metrics endpoint.
async fn metrics_middleware(req: Request, next: Next) -> Response {
    let start = Instant::now();
    let response = next.run(req).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    record_request_duration(elapsed_ms);
    record_status_code(response.status().as_u16());
    response
}

async fn request_trace_middleware(mut req: Request, next: Next) -> Response {
    let request_started = Instant::now();
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let trace_id = Uuid::new_v4().to_string();
    let trace_header = HeaderValue::from_str(&trace_id).ok();
    if let Some(value) = trace_header.clone() {
        req.headers_mut()
            .insert(HeaderName::from_static(TRACE_ID_HEADER), value);
    }

    let mut response = next.run(req).await;
    let elapsed_ms = request_started.elapsed().as_millis() as u64;

    if let Some(value) = trace_header {
        response
            .headers_mut()
            .insert(HeaderName::from_static(TRACE_ID_HEADER), value);
    }

    let slow_threshold_ms = slow_request_threshold_ms();
    if elapsed_ms >= slow_threshold_ms {
        tracing::warn!(
            target: "perf",
            trace_id = %trace_id,
            method = %method,
            path = %path,
            status = %response.status().as_u16(),
            latency_ms = elapsed_ms,
            slow_threshold_ms,
            "slow_http_request"
        );
    }

    response
}
