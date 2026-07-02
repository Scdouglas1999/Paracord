export enum ChannelType {
  Text = 0,
  DM = 1,
  Voice = 2,
  GroupDM = 3,
  Category = 4,
  Announcement = 5,
  Thread = 6,
  Forum = 7,
  Stage = 13,
}

export interface ThreadMetadata {
  archived: boolean;
  auto_archive_duration: number;
  archive_timestamp?: string | null;
  locked: boolean;
  starter_message_id?: string | null;
}

export interface Channel {
  id: string;
  type: ChannelType;
  channel_type?: number;
  guild_id?: string | null;
  name?: string | null;
  topic?: string;
  position: number;
  nsfw: boolean;
  bitrate?: number;
  user_limit?: number;
  rate_limit_per_user?: number;
  parent_id?: string | null;
  last_message_id?: string;
  required_role_ids?: string[];
  thread_metadata?: ThreadMetadata | null;
  owner_id?: string | null;
  message_count?: number | null;
  applied_tags?: string[] | null;
  default_sort_order?: number | null;
  created_at: string;
  recipient?: {
    id: string;
    username: string;
    discriminator: string | number;
    avatar_hash?: string | null;
    public_key?: string | null;
  };
  /** For group DMs (type 3), the list of all participants. */
  recipients?: Array<{
    id: string;
    username: string;
    discriminator: string | number;
    avatar_hash?: string | null;
    public_key?: string | null;
  }>;
}

export interface ForumTag {
  id: string;
  channel_id: string;
  name: string;
  emoji?: string | null;
  moderated: boolean;
  position: number;
  created_at: string;
}

export interface ForumPostsResponse {
  posts: Channel[];
  tags: ForumTag[];
  sort_order: number;
}

export interface ReadState {
  channel_id: string;
  last_message_id: string;
  mention_count: number;
}

export const OverwriteTargetType = {
  Role: 0,
  Member: 1,
} as const;

export interface ChannelOverwrite {
  channel_id: string;
  target_id: string;
  target_type: number;
  allow_perms: number;
  deny_perms: number;
}

export interface UpsertChannelOverwriteRequest {
  target_type: number;
  allow_perms: number;
  deny_perms: number;
}
