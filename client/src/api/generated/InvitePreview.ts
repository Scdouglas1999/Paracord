/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `GET /invites/{code}`: public invite resolution. `guild` is null when the
 * invite's channel no longer resolves to a guild. `join_gate` is null unless
 * the owner enabled one — which is what lets the invite page ask a newcomer
 * for nothing at all in the ordinary case.
 */
export interface InvitePreview {
  code: string;
  guild: InviteGuildPreview | null;
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
 * The guild card embedded in `GET /invites/{code}`.
 */
export interface InviteGuildPreview {
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
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
   * The newcomer must tick an acknowledgement of the server's rules.
   */
  require_ack: boolean;
  [k: string]: unknown | undefined;
}
