-- A server can tell its members when a favorite team scores. Off until the
-- person who runs the server turns it on, because it makes the server watch
-- those leagues even while nobody has the Sports page open.

ALTER TABLE guild_sports_settings ADD COLUMN score_alerts BOOLEAN NOT NULL DEFAULT FALSE;
