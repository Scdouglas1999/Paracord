-- Hex spelling does not distinguish cryptographic identities. Keep legacy
-- spelling intact, but reject ownership aliases across accounts. If a database
-- already contains aliases, fail migration rather than choose an owner.
CREATE UNIQUE INDEX idx_users_public_key_case_insensitive
    ON users (lower(public_key)) WHERE public_key IS NOT NULL;
