/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Who can create an account on an instance. The same spelling as the
 * `[auth] registration_mode` config value.
 */
export type RegistrationMode = 'open' | 'invite_only';

/**
 * `GET /invites/{code}`: public invite resolution. `guild` is null when the
 * invite's channel no longer resolves to a guild. `join_gate` is null unless
 * the owner enabled one — which is what lets the invite page ask a newcomer
 * for nothing at all in the ordinary case.
 */
export interface InvitePreview {
  code: string;
  /**
   * RFC 3339; null when the invite never expires.
   */
  expires_at?: string | null;
  /**
   * Up to three members, online first, then most recently joined.
   */
  faces?: InviteFace[];
  guild: InviteGuildPreview | null;
  instance?: InviteInstance;
  /**
   * Present only when the owner enabled a gate. Absent is the ordinary case,
   * and it is also what a server that predates this field sends — so a
   * client can still open its invites; such a server enforces its gate on
   * accept and says what is missing.
   */
  join_gate?: InviteJoinGate | null;
  [k: string]: unknown | undefined;
}
/**
 * One of up to three members shown on an invite card: only the first
 * grapheme of the display name and the avatar hue. No names, ids or images.
 */
export interface InviteFace {
  hue: number;
  initial: string;
  [k: string]: unknown | undefined;
}
/**
 * The guild card embedded in `GET /invites/{code}`.
 */
export interface InviteGuildPreview {
  /**
   * The server's color as a hue, 0-359; null when unset. Always sent by this
   * server; absent from older ones.
   */
  hue?: number | null;
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
  /**
   * Members online now. Always sent by this server; absent from older ones.
   */
  online_count?: number;
  [k: string]: unknown | undefined;
}
/**
 * What the joining client needs to know about the instance before any
 * account work (spec §6.1, §3.12).
 */
export interface InviteInstance {
  /**
   * 2 on servers with one-password sign-up.
   */
  credential_version: number;
  name: string;
  registration_mode: RegistrationMode;
  require_email: boolean;
  version: string;
  [k: string]: unknown | undefined;
}
/**
 * What joining asks of a newcomer, when the server's owner has turned the
 * verification gate on. The questions are the prompts only; the expected
 * answers never leave the server.
 */
export interface InviteJoinGate {
  /**
   * Questions to answer, in order. Empty when the gate asks none.
   */
  questions: string[];
  /**
   * The newcomer must tick an acknowledgment of the server's rules.
   */
  require_ack: boolean;
  [k: string]: unknown | undefined;
}
