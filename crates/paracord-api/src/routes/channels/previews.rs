//! `GET /api/v1/guilds/{guild_id}/channel-previews`: the newest message of
//! every channel the viewer can read in a guild, for the channel rows of the
//! places panel (docs/glass-spec.md §3.1, docs/design/glass-plan.md §3).
//!
//! Unread and mention state is not repeated here: it already comes from the
//! read states (`GET /users/@me/read-states`). A channel with no messages, or
//! one the viewer cannot read, has no entry.

use paracord_contracts::channel::{ChannelPreview, ChannelPreviewAuthorKind, ChannelPreviewMedia};
use paracord_db::channel_previews::ChannelPreviewRow;

use super::*;

/// Channel types whose rows carry a message preview: text, voice (its text
/// chat), announcement and stage. Categories and forums hold no messages of
/// their own, and threads are not rows of the places panel.
const PREVIEW_CHANNEL_TYPES: [i16; 4] = [0, 2, 5, 13];

/// The longest `content`, in characters, including the `…` of a cut.
pub const PREVIEW_MAX_CHARS: usize = 140;

/// How far back from a cut a `<…>` token (mention, channel link, custom emoji,
/// timestamp) may start and still be dropped whole rather than split.
const MAX_TOKEN_CHARS: usize = 64;

/// Collapse whitespace runs to single spaces and cut to [`PREVIEW_MAX_CHARS`].
/// Returns the text (None when there is none) and whether it was cut.
///
/// A cut never ends inside a `<@…>`, `<#…>`, `<:…>`, `<a:…>` or `<t:…>`
/// token: the half-token is dropped, so the client never renders `<@12`.
pub(crate) fn preview_text(raw: Option<&str>) -> (Option<String>, bool) {
    let Some(raw) = raw else {
        return (None, false);
    };
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return (None, false);
    }
    if collapsed.chars().count() <= PREVIEW_MAX_CHARS {
        return (Some(collapsed), false);
    }
    let mut cut: String = collapsed.chars().take(PREVIEW_MAX_CHARS - 1).collect();
    if let Some(open) = cut.rfind('<') {
        let tail = &cut[open..];
        let is_token = ["<@", "<#", "<:", "<a:", "<t:"]
            .iter()
            .any(|prefix| tail.starts_with(prefix) || prefix.starts_with(tail));
        if is_token && !tail.contains('>') && tail.chars().count() <= MAX_TOKEN_CHARS {
            cut.truncate(open);
        }
    }
    let cut = cut.trim_end();
    if cut.is_empty() {
        return (Some("…".to_string()), true);
    }
    (Some(format!("{cut}…")), true)
}

fn preview_from_row(row: ChannelPreviewRow, can_unmask: bool) -> ChannelPreview {
    let encrypted = row.flags & MESSAGE_FLAG_DM_E2EE != 0;

    // The same identity the message itself reads as (see `build_message_json`):
    // a webhook post as the webhook, a feed post as the feed, and an anonymous
    // message as its alias unless the viewer may unmask it.
    let (author_id, author_kind, author_name) = if let Some(alias) = row.anonymous_alias {
        let id = if can_unmask {
            row.author_id.to_string()
        } else {
            format!("anon:{}:{}", row.channel_id, alias)
        };
        (id, ChannelPreviewAuthorKind::Anonymous, Some(alias))
    } else if let Some(webhook_id) = row.webhook_id {
        (
            webhook_id.to_string(),
            ChannelPreviewAuthorKind::Webhook,
            row.webhook_name,
        )
    } else if let Some(feed_id) = row.feed_id {
        (
            feed_id.to_string(),
            ChannelPreviewAuthorKind::Feed,
            row.feed_name,
        )
    } else {
        let name = [
            row.author_nick,
            row.author_display_name,
            row.author_username,
        ]
        .into_iter()
        .flatten()
        .find(|name| !name.trim().is_empty());
        (
            row.author_id.to_string(),
            ChannelPreviewAuthorKind::User,
            name,
        )
    };

    let (content, truncated) = if encrypted {
        (None, false)
    } else {
        preview_text(row.content.as_deref())
    };
    let media = if encrypted {
        None
    } else {
        row.first_attachment_id.map(|id| ChannelPreviewMedia {
            attachment_id: id.to_string(),
            content_type: row.first_attachment_content_type,
            filename: row.first_attachment_filename.unwrap_or_default(),
            width: row.first_attachment_width,
            height: row.first_attachment_height,
        })
    };

    ChannelPreview {
        channel_id: row.channel_id.to_string(),
        message_id: row.message_id.to_string(),
        message_type: i32::from(row.message_type),
        author_id,
        author_kind,
        author_name,
        content,
        truncated,
        encrypted,
        created_at: row.created_at.to_rfc3339(),
        media,
        attachment_count: u32::try_from(row.attachment_count.max(0)).unwrap_or(u32::MAX),
        has_sticker: row.sticker_count > 0,
    }
}

