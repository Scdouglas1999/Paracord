# Backup and offline recovery

`paracord-server restore-backup` prepares and verifies a separate recovery
installation. It writes a new directory and, for PostgreSQL, restores into a
new empty database. It never selects that installation for the running server.
Stop every instance using the old database before activating the recovered one.

The admin Backups panel creates/downloads archives and shows recovery
instructions. `POST /api/v1/admin/restore` returns
`status: "offline_restore_required"`; it does not replace a live database or
report that recovery has succeeded.

## Retain the complete recovery material

Keep the following together in protected backup storage:

- The Paracord `.tar.gz` archive. Include media for local storage. A database
  snapshot alone cannot recover uploads or native media files.
- The original `paracord.toml` and its deployment environment. The config holds
  authentication settings and the JWT secret; environment overrides may hold
  other secrets and change the effective database or storage settings.
- The original at-rest master key, if encryption is enabled. Where it lives depends
  on `[at_rest] key_source`: the key file named by `key_file`, the keychain entry
  `keychain_account`, a systemd credential, or the environment variable named by
  `key_env`. Keep the original encryption settings. The CLI does not generate
  replacement encryption keys. If the server's owner saved a recovery copy of the
  key, every backup carries it and the owner's recovery phrase can stand in for
  these; see [Restoring an encrypted server without its key](#restoring-an-encrypted-server-without-its-key).
- The TLS certificate and private key when Paracord terminates TLS, and the
  federation signing key when federation is enabled. These are separate files,
  not certificate/key bytes embedded in `paracord.toml`.
- For database-only archives or S3 storage, a matching media export containing
  both `uploads/` and `files/`. Preserve encrypted bytes, relative object names,
  and attachment filenames. The command does not download S3 objects; recovery
  from an explicit object export produces a local-storage configuration.

Current admin and scheduled backups use the already-open, keyed SQLite pool or
`pg_dump` on PostgreSQL. Version 2 archives include encryption metadata and an
authenticated key check when at-rest encryption is enabled. They do **not**
include the master key, original config, TLS keys, or federation key. Earlier
version 1 Paracord archives are also accepted, with verification based on the
supplied configuration and stored data. Raw `.sql`, `.db`, or `.pgdump` files
are not inputs to this command.

Database snapshots and filesystem copies are not a single cross-storage
transaction. Preserve a consistent media export and run recovery verification
regularly. A deleted or mismatched attachment makes verification fail.

## Prepare SQLite recovery

Use a server build compatible with the archive's schema. Run from the original
service's working directory when its configuration contains relative paths.
Supply the same deployment environment and, when enabled, the original master
key through your usual secret provisioning mechanism. The output directory
must not exist; its parent must exist. Keep it outside any `--media-dir` export
to prevent staging from becoming part of its own input.

```bash
paracord-server --config /srv/paracord/paracord.toml restore-backup \
  --archive /srv/backups/paracord-backup.tar.gz \
  --output-dir /srv/paracord-recovery-20260912
```

For a database-only archive, add:

```bash
--media-dir /srv/backups/matching-media-export
```

The command copies the archived database to the new directory, opens it using
the original encryption settings, checks SQLite integrity and foreign keys,
applies migrations, and verifies media before producing activation files.
Encrypted SQLite requires a SQLCipher-capable server build; a missing cipher or
wrong key fails preparation. Plaintext SQLite is not silently accepted when
the supplied configuration requires encrypted SQLite.

## Restoring an encrypted server without its key

A server that encrypts its stored data keeps the key on the computer it runs on (a key
file, the keychain, or a systemd credential; see
[Stored data on the server](encryption.md#stored-data-on-the-server)). If that computer
is gone, the archive alone cannot be opened.

When the owner has saved a **recovery copy** of the key
([Recovering the storage key](encryption.md#recovering-the-storage-key)), every backup
made after that carries it, wrapped so that only a value derived from the owner's
recovery phrase opens it. That value (the escrow key) is the base64url text of 32 bytes.

- **In the desktop app,** on the first screen choose **Host a server**, then **Restore
  from a backup instead**, pick the archive and enter the recovery phrase. The app checks
  the phrase against the archive's owner before anything runs, then installs Paracord on
  this computer, restores the key and the data, starts the server, saves a new recovery
  copy under the same phrase, and asks you to sign in. The phrase never leaves the
  computer. It refuses an archive with no recovery copy, a phrase that is not the
  owner's, and a computer that already has a Paracord server's data.
- **By hand,** write a config that has `[at_rest] enabled = true` and the key source you
  want on the new computer (`key_source = "file"` with a `key_file` path that does not
  exist yet is the simplest). Then turn the phrase into the escrow key and give that to
  the restore on standard input:

  ```bash
  paracord-server escrow-key --archive /srv/backups/paracord-backup.tar.gz \
    | paracord-server -c /srv/paracord/paracord.toml restore-backup \
        --archive /srv/backups/paracord-backup.tar.gz \
        --output-dir /srv/paracord-recovery-20261012 \
        --escrow-key-stdin
  ```

  `escrow-key` waits for the 24 words on one line (type or paste them and press Enter;
  numbering like `1.` is ignored, and the terminal shows what you type, so do this where
  nobody is watching). It checks them against the owner's public key in the archive's
  recovery copy, so a wrong phrase is named before anything is restored, and prints only
  the escrow key. `restore-backup` unwraps the storage key from the archive, stores it in
  the configured source, and then restores as described below. It refuses a wrong escrow
  key, an archive with no recovery copy ("made before the owner saved one"), and a source
  that already holds a *different* key (it never replaces one). Neither the phrase nor the
  key ever appears on a command line, in the process list or in the shell history.

  A server restored by hand has no recovery copy of its own until the owner saves one
  again. Sign in as the owner and call `POST /api/v1/admin/storage-key/escrow` with
  the body `paracord-server escrow-key --json --instance-id <[host] instance_id of the
  new config>` prints (`{"wrapping_key": …, "owner_public_key": …}`; the owner's
  *current* phrase on standard input). The server refuses a phrase that is not the
  owner's current one (409 `escrow_owner_mismatch`): if the owner used "Start over"
  after this backup's recovery copy was made, the old phrase opened the backup but
  only the new phrase can protect the restored key. Backups made after that carry it
  again.

An archive from before the owner saved a recovery copy has none, and cannot be restored
without the original key.

## Prepare PostgreSQL recovery

Install `pg_restore` compatible with the dump's `pg_dump` version. Create a
separate empty database with a dedicated recovery identity. Keep it isolated:
no Paracord instances or other clients may connect during preparation. Use a
trusted archive and a database identity with only the permissions needed for
that recovery database.

For example, using your configured PostgreSQL administration connection:

```bash
createdb --owner=paracord_recovery paracord_recovery_20260912
export PARACORD_RECOVERY_DATABASE_URL='postgres://paracord_recovery@localhost/paracord_recovery_20260912'
paracord-server --config /srv/paracord/paracord.toml restore-backup \
  --archive /srv/backups/paracord-backup.tar.gz \
  --output-dir /srv/paracord-recovery-20260912 \
  --postgres-url-env PARACORD_RECOVERY_DATABASE_URL
```

Provision credentials with your deployment's secret mechanism. The target URL
is read from the named environment variable; passwords in its URL authority
are removed from `pg_restore` arguments and passed through `PGPASSWORD`.
PostgreSQL connection URLs written to the recovered config/scripts are secret
material; protect the entire recovery directory.

The CLI refuses the configured source database, a target with existing tables,
views or sequences, and a target with other connections. `pg_restore` runs with
`--single-transaction --exit-on-error --no-owner --no-privileges`, without
`--clean`. It then runs application migrations and verification on the isolated
target. This is an archive recovery tool for the same database engine. To move
from SQLite to PostgreSQL, use the separate
[migration runbook](sqlite-to-postgres-migration.md).

## Review evidence and activate

A successful preparation produces:

| File | Purpose |
| --- | --- |
| `verification.json` | Archive SHA-256, database engine, fresh history epoch, application table counts, repaired tail count, verified attachment/encrypted-secret counts, copied media-file count |
| `paracord.toml` | Recovered configuration, published only after successful preparation |
| `activate.sh`, `activate.ps1` | Launch commands with the recovery database/storage and encryption-setting environment overrides |
| `ACTIVATE.md` | Cutover and rollback checklist |
| `keys/` | Validated TLS and federation material copied from the original deployment, when enabled |
| `archive/`, `media/` | Extracted input and separate recovered media tree |

Verification checks every attachment referenced by the database for existence
and stored size, verifies its content hash when recorded, and authenticates
at-rest encrypted attachments, MFA secrets and webhook secrets. When file
encryption is enabled with plaintext fallback disabled, verified legacy
plaintext attachments are encrypted in the staged copy before activation;
the source media is retained. It copies the
remaining media tree but does not prove that every media reference in every
application feature is recoverable. Attachment verification currently supports
files up to 1 GiB each. Archive extraction and external-media copying each have
a 64 GiB default limit; use `--max-unpacked-bytes` for larger trusted backups.
Extraction rejects unsafe paths, links, special files, duplicate entries,
oversized manifests and corrupted gzip streams.

After migrations, recovery recomputes each channel's last surviving message and
rotates the database history UUID in one transaction. It retains message
revisions and read cursors. The new history identity lets reconnecting clients
distinguish restored history from a continuation of their previous database.
Ordinary server restarts preserve the database's history UUID.

1. Read `verification.json` and `ACTIVATE.md`. Keep the original archive,
   config, environment and database/media untouched until cutover is validated.
2. Stop **all** Paracord instances connected to the old database. Prevent a
   service supervisor from restarting them with the old configuration.
3. Supply the original at-rest master key if enabled. Launch the generated
   script with `sh /srv/paracord-recovery-20260912/activate.sh` on Unix or
   `powershell -File .../activate.ps1` on Windows. Alternatively install the
   generated config and its environment overrides into the service definition.
   Retained database/storage overrides from the old service must be replaced.
4. Reconnect clients and verify sign-in, spaces, channel history, read state and
   an attachment. Client vault/session backups are still needed for end-to-end
   encrypted DM history; server backups and identity recovery words alone do
   not recreate those session keys.
5. Reconfigure certificate renewal before the retained certificate expires.
   Recovery validates and copies existing TLS material, but disables ACME jobs
   so their paths cannot collide with the retained installation. The scripts
   retain the working directory and executable used during preparation.

On Unix the new recovery directory is private (0700) and secret config/script
files are 0600. On Windows prepare under a directory restricted to the service
identity and administrators, and preserve that access control at cutover.
Do not move the recovery directory without updating its absolute paths.

## Failed preparation and rollback

A failed preparation exits unsuccessfully and does not publish an activation
config. `RESTORE_FAILED.txt` identifies failed staging where possible; scripts
also refuse a missing config or this failure marker. The original archive and
configured database/media are retained. A failed PostgreSQL preparation can
leave the **isolated target** populated or migrated; it is not safe to assume
that every preparation phase rolls back as one transaction. Keep the failure
report, discard that staging directory and its dedicated database, then retry
with a new directory and new empty database. Never point a retry at live data.

To roll back a cutover, stop the recovered generation and restart the old
service using its retained original config, environment and database/media.
New writes after cutover remain in the recovered generation; reconcile them
before choosing an older history again. Do not operate both generations as
writers for the same service identity.

`scripts/restore-db.sh` is a Unix wrapper for this CLI and accepts the original
config, Paracord archive, new directory, and optional restore arguments. It no
longer runs an in-place raw PostgreSQL restore.
