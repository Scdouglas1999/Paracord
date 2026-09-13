import type { ChannelType } from './channel.types';
import type { MessageE2eePayload } from './message.types';
import type { User } from './user.types';

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

export type { CreateGuildRequest } from '../api/generated/CreateGuildRequest';
export type { UpdateGuildRequest } from '../api/generated/UpdateGuildRequest';

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
  sticker_ids?: string[];
  e2ee?: MessageE2eePayload;
  nonce?: string;
}

export interface EditMessageRequest {
  content: string;
  e2ee?: MessageE2eePayload;
  /** Immutable identity for a replayable edit operation. */
  edit_nonce?: string;
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

export interface PaginationParams {
  before?: string;
  after?: string;
  /** Anchor id: returns a window of messages centered on this id. */
  around?: string;
  limit?: number;
}
