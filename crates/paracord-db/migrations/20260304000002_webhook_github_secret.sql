-- Add optional github_secret column for HMAC-SHA256 webhook signature verification
ALTER TABLE webhooks ADD COLUMN github_secret TEXT;
