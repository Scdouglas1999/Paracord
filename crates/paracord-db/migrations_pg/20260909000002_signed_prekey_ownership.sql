-- The earlier BIGINT migration rebuilt this table with a _new constraint name.
-- IDs belong to an account; equal client-generated IDs on other accounts must
-- never prevent publication. The existing UNIQUE(user_id) keeps one active SPK.
ALTER TABLE signed_prekeys DROP CONSTRAINT IF EXISTS signed_prekeys_pkey;
ALTER TABLE signed_prekeys DROP CONSTRAINT IF EXISTS signed_prekeys_new_pkey;
ALTER TABLE signed_prekeys ADD PRIMARY KEY (user_id, id);