/// One preview per readable text-like channel of the guild that has a message,
/// ordered by channel id. Readable means VIEW_CHANNEL and READ_MESSAGE_HISTORY,
/// the same pair `GET /channels/{id}/messages` requires: a preview is the
/// newest message of the history.
pub async fn get_channel_previews(
    State(state): State<AppState>,
    auth: AuthUser,
    Path(guild_id): Path<i64>,
) -> Result<Json<Vec<ChannelPreview>>, ApiError> {
    let permission_generation = state.permission_cache.generation();
    paracord_core::permissions::ensure_guild_member(&state.db, guild_id, auth.user_id).await?;

    let guild = paracord_db::guilds::get_guild(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?
        .ok_or(ApiError::NotFound)?;
    let channels = paracord_db::channels::get_guild_channels(&state.db, guild_id)
        .await
        .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;
    let channel_permissions = paracord_core::permissions::compute_all_channel_permissions(
        &state.db,
        guild_id,
        &channels,
        guild.owner_id,
        auth.user_id,
    )
    .await?;
    paracord_core::permissions::seed_channel_permissions(
        &state.permission_cache,
        auth.user_id,
        &channel_permissions,
        permission_generation,
    )
    .await;

    let permissions_of = |channel_id: i64| {
        channel_permissions
            .get(&channel_id)
            .copied()
            .unwrap_or(Permissions::empty())
    };
    let readable: Vec<i64> = channels
        .iter()
        .filter(|channel| PREVIEW_CHANNEL_TYPES.contains(&channel.channel_type))
        .filter(|channel| {
            permissions_of(channel.id)
                .contains(Permissions::VIEW_CHANNEL | Permissions::READ_MESSAGE_HISTORY)
        })
        .map(|channel| channel.id)
        .collect();
    if readable.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let rows =
        paracord_db::channel_previews::latest_messages_for_channels(&state.db, guild_id, &readable)
            .await
            .map_err(|e| ApiError::Internal(anyhow::anyhow!(e.to_string())))?;

    let previews = rows
        .into_iter()
        .map(|row| {
            // Unmasking an anonymous author follows the message routes:
            // MANAGE_MESSAGES or MANAGE_GUILD in that channel.
            let can_unmask = permissions_of(row.channel_id)
                .intersects(Permissions::MANAGE_MESSAGES | Permissions::MANAGE_GUILD);
            preview_from_row(row, can_unmask)
        })
        .collect();
    Ok(Json(previews))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_text_is_kept_with_whitespace_collapsed() {
        assert_eq!(
            preview_text(Some("  hello\n\n  there\tfriend ")),
            (Some("hello there friend".to_string()), false)
        );
        assert_eq!(preview_text(Some(" \n ")), (None, false));
        assert_eq!(preview_text(None), (None, false));
    }

    #[test]
    fn long_text_is_cut_to_the_limit_with_an_ellipsis() {
        let raw = "é".repeat(500);
        let (text, truncated) = preview_text(Some(&raw));
        let text = text.unwrap();
        assert!(truncated);
        assert_eq!(text.chars().count(), PREVIEW_MAX_CHARS);
        assert!(text.ends_with('…'));
    }

    #[test]
    fn a_cut_never_splits_a_mention_token() {
        let raw = format!("{} <@123456789012345678> tail", "a".repeat(130));
        let (text, truncated) = preview_text(Some(&raw));
        let text = text.unwrap();
        assert!(truncated);
        assert!(!text.contains('<'), "half token kept: {text}");
        assert_eq!(text, format!("{}…", "a".repeat(130)));
    }

    #[test]
    fn a_plain_less_than_sign_is_not_treated_as_a_token() {
        let raw = format!("{} < {}", "a".repeat(130), "b".repeat(50));
        let (text, _) = preview_text(Some(&raw));
        assert!(text.unwrap().contains(" < "));
    }
}
