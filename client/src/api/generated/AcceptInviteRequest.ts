/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * `POST /invites/{code}` accepts an optional JSON body.
 */
export interface AcceptInviteRequest {
  verification_ack?: boolean | null;
  verification_answers?: string[] | null;
  [k: string]: unknown | undefined;
}
