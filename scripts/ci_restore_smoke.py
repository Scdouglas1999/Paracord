#!/usr/bin/env python3
"""Verify isolated archive recovery using an already-built paracord-server.

PARACORD_RESTORE_BINARY must point to the current server. SQLite always runs;
PARACORD_TEST_POSTGRES_URL enables isolated PostgreSQL source/target cases.
No production database is replaced and no Cargo build is started by this script.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
import tomllib
import uuid
from urllib.parse import urlsplit, urlunsplit, unquote

import ci_pg_migrator_smoke as importer

ROOT = Path(__file__).resolve().parents[1]


def invoke(binary: Path, config: Path, archive: Path, output: Path, env: dict, *extra: str, error: str | None = None) -> None:
    existing_config = (output / 'paracord.toml').read_bytes() if (output / 'paracord.toml').exists() else None
    result = subprocess.run([str(binary), '--config', str(config), 'restore-backup', '--archive', str(archive), '--output-dir', str(output), *extra], env=env, cwd=ROOT, text=True, capture_output=True)
    if error is None:
        if result.returncode: raise RuntimeError(result.stdout + result.stderr)
        assert (output / 'paracord.toml').is_file()
        assert (output / 'activate.sh').is_file()
        subprocess.run(['sh', '-n', str(output / 'activate.sh')], check=True)
    else:
        assert result.returncode != 0, 'invalid recovery unexpectedly succeeded'
        assert error in result.stdout + result.stderr, result.stdout + result.stderr
        if existing_config is None:
            assert not (output / 'paracord.toml').exists(), 'failed recovery published activation config'
        else:
            assert (output / 'paracord.toml').read_bytes() == existing_config, 'refusal modified existing recovery'


def config_file(path: Path, engine: str, url: str, uploads: Path, files: Path) -> None:
    # JSON strings are compatible TOML basic strings for these fixture values.
    path.write_text(f'''[server]
bind_address = "127.0.0.1:0"
[database]
engine = {json.dumps(engine)}
url = {json.dumps(url)}
[auth]
jwt_secret = "restore-smoke-only-secret-with-sufficient-length"
[storage]
storage_type = "local"
path = {json.dumps(str(uploads))}
[media]
storage_path = {json.dumps(str(files))}
[tls]
enabled = false
[backup]
auto_backup_enabled = false
''')
    path.chmod(0o600)


def archive_file(path: Path, payload: Path, postgres: bool, media: Path, include_media: bool = True) -> None:
    manifest = {'version': 1, 'created_at': '2026-09-12T00:00:00Z', 'server_version': 'fixture', 'includes_media': include_media, 'db_filename': 'paracord.pgdump' if postgres else 'paracord.db'}
    manifest_path = path.parent / f'{path.stem}-manifest.json'
    manifest_path.write_text(json.dumps(manifest))
    with tarfile.open(path, 'w:gz') as archive:
        archive.add(manifest_path, arcname='manifest.json')
        archive.add(payload, arcname=manifest['db_filename'])
        if include_media: archive.add(media, arcname='media')


def seed_sqlite(path: Path, media: Path) -> None:
    importer.apply_sqlite_migrations(path)
    importer.seed_application_fixture(path, uuid.uuid4().hex)
    plaintext = b'restored payload'
    (media / 'uploads/attachments').mkdir(parents=True)
    (media / 'files').mkdir()
    (media / 'uploads/attachments/600.bin').write_bytes(plaintext)
    with sqlite3.connect(path) as conn:
        conn.execute('CREATE TABLE _sqlx_migrations(version BIGINT PRIMARY KEY, description TEXT NOT NULL, installed_on TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, success BOOLEAN NOT NULL, checksum BLOB NOT NULL, execution_time BIGINT NOT NULL)')
        for migration in sorted(importer.SQLITE_MIGRATIONS_DIR.glob('*.sql')):
            version, description = migration.stem.split('_', 1)
            checksum = hashlib.sha384(migration.read_bytes().replace(b'\r\n', b'\n')).digest()
            conn.execute('INSERT INTO _sqlx_migrations(version, description, success, checksum, execution_time) VALUES(?, ?, TRUE, ?, 0)', (int(version), description.replace('_', ' '), checksum))
        conn.execute("INSERT INTO attachments(id, message_id, filename, size, url, content_hash) VALUES(600,401,'payload.bin',?,'/api/v1/attachments/600',?)", (len(plaintext), hashlib.sha256(plaintext).hexdigest()))


def pg_url(base: str, database: str) -> str:
    parts = urlsplit(base)
    return urlunsplit((parts.scheme, parts.netloc, '/' + database, parts.query, parts.fragment))


def main() -> None:
    supplied = os.environ.get('PARACORD_RESTORE_BINARY')
    if not supplied: raise RuntimeError('Set PARACORD_RESTORE_BINARY to the freshly built server; this script does not build')
    binary = Path(supplied).resolve()
    if not binary.is_file(): raise RuntimeError('server binary is missing')
    # Do not inherit deployment overrides that could retarget fixture operations.
    env = {key: value for key, value in os.environ.items() if not key.startswith('PARACORD_')}
    with tempfile.TemporaryDirectory(prefix='paracord-restore-smoke-') as work:
        root = Path(work)
        source = root / 'source.db'
        media = root / 'original-media'
        seed_sqlite(source, media)
        config = root / 'sqlite.toml'
        config_file(config, 'sqlite', f'sqlite://{source}?mode=rw', media / 'uploads', media / 'files')
        original_config = config.read_bytes()
        archive = root / 'sqlite.tar.gz'
        archive_file(archive, source, False, media)
        with sqlite3.connect(source) as conn:
            source_epoch = conn.execute("SELECT value FROM server_settings WHERE key='database_history_epoch'").fetchone()[0]
            conn.execute("UPDATE messages SET content='post-backup mutation' WHERE id=401")
        recovered = root / 'sqlite-recovered%2Fisolated'
        invoke(binary, config, archive, recovered, env)
        report = json.loads((recovered / 'verification.json').read_text())
        assert report['database_history_epoch'] != source_epoch
        assert report['repaired_channel_tails'] == 2
        assert report['verified_attachments'] == 1
        with sqlite3.connect(recovered / 'paracord.db') as conn:
            assert conn.execute('SELECT id,last_message_id,message_revision FROM channels ORDER BY id').fetchall() == [(300,401,7),(301,None,8),(302,450,9)]
            assert conn.execute('SELECT content FROM messages WHERE id=401').fetchone()[0] == 'Latest survivor'
            assert conn.execute('SELECT channel_id,last_message_id,mention_count FROM read_states ORDER BY channel_id').fetchall() == [(300,399,3),(301,500,2),(302,449,0)]
        with sqlite3.connect(source) as conn:
            assert conn.execute('SELECT content FROM messages WHERE id=401').fetchone()[0] == 'post-backup mutation'
            assert conn.execute("SELECT value FROM server_settings WHERE key='database_history_epoch'").fetchone()[0] == source_epoch
        assert config.read_bytes() == original_config
        # A script left behind by interrupted preparation must not generate a
        # fresh default config or open a database merely because it exists.
        published = recovered / 'paracord.toml'
        saved_config = published.read_bytes()
        published.unlink()
        try:
            refused = subprocess.run(['sh', str(recovered / 'activate.sh')], env=env, text=True, capture_output=True, timeout=5)
            assert refused.returncode != 0 and 'incomplete' in refused.stderr
            assert not published.exists()
        finally:
            published.write_bytes(saved_config)
        marker = recovered / 'RESTORE_FAILED.txt'
        marker.write_text('injected failure marker')
        try:
            refused = subprocess.run(['sh', str(recovered / 'activate.sh')], env=env, text=True, capture_output=True, timeout=5)
            assert refused.returncode != 0 and 'incomplete' in refused.stderr
        finally:
            marker.unlink()

        # Preserve actual external identity files through CLI configuration
        # generation, and reject missing identity material before staging.
        openssl = shutil.which('openssl')
        if not openssl: raise RuntimeError('openssl is required for the TLS recovery fixture')
        certificate, private_key, signing_key = [root / name for name in ('tls-cert.pem', 'tls-key.pem', 'federation-key.hex')]
        subprocess.run([openssl, 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', '/CN=localhost', '-days', '1', '-keyout', str(private_key), '-out', str(certificate)], check=True, capture_output=True)
        signing_key.write_text('12' * 32)
        identity_config = root / 'identity.toml'
        identity_text = config.read_text().replace('[tls]\nenabled = false', f'[tls]\nenabled = true\ncert_path = {json.dumps(str(certificate))}\nkey_path = {json.dumps(str(private_key))}')
        identity_text += f'\n[federation]\nenabled = true\nsigning_key_path = {json.dumps(str(signing_key))}\n'
        identity_config.write_text(identity_text)
        identity_output = root / 'identity-recovered'
        invoke(binary, identity_config, archive, identity_output, env)
        for original, copied in [(certificate, 'tls-cert.pem'), (private_key, 'tls-key.pem'), (signing_key, 'federation-signing-key.hex')]:
            assert (identity_output / 'keys' / copied).read_bytes() == original.read_bytes()
        parsed = tomllib.loads((identity_output / 'paracord.toml').read_text())
        assert parsed['auth']['jwt_secret'] == 'restore-smoke-only-secret-with-sufficient-length'
        assert parsed['tls']['cert_path'] == str(identity_output / 'keys/tls-cert.pem')
        assert parsed['tls']['auto_generate'] is False
        assert parsed['tls']['acme']['enabled'] is False
        assert parsed['tls']['acme']['auto_renew'] is False
        key_bytes = signing_key.read_bytes()
        signing_key.unlink()
        invoke(binary, identity_config, archive, root / 'missing-federation-key', env, error='federation signing key is missing')
        signing_key.write_bytes(key_bytes)
        private_key.unlink()
        invoke(binary, identity_config, archive, root / 'missing-tls-key', env, error='TLS private key is missing')
        invoke(binary, root / 'absent-config.toml', archive, root / 'missing-config', env, error='existing recovery configuration')
        assert not (root / 'absent-config.toml').exists()
        invoke(binary, config, archive, recovered, env, error='output directory must be new')
        database_only = root / 'database-only.tar.gz'
        archive_file(database_only, source, False, media, False)
        invoke(binary, config, database_only, root / 'missing-media', env, error='database-only archive requires --media-dir')
        invoke(binary, config, database_only, root / 'external-media', env, '--media-dir', str(media))
        invoke(binary, config, archive, root / 'too-large', env, '--max-unpacked-bytes', '64', error='byte limit')
        print('PASS SQLite archive recovery, source preservation, epoch/tail/read state, media, TLS/federation/config retention, activation guards and failure refusal', flush=True)

        postgres_url = os.environ.get('PARACORD_TEST_POSTGRES_URL')
        if not postgres_url:
            print('SKIP PostgreSQL: PARACORD_TEST_POSTGRES_URL is unset', flush=True)
            return
        import psycopg2
        names = [f'paracord_restore_{uuid.uuid4().hex[:16]}_{suffix}' for suffix in ('source','target','failure')]
        admin = psycopg2.connect(postgres_url)
        admin.autocommit = True
        try:
            with admin.cursor() as cur:
                for name in names: cur.execute(f'CREATE DATABASE "{name}"')
            source_url, target_url, failure_url = [pg_url(postgres_url, name) for name in names]
            result = subprocess.run([str(binary), 'migrate-to-postgres', '--source', f'sqlite://{source}', '--target', source_url], env=env, cwd=ROOT, text=True, capture_output=True)
            if result.returncode: raise RuntimeError(result.stdout + result.stderr)
            pg_config = root / 'postgres.toml'
            config_file(pg_config, 'postgres', source_url, media / 'uploads', media / 'files')
            dump = root / 'source.pgdump'
            parts = urlsplit(source_url)
            host = parts.hostname or ''
            if ':' in host: host = '[' + host + ']'
            if parts.port: host += ':' + str(parts.port)
            if parts.username: host = parts.username + '@' + host
            sanitized = urlunsplit((parts.scheme, host, parts.path, parts.query, parts.fragment))
            dump_env = dict(env)
            if parts.password: dump_env['PGPASSWORD'] = unquote(parts.password)
            subprocess.run(['pg_dump', '--format=custom', '--no-owner', '--no-privileges', '--file', str(dump), '--dbname', sanitized], env=dump_env, check=True)
            pg_archive = root / 'postgres.tar.gz'
            archive_file(pg_archive, dump, True, media)
            with psycopg2.connect(source_url) as conn:
                with conn.cursor() as cur:
                    cur.execute("SELECT value FROM server_settings WHERE key='database_history_epoch'")
                    pg_source_epoch = cur.fetchone()[0]
            restore_env = {**env, 'PARACORD_RECOVERY_TEST_URL': target_url}
            pg_recovered = root / 'postgres-recovered'
            invoke(binary, pg_config, pg_archive, pg_recovered, restore_env, '--postgres-url-env', 'PARACORD_RECOVERY_TEST_URL')
            pg_report = json.loads((pg_recovered / 'verification.json').read_text())
            assert pg_report['database_engine'] == 'postgres'
            assert pg_report['database_history_epoch'] != pg_source_epoch
            assert pg_report['verified_attachments'] == 1
            with psycopg2.connect(target_url) as conn:
                with conn.cursor() as cur:
                    cur.execute('SELECT id,last_message_id FROM channels ORDER BY id')
                    assert cur.fetchall() == [(300,401),(301,None),(302,450)]
            invoke(binary, pg_config, pg_archive, root / 'nonempty-target', restore_env, '--postgres-url-env', 'PARACORD_RECOVERY_TEST_URL', error='not empty')
            same_env = {**env, 'PARACORD_RECOVERY_TEST_URL': source_url}
            invoke(binary, pg_config, pg_archive, root / 'live-target', same_env, '--postgres-url-env', 'PARACORD_RECOVERY_TEST_URL', error='configured database')
            # A failure after pg_restore has committed must retain the isolated
            # staging DB, roll back tail/epoch maintenance, and publish no config.
            with psycopg2.connect(source_url) as conn:
                with conn.cursor() as cur:
                    cur.execute("UPDATE channels SET last_message_id=499 WHERE id=300")
                    cur.execute("""
                        CREATE FUNCTION ci_restore_epoch_failure() RETURNS trigger LANGUAGE plpgsql AS $$
                        BEGIN
                            IF NEW.key = 'database_history_epoch' THEN
                                RAISE EXCEPTION 'ci injected restore epoch failure';
                            END IF;
                            RETURN NEW;
                        END; $$;
                        CREATE TRIGGER ci_restore_epoch_failure BEFORE UPDATE OF value ON server_settings
                            FOR EACH ROW EXECUTE FUNCTION ci_restore_epoch_failure();
                    """)
            failure_dump = root / 'failure.pgdump'
            subprocess.run(['pg_dump', '--format=custom', '--no-owner', '--no-privileges', '--file', str(failure_dump), '--dbname', sanitized], env=dump_env, check=True)
            failure_archive = root / 'failure.tar.gz'
            archive_file(failure_archive, failure_dump, True, media)
            archive_hash = hashlib.sha256(failure_archive.read_bytes()).hexdigest()
            failed_output = root / 'failed-postgres-recovery'
            failure_env = {**env, 'PARACORD_RECOVERY_TEST_URL': failure_url}
            invoke(binary, pg_config, failure_archive, failed_output, failure_env, '--postgres-url-env', 'PARACORD_RECOVERY_TEST_URL', error='ci injected restore epoch failure')
            assert (failed_output / 'RESTORE_FAILED.txt').is_file()
            assert not (failed_output / 'verification.json').exists()
            for retained_url in (source_url, failure_url):
                with psycopg2.connect(retained_url) as conn:
                    with conn.cursor() as cur:
                        cur.execute('SELECT last_message_id FROM channels WHERE id=300')
                        assert cur.fetchone()[0] == 499
                        cur.execute("SELECT value FROM server_settings WHERE key='database_history_epoch'")
                        assert cur.fetchone()[0] == pg_source_epoch
                        cur.execute('SELECT COUNT(*) FROM messages')
                        assert cur.fetchone()[0] == 3
            assert hashlib.sha256(failure_archive.read_bytes()).hexdigest() == archive_hash
            print('PASS PostgreSQL isolated archive recovery, nonempty/live target refusal, post-import failure rollback and retained staging/source', flush=True)
        finally:
            with admin.cursor() as cur:
                for name in names: cur.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
            admin.close()


if __name__ == '__main__':
    main()
