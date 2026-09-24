-- Daily word add-on.
--
-- guild_daily_word_settings: one row per server that has touched the add-on.
-- No row means it is off. Booleans are read back with CAST(col AS INTEGER);
-- timestamps are TEXT on both engines (sqlx Any cannot decode a native timestamp).
--
-- daily_word_puzzles: each day's answer, stored the first time the day is
-- opened so a later change to the word list or the secret never changes a day
-- in progress. Never sent to a client before that client finishes.
--
-- daily_word_results: one row per person per day for the whole instance.
-- guesses is a JSON array of the words guessed, in order.

CREATE TABLE IF NOT EXISTS guild_daily_word_settings (
    guild_id            BIGINT PRIMARY KEY REFERENCES spaces(id) ON DELETE CASCADE,
    enabled             BOOLEAN NOT NULL DEFAULT FALSE,
    share_channel_id    BIGINT REFERENCES channels(id) ON DELETE SET NULL,
    show_on_front_page  BOOLEAN NOT NULL DEFAULT TRUE,
    updated_at          TEXT
);

CREATE TABLE IF NOT EXISTS daily_word_puzzles (
    puzzle      BIGINT PRIMARY KEY,
    answer      TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_word_results (
    user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    puzzle       BIGINT NOT NULL,
    guesses      TEXT NOT NULL DEFAULT '[]',
    guess_count  BIGINT NOT NULL DEFAULT 0,
    finished     BOOLEAN NOT NULL DEFAULT FALSE,
    solved       BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at   TEXT NOT NULL,
    finished_at  TEXT,
    PRIMARY KEY (user_id, puzzle)
);

CREATE INDEX IF NOT EXISTS idx_daily_word_results_puzzle ON daily_word_results (puzzle);
