-- SQLite compatibility helpers for PostgreSQL migration track.
-- Keep existing migration/query semantics for datetime()/strftime() calls.

CREATE OR REPLACE FUNCTION datetime(value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    ts TIMESTAMP;
BEGIN
    IF value IS NULL THEN
        RETURN NULL;
    END IF;

    IF lower(value) = 'now' THEN
        ts := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    ELSE
        ts := value::timestamp;
    END IF;

    RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
END;
$$;

CREATE OR REPLACE FUNCTION datetime(value TEXT, modifier TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    ts TIMESTAMP;
    m TEXT[];
    amount BIGINT;
    sign TEXT;
    unit TEXT;
    delta INTERVAL;
BEGIN
    IF value IS NULL THEN
        RETURN NULL;
    END IF;

    IF lower(value) = 'now' THEN
        ts := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    ELSE
        ts := value::timestamp;
    END IF;

    IF modifier IS NULL OR btrim(modifier) = '' THEN
        RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
    END IF;

    m := regexp_match(
        btrim(modifier),
        '^([+-])(\d+)\s+(second|seconds|minute|minutes|hour|hours|day|days|week|weeks|month|months|year|years)$'
    );
    IF m IS NULL THEN
        RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
    END IF;

    sign := m[1];
    amount := m[2]::BIGINT;
    unit := m[3];
    delta := make_interval(
        years => CASE WHEN unit IN ('year', 'years') THEN amount::INT ELSE 0 END,
        months => CASE WHEN unit IN ('month', 'months') THEN amount::INT ELSE 0 END,
        weeks => CASE WHEN unit IN ('week', 'weeks') THEN amount::INT ELSE 0 END,
        days => CASE WHEN unit IN ('day', 'days') THEN amount::INT ELSE 0 END,
        hours => CASE WHEN unit IN ('hour', 'hours') THEN amount::INT ELSE 0 END,
        mins => CASE WHEN unit IN ('minute', 'minutes') THEN amount::INT ELSE 0 END,
        secs => CASE WHEN unit IN ('second', 'seconds') THEN amount::DOUBLE PRECISION ELSE 0 END
    );

    IF sign = '-' THEN
        ts := ts - delta;
    ELSE
        ts := ts + delta;
    END IF;

    RETURN to_char(ts, 'YYYY-MM-DD HH24:MI:SS');
END;
$$;

CREATE OR REPLACE FUNCTION strftime(fmt TEXT, value TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    ts TIMESTAMP;
BEGIN
    IF fmt <> '%s' THEN
        RAISE EXCEPTION 'Unsupported strftime format: %', fmt;
    END IF;

    IF value IS NULL OR lower(value) = 'now' THEN
        ts := CURRENT_TIMESTAMP AT TIME ZONE 'UTC';
    ELSE
        ts := value::timestamp;
    END IF;

    RETURN floor(extract(epoch FROM ts))::BIGINT::TEXT;
END;
$$;
