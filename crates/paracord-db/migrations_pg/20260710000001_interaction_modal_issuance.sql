ALTER TABLE interaction_tokens ADD COLUMN modal_data TEXT;
ALTER TABLE interaction_tokens ADD COLUMN modal_issued_at TIMESTAMPTZ;
ALTER TABLE interaction_tokens ADD COLUMN modal_consumed_at TIMESTAMPTZ;
