-- Share one-time-code consumption across server processes and restarts.
ALTER TABLE mfa_configs ADD COLUMN last_used_step BIGINT NOT NULL DEFAULT -1;
