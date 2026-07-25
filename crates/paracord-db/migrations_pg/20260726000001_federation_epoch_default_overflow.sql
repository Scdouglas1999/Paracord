-- Fix epoch-millisecond column defaults that overflow int4 on PostgreSQL.
--
-- `20260218000001_federation_transport_hardening` and
-- `20260219000001_federation_namespace_and_sync` declared their `*_at_ms`
-- columns as
--     DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
-- which is correct on SQLite (INTEGER is 64-bit there) but fatal on PostgreSQL:
-- `CAST(... AS INTEGER)` is int4, so the current epoch (~1.79e9) fits but
-- multiplying by 1000 (~1.79e12) does not, and every insert that relies on the
-- default fails with `ERROR: integer out of range`.
--
-- This is not cosmetic. `federation::insert_transport_replay_key` omits
-- `created_at_ms`, so on PostgreSQL *every* inbound federated request failed its
-- replay-cache insert and federation was dead in the water.
--
-- The correct form -- already used by
-- `20260302000002_federation_moderation_lists` -- casts after the multiply.
-- The defaults are corrected forward here rather than by editing the shipped
-- migrations, because a default is pure schema: rewriting it repairs existing
-- deployments and fresh installs alike, with no migration checksum churn.

ALTER TABLE federation_peer_trust_state
    ALTER COLUMN updated_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;

ALTER TABLE federation_transport_replay_cache
    ALTER COLUMN created_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;

ALTER TABLE federation_outbound_queue
    ALTER COLUMN next_attempt_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;
ALTER TABLE federation_outbound_queue
    ALTER COLUMN created_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;
ALTER TABLE federation_outbound_queue
    ALTER COLUMN updated_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;

ALTER TABLE federation_delivery_attempts
    ALTER COLUMN attempted_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;

ALTER TABLE federation_room_sync_cursors
    ALTER COLUMN updated_at_ms SET DEFAULT (EXTRACT(EPOCH FROM now()) * 1000)::BIGINT;
