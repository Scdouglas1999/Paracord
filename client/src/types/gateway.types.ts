import type { Guild } from './guild.types';
import type { User } from './user.types';

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
