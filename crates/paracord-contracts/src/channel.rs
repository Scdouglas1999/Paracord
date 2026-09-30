use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Who a preview's message reads as. `author_id` means a different thing for
/// each: a user id, a webhook id, a feed id, or (for an anonymous message the
/// viewer may not unmask) the `anon:{channel_id}:{alias}` pseudo-id that the
/// message itself carries. Only `user` ids name a member.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ChannelPreviewAuthorKind {
    User,
    Webhook,
    Feed,
    Anonymous,
}

/// The first attachment of a preview's message, so a row can lead with a
/// thumbnail. The client builds the file URL from `attachment_id`.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ChannelPreviewMedia {
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub attachment_id: String,
    pub content_type: Option<String>,
    pub filename: String,
    #[schemars(range(min = -2147483648i64, max = 2147483647))]
    pub width: Option<i32>,
    #[schemars(range(min = -2147483648i64, max = 2147483647))]
    pub height: Option<i32>,
}

/// The newest message of one guild channel, for the channel row of the
/// places panel (`GET /api/v1/guilds/{guild_id}/channel-previews`).
///
/// `content` is the message's raw text (markdown and `<@id>` tokens intact)
/// with whitespace runs collapsed to single spaces, cut to at most 140
/// characters including a trailing `…` when `truncated`; a cut never ends
/// inside a `<…>` token. Rendering (mentions, spoilers, emphasis) is the
/// client's job. It is null for an encrypted message, whose body the server
/// cannot read, and for a message without text (only media or a sticker).
/// A poll's text is its question (`message_type` 20).
/// `media` is null for an encrypted message as well.
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ChannelPreview {
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub channel_id: String,
    #[schemars(length(min = 1), regex(pattern = r"^[0-9]+$"))]
    pub message_id: String,
    #[schemars(range(min = -2147483648i64, max = 2147483647))]
    pub message_type: i32,
    #[schemars(length(min = 1))]
    pub author_id: String,
    pub author_kind: ChannelPreviewAuthorKind,
    /// Guild nickname, else display name, else username; the webhook, feed or
    /// anonymous alias for those kinds. Null when the author record is gone.
    pub author_name: Option<String>,
    pub content: Option<String>,
    pub truncated: bool,
    pub encrypted: bool,
    #[schemars(length(min = 1))]
    pub created_at: String,
    pub media: Option<ChannelPreviewMedia>,
    #[schemars(range(min = 0, max = 4294967295u64))]
    pub attachment_count: u32,
    pub has_sticker: bool,
}
