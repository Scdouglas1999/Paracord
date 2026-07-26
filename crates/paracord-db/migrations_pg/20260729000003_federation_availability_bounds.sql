-- Availability bounds for the federation tables.
--
-- 1. `federation_delivery_attempts` is append-only and had no deletion path
--    anywhere in the codebase, so a peer that is merely unreachable wrote a row
--    per event per retry forever. Retention is now enforced from the background
--    outbound-queue pass, which deletes by `attempted_at_ms`; the existing index
--    leads with `destination_server` and cannot serve that predicate.
--
-- 2. Peer-name canonicalization runs on every federation transport request,
--    including rejected ones, and used to materialize the entire
--    `federated_servers` table to do a case-insensitive / domain-alias match.
--    The expression indexes below let that resolution become a lookup.

CREATE INDEX IF NOT EXISTS idx_fed_delivery_attempts_attempted_at
    ON federation_delivery_attempts(attempted_at_ms);

CREATE INDEX IF NOT EXISTS idx_federated_servers_name_lower
    ON federated_servers(LOWER(server_name));

CREATE INDEX IF NOT EXISTS idx_federated_servers_domain_lower
    ON federated_servers(LOWER(domain));
