-- Ensure nonce-based message idempotency has a race-safe DB guarantee.
-- Keep the earliest message per (channel_id, author_id, nonce) and clear duplicates.
WITH ranked AS (
    SELECT id,
           ROW_NUMBER() OVER (
               PARTITION BY channel_id, author_id, nonce
               ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM messages
    WHERE nonce IS NOT NULL
      AND nonce <> ''
)
UPDATE messages
SET nonce = NULL
WHERE id IN (
    SELECT id
    FROM ranked
    WHERE rn > 1
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce_dedup_unique
    ON messages(channel_id, author_id, nonce)
    WHERE nonce IS NOT NULL
      AND nonce <> '';
