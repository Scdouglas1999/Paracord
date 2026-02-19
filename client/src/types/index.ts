// ============ Core Types ============

export interface User {
  id: string;
  username: string;
  discriminator: string | number;
  email?: string;
  avatar?: string;
  avatar_hash?: string | null;
  banner?: string;
  bio?: string;
  display_name?: string | null;
  bot: boolean;
  system: boolean;
  flags: number;
  created_at: string;
}

export interface UserSettings {
  user_id: string;
  theme: 'dark' | 'light' | 'amoled';
  locale: string;
  message_display_compact: boolean;
  custom_css?: string;
  status: 'online' | 'idle' | 'dnd' | 'invisible';
  custom_status?: string;
  crypto_auth_enabled: boolean;
  notifications?: Record<string, unknown>;
  keybinds?: Record<string, unknown>;
}

export interface Guild {
  id: string;
  name: string;
  icon?: string;
  icon_hash?: string | null;
  banner?: string;
  description?: string;
  owner_id: string;
  member_count: number;
  features: string[];
  system_channel_id?: string;
  rules_channel_id?: string;
  default_channel_id?: string | null;
  created_at: string;
  /** Base URL of the server this guild was fetched from (client-side tag). */
  server_url?: string;
}

export enum ChannelType {
  Text = 0,
  DM = 1,
  Voice = 2,
  GroupDM = 3,
  Category = 4,
  Announcement = 5,
  Thread = 6,
  Forum = 7,
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
}

export enum MessageType {
  Default = 0,
  RecipientAdd = 1,
  RecipientRemove = 2,
  Call = 3,
  ChannelNameChange = 4,
  ChannelIconChange = 5,
  PinnedMessage = 6,
  GuildMemberJoin = 7,
  Reply = 19,
  Poll = 20,
}

export interface MessageEmbed {
  url: string;
  title?: string;
  description?: string;
  site_name?: string;
  thumbnail?: string;
  image?: string;
  color?: string;
  type?: 'link' | 'image' | 'video' | 'rich';
}

export interface Message {
  id: string;
  channel_id: string;
  author: MessageAuthor;
  content: string | null;
  e2ee?: MessageE2eePayload | null;
  timestamp?: string;
  created_at?: string;
  edited_timestamp?: string;
  edited_at?: string | null;
  reference_id?: string;
  tts: boolean;
  mention_everyone: boolean;
  pinned: boolean;
  type: MessageType | number;
  message_type?: number;
  attachments: Attachment[];
  reactions: Reaction[] | unknown[];
  poll?: Poll;
  referenced_message?: Message;
  embeds?: MessageEmbed[];
}

export interface MessageAuthor {
  id: string;
  username: string;
  discriminator: string;
  avatar?: string;
  avatar_hash?: string | null;
  public_key?: string | null;
  bot?: boolean;
  flags?: number;
}

export interface MessageE2eePayload {
  version: number;
  nonce: string;
  ciphertext: string;
  header?: string;
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

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  url: string;
  proxy_url?: string;
  width?: number;
  height?: number;
}

export interface Reaction {
  emoji: string;
  count: number;
  me: boolean;
}

export interface PollOption {
  id: string;
  text: string;
  emoji?: string | null;
  position: number;
  vote_count: number;
  voted: boolean;
}

export interface Poll {
  id: string;
  message_id: string;
  channel_id: string;
  question: string;
  allow_multiselect: boolean;
  expires_at?: string | null;
  created_at: string;
  options: PollOption[];
  total_votes: number;
}

export interface Member {
  user: User;
  user_id?: string;
  guild_id?: string;
  nick?: string | null;
  roles: string[];
  joined_at: string;
  deaf: boolean;
  mute: boolean;
}

export interface Role {
  id: string;
  guild_id: string;
  name: string;
  color: number;
  hoist: boolean;
  position: number;
  permissions: string | number;
  mentionable: boolean;
  created_at: string;
}

export interface Invite {
  code: string;
  guild_id: string;
  channel_id: string;
  inviter_id?: string;
  uses: number;
  max_uses?: number;
  max_age?: number;
  temporary: boolean;
  created_at: string;
  guild?: Guild;
  channel?: Channel;
  inviter?: User;
}

export interface Webhook {
  id: string;
  guild_id: string;
  channel_id: string;
  name: string;
  creator_id?: string | null;
  created_at: string;
  token?: string;
}

export interface GuildEmoji {
  id: string;
  guild_id: string;
  name: string;
  animated: boolean;
  creator_id?: string | null;
  created_at: string;
}

