# PostgreSQL `pg_trgm` Prerequisite (Member Search)

On PostgreSQL, Paracord's member search is backed by **trigram GIN indexes** for
fast, case-insensitive substring matching on usernames and nicknames. These
indexes require the `pg_trgm` extension.

The migration `crates/paracord-db/migrations_pg/20260304000001_member_search_trgm.sql`
runs:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_users_username_trgm
    ON users USING GIN (username gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_members_nick_trgm
    ON members USING GIN (nick gin_trgm_ops);
```

`pg_trgm` is a **hard requirement**: the `gin_trgm_ops` operator class used by
the two indexes above does not exist without it. This applies to a normal
`postgres://` deployment and to the target of the
[SQLite → PostgreSQL migrator](sqlite-to-postgres-migration.md).

> SQLite deployments are unaffected — this is a PostgreSQL-only concern.

## Privilege requirement

`CREATE EXTENSION` requires the **`CREATE` privilege on the current database**,
which effectively means a superuser or a role that owns the database (or has
been explicitly granted `CREATE`). If the role that runs the migrations lacks
that privilege, this migration fails with a permission error and startup /
migration aborts.

## Managed / locked-down PostgreSQL

Many managed PostgreSQL providers (RDS, Cloud SQL, Azure Database, Supabase,
Neon, …) run application roles **without** superuser and sometimes restrict
which extensions may be created. `pg_trgm` is a standard `contrib` extension and
is on the allow-list of essentially every managed provider, but you may need to
enable it out-of-band, before Paracord's migrations run, as an administrator.

Pre-provision it one of these ways (all idempotent):

- **As a DBA / admin role**, connect to the target database and run once:

  ```sql
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  ```

- **Provider control plane** — some providers expose an "extensions" toggle or
  a `shared_preload_libraries` / allow-list setting; enable `pg_trgm` there.

- **RDS / Aurora** — `pg_trgm` is available by default; the
  `CREATE EXTENSION IF NOT EXISTS pg_trgm;` above run by the instance's master
  user (or a role granted `rds_superuser`) is sufficient.

Once the extension exists, Paracord's `CREATE EXTENSION IF NOT EXISTS` is a
no-op and the index migration proceeds normally, even for a role without
`CREATE` on extensions.

## Verifying

```sql
-- Extension present?
SELECT extname FROM pg_extension WHERE extname = 'pg_trgm';

-- Indexes present?
SELECT indexname FROM pg_indexes
WHERE indexname IN ('idx_users_username_trgm', 'idx_members_nick_trgm');
```

Both queries should return their respective rows on a healthy deployment.
