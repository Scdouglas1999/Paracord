-- A sealed, never-delivered nonce is distinct from a delivered message later
-- deleted. Both remain reserved so delayed creates cannot resurrect them.
ALTER TABLE message_delivery_receipts ADD COLUMN cancelled BOOLEAN NOT NULL DEFAULT FALSE;