export interface VoiceState {
  user_id: string;
  channel_id?: string;
  guild_id?: string;
  session_id: string;
  deaf: boolean;
  mute: boolean;
  self_deaf: boolean;
  self_mute: boolean;
  self_stream: boolean;
  self_video: boolean;
  suppress: boolean;
  username?: string;
  avatar_hash?: string | null;
}

export interface Presence {
  user_id: string;
  guild_id?: string;
  status: 'online' | 'idle' | 'dnd' | 'offline';
  activities: Activity[];
}

export interface Activity {
  name: string;
  type: number;
  activity_type?: number;
  details?: string;
  state?: string;
  started_at?: string;
  application_id?: string;
}

export interface Ban {
  user: User;
  reason?: string;
  guild_id: string;
}

export interface AuditLogEntry {
  id: string;
  guild_id: string;
  user_id: string;
  action_type: number;
  target_id?: string;
  changes?: Record<string, unknown>;
  reason?: string;
  created_at: string;
}

export interface ReadState {
  channel_id: string;
  last_message_id: string;
  mention_count: number;
}

// ============ User Flags ============

export const UserFlags = {
  ADMIN: 1 << 0,
} as const;

export function isAdmin(flags: number): boolean {
  return (flags & UserFlags.ADMIN) !== 0;
}

// ============ Permission Flags ============

export const Permissions = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS: 1n << 1n,
  BAN_MEMBERS: 1n << 2n,
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  MANAGE_GUILD: 1n << 5n,
  ADD_REACTIONS: 1n << 6n,
  VIEW_AUDIT_LOG: 1n << 7n,
  PRIORITY_SPEAKER: 1n << 8n,
  STREAM: 1n << 9n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  SEND_TTS_MESSAGES: 1n << 12n,
  MANAGE_MESSAGES: 1n << 13n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MENTION_EVERYONE: 1n << 17n,
  USE_EXTERNAL_EMOJIS: 1n << 18n,
  CONNECT: 1n << 20n,
  SPEAK: 1n << 21n,
  MUTE_MEMBERS: 1n << 22n,
  DEAFEN_MEMBERS: 1n << 23n,
  MOVE_MEMBERS: 1n << 24n,
  USE_VAD: 1n << 25n,
  CHANGE_NICKNAME: 1n << 26n,
  MANAGE_NICKNAMES: 1n << 27n,
  MANAGE_ROLES: 1n << 28n,
  MANAGE_WEBHOOKS: 1n << 29n,
  MANAGE_EMOJIS: 1n << 30n,
} as const;

export function hasPermission(permissions: bigint, flag: bigint): boolean {
  if (permissions & Permissions.ADMINISTRATOR) return true;
  return (permissions & flag) === flag;
}

// ============ Gateway Types ============

export enum GatewayOpcode {
  Dispatch = 0,
  Heartbeat = 1,
  Identify = 2,
  PresenceUpdate = 3,
  VoiceStateUpdate = 4,
  Resume = 6,
  Reconnect = 7,
  RequestGuildMembers = 8,
  InvalidSession = 9,
  Hello = 10,
  HeartbeatAck = 11,
}

export interface GatewayPayload {
  op: GatewayOpcode;
  d: unknown;
  s?: number;
  t?: string;
}

export interface ReadyEvent {
  user: User;
  guilds: Guild[];
  session_id: string;
}

// ============ API Request/Response Types ============

export interface LoginRequest {
  email?: string;
  identifier?: string;
  username?: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  user: User;
  refresh_token?: string;
}

export interface RegisterRequest {
  email: string;
  username: string;
  password: string;
  display_name?: string;
}

export interface CreateGuildRequest {
  name: string;
  icon?: string;
}

export interface CreateChannelRequest {
  name: string;
  type?: ChannelType;
  channel_type?: number;
  parent_id?: string | null;
  required_role_ids?: string[];
  topic?: string;
  position?: number;
  bitrate?: number;
  user_limit?: number;
}

export interface SendMessageRequest {
  content: string;
  referenced_message_id?: string;
  attachment_ids?: string[];
  e2ee?: MessageE2eePayload;
  nonce?: string;
}

export interface EditMessageRequest {
  content: string;
  e2ee?: MessageE2eePayload;
}

export interface CreateInviteRequest {
  max_age?: number;
  max_uses?: number;
  temporary?: boolean;
}

export interface CreateRoleRequest {
  name: string;
  color?: number;
  permissions?: number;
  hoist?: boolean;
  mentionable?: boolean;
}

export interface UpdateMemberRequest {
  nick?: string;
  roles?: string[];
  mute?: boolean;
  deaf?: boolean;
}

export interface InviteAcceptResponse {
  guild: Guild;
}

export interface PaginationParams {
  before?: string;
  after?: string;
  limit?: number;
}
