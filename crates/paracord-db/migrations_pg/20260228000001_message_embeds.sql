-- Add embeds JSON column to messages for storing OpenGraph metadata
ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds TEXT;
