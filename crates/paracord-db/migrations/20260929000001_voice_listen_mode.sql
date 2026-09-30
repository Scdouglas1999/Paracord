-- Glass: listen in, stream start time, and the per-channel listen-in switch.
--
-- voice_states.mode: 'joined' (a full call membership) or 'listen' (receive
-- only, never sends; everyone in the channel sees "listening in"). Every row
-- that exists today is a full membership, so the constant default is also the
-- backfill.
--
-- voice_states.self_stream_started_at: when the member's current stream
-- started, so clients can show "LIVE 42 MIN". TEXT holding
-- `YYYY-MM-DD HH:MM:SS` UTC on both engines (sqlx Any cannot decode a native
-- timestamp). Set while self_stream is true, NULL otherwise.
--
-- channel_feature_settings.listen_in_enabled: whether a voice channel admits
-- listeners. On by default; a channel without a settings row is on too.
--
-- SQLite cannot ADD COLUMN with a non-constant default on a populated table, so
-- the stream start time is added empty and backfilled for rows already
-- streaming (the true start is unknown; now is the closest honest bound).

ALTER TABLE voice_states
ADD COLUMN mode TEXT NOT NULL DEFAULT 'joined' CHECK (mode IN ('joined', 'listen'));

ALTER TABLE voice_states
ADD COLUMN self_stream_started_at TEXT NULL;

UPDATE voice_states
SET self_stream_started_at = datetime('now')
WHERE self_stream = TRUE AND self_stream_started_at IS NULL;

ALTER TABLE channel_feature_settings
ADD COLUMN listen_in_enabled BOOLEAN NOT NULL DEFAULT TRUE;
