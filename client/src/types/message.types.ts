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

export interface Attachment {
  id: string;
  filename: string;
  size: number;
  content_type?: string;
  url: string;
  proxy_url?: string;
  width?: number;
  height?: number;
  origin_server?: string;
  content_hash?: string;
}

export interface Sticker {
  id: string;
  guild_id: string;
  name: string;
  description?: string | null;
  format_type: number;
  creator_id?: string | null;
  image_url?: string | null;
  created_at: string;
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
  stickers?: Sticker[];
  reactions: Reaction[] | unknown[];
  poll?: Poll;
  referenced_message?: Message;
  embeds?: MessageEmbed[];
  anonymous?: {
    alias: string;
    is_anonymous: boolean;
    can_deanonymize: boolean;
  } | null;
  expires_at?: string | null;
  flags?: number | null;
}
