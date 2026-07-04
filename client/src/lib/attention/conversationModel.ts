/**
 * Unified-conversation data model (layout-spec §3.1).
 *
 * Pure types + builders only — NO store or React imports. This is a leaf module
 * consumed later by `useUnifiedConversations` and the sidebar components.
 */

/** Paracord custom snowflake epoch: 2024-01-01T00:00:00Z (ms). */
export const EPOCH_MS = 1704067200000;

export type ConversationKind =
  | 'dm'
  | 'group_dm'
  | 'guild_text'
  | 'thread'
  | 'voice'
  | 'guild_home';

export interface ConversationEntry {
  /** `${serverId}:${channelId}` — collision-safe across servers. */
  key: string;
  /** Resolved from guild.server_url→serverId map, or the DM's owning server. */
  serverId: string;
  channelId: string;
  /** null for DMs / group DMs. */
  guildId: string | null;
  /**
   * The other party's user id for a DM row (recipient of a 1:1 DM), else null.
   * Carried on the entry so a row can run its OWN `usePresenceStore` selector for
   * the presence dot — presence is NEVER read inside the unified-list memo, so a
   * presence tick does not re-run the whole cross-server build (layout-spec §3.2).
   * Optional so the DATA-1/3 fixtures stay valid; `useUnifiedConversations` always
   * sets it explicitly (recipient id for DMs, null for guild channels).
   */
  userId?: string | null;
  kind: ConversationKind;
  /** channel name / DM recipient / thread name / guild name. */
  title: string;
  /** small guild-context label for guild rows ("in Emerald HQ"). */
  contextLabel: string | null;
  /** channel.last_message_id snowflake → time-sortable. */
  lastActivityId: string | null;
  unread: boolean;
  /** direct + role + @everyone (merged at ingest — see §3.3). */
  mentionCount: number;
  isDMUnread: boolean;
  isThreadReply: boolean;
  /** channelParticipants.get(channelId).length > 0. */
  hasVoiceActivity: boolean;
  pinned: boolean;
}

/**
 * Snowflake → epoch-ms. Mirrors `paracord-util::snowflake` server-side:
 * `((id >> 22) + PARACORD_EPOCH)`. Used for recency sort + decay.
 */
export function snowflakeToMs(id: string): number {
  return Number(BigInt(id) >> 22n) + EPOCH_MS;
}

/** Composite key used by every cross-server map (read-state, pins, entries). */
export function conversationKey(serverId: string, channelId: string): string {
  return `${serverId}:${channelId}`;
}
