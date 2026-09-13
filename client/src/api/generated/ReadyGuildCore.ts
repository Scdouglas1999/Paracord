/* eslint-disable */
/** Generated from Rust wire types by npm run contracts:generate. Do not edit. */

/**
 * Persisted space metadata carried by the gateway READY payload.
 * Distinct from `GuildSummary`: READY sends only durable fields, never the
 * REST settings surface. Nullable fields are present, including when null.
 */
export interface ReadyGuildCore {
  created_at: string;
  icon_hash: string | null;
  id: string;
  member_count: number;
  name: string;
  owner_id: string;
  [k: string]: unknown | undefined;
}
