/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Who a preview's message reads as. `author_id` means a different thing for
 * each: a user id, a webhook id, a feed id, or (for an anonymous message the
 * viewer may not unmask) the `anon:{channel_id}:{alias}` pseudo-id that the
 * message itself carries. Only `user` ids name a member.
 */
export type ChannelPreviewAuthorKind = 'user' | 'webhook' | 'feed' | 'anonymous';
export type ChannelPreviewList = ChannelPreview[];

/**
 * The newest message of one guild channel, for the channel row of the
 * places panel (`GET /api/v1/guilds/{guild_id}/channel-previews`).
 *
 * `content` is the message's raw text (markdown and `<@id>` tokens intact)
 * with whitespace runs collapsed to single spaces, cut to at most 140
 * characters including a trailing `…` when `truncated`; a cut never ends
 * inside a `<…>` token. Rendering (mentions, spoilers, emphasis) is the
 * client's job. It is null for an encrypted message, whose body the server
 * cannot read, and for a message without text (only media or a sticker).
 * A poll's text is its question (`message_type` 20).
 * `media` is null for an encrypted message as well.
 */
export interface ChannelPreview {
  attachment_count: number;
  author_id: string;
  author_kind: ChannelPreviewAuthorKind;
  /**
   * Guild nickname, else display name, else username; the webhook, feed or
   * anonymous alias for those kinds. Null when the author record is gone.
   */
  author_name: string | null;
  channel_id: string;
  content: string | null;
  created_at: string;
  encrypted: boolean;
  has_sticker: boolean;
  media: ChannelPreviewMedia | null;
  message_id: string;
  message_type: number;
  truncated: boolean;
  [k: string]: unknown | undefined;
}
/**
 * The first attachment of a preview's message, so a row can lead with a
 * thumbnail. The client builds the file URL from `attachment_id`.
 */
export interface ChannelPreviewMedia {
  attachment_id: string;
  content_type: string | null;
  filename: string;
  height: number | null;
  width: number | null;
  [k: string]: unknown | undefined;
}
