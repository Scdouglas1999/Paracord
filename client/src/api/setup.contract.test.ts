import { describe, expect, it } from 'vitest';

import type { HostStatus } from './generated/HostStatus';
import type { InvitePreview } from './generated/InvitePreview';
import type { KeyBackup } from './generated/KeyBackup';
import {
  isCredentialParams,
  isHostPreflight,
  isHostProgress,
  isHostStatus,
  isInvitePreview,
  isKeyBackup,
  isPasswordRequirements,
  loadValidators,
} from './contractValidators';

const kdf = { alg: 'scrypt', log_n: 17, r: 8, p: 1 };

const status: HostStatus = {
  version: '3.4.0',
  started_at: '2026-10-12T12:00:00+00:00',
  setup_required: false,
  storage: {
    enabled: true, sqlite_encrypted: true, files_encrypted: true,
    key_source: 'keychain', protection: 'login', escrowed: true,
  },
  reachability: {
    state: 'open', method: 'upnp', external_ip: '203.0.113.1', gateway_ip: '192.168.1.1',
    lan_ip: '192.168.1.28', port: 8443, lease_expires_at: null, next_retry_at: null,
    last_error: null, confirmed_at: null,
  },
  backups: { enabled: true, interval_seconds: 86400, keep: 14, last_backup_at: null, last_error: null },
  tls: { fingerprint_sha256: 'ab'.repeat(32), self_signed: true },
};

describe('first-run setup contracts', () => {
  it('reads credential params as version 1 or a complete version 2', async () => {
    await loadValidators();
    expect(isCredentialParams({ version: 1 })).toBe(true);
    expect(isCredentialParams({ version: 2, kdf, salt: 's', epoch: 1 })).toBe(true);
    // Weaker parameters still pass the contract: the client refuses them with
    // its own words (spec §3.2), not as a malformed response.
    expect(isCredentialParams({ version: 2, kdf: { ...kdf, log_n: 10 }, salt: 's', epoch: 1 })).toBe(true);
    expect(isCredentialParams({ version: 2, kdf, salt: 's' })).toBe(false);
    expect(isCredentialParams({ version: '2', kdf, salt: 's', epoch: 1 })).toBe(false);
    expect(isCredentialParams({ version: 3 })).toBe(false);
  });

  it('validates the key backup and the password requirements of old and new servers', async () => {
    await loadValidators();
    const backup: KeyBackup = {
      public_key: 'cd'.repeat(32), wrapped_key: 'w', wrap_alg: 'aes256gcm-v2', epoch: 1, recovery_confirmed: false,
    };
    expect(isKeyBackup(backup)).toBe(true);
    const { recovery_confirmed: _confirmed, ...unconfirmed } = backup;
    expect(isKeyBackup(unconfirmed)).toBe(false);
    const rules = {
      min_length: 10, max_length: 128, requires_uppercase: false, requires_lowercase: false,
      requires_digit: false, requires_symbol: false, length_unit: 'utf8_bytes',
    };
    expect(isPasswordRequirements({ ...rules, enforced_by: 'client' })).toBe(true);
    expect(isPasswordRequirements(rules)).toBe(true);
    expect(isPasswordRequirements({ ...rules, enforced_by: 'nobody' })).toBe(false);
  });

  it('validates host status with its spellings', async () => {
    await loadValidators();
    expect(isHostStatus(status)).toBe(true);
    expect(isHostStatus({ ...status, storage: { ...status.storage, key_source: 'systemd-creds', protection: 'same_disk' } })).toBe(true);
    expect(isHostStatus({ ...status, storage: { ...status.storage, key_source: 'systemd_creds' } })).toBe(false);
    expect(isHostStatus({ ...status, reachability: { ...status.reachability, state: 'shared_address' } })).toBe(true);
    expect(isHostStatus({ ...status, reachability: { ...status.reachability, state: 'reachable' } })).toBe(false);
    expect(isHostStatus({ ...status, reachability: { ...status.reachability, port: 70000 } })).toBe(false);
  });

  it('validates the preflight answer and progress events', async () => {
    await loadValidators();
    expect(isHostPreflight({ ok: true, port: 8443 })).toBe(true);
    expect(isHostPreflight({ ok: false, reason: 'no_keychain', detail: 'Secret Service: not running' })).toBe(true);
    expect(isHostPreflight({ ok: false, reason: 'no_router' })).toBe(false);
    expect(isHostProgress({ row: 4, step: 'reach', state: 'warn', code: 'refused' })).toBe(true);
    expect(isHostProgress({ row: 3, step: 'account', state: 'run' })).toBe(false);
  });

  it('accepts invite previews from older servers and the first-run card from new ones', async () => {
    await loadValidators();
    const older = { code: 'abcd1234', guild: { id: '1', name: 'Crew', icon_hash: null, member_count: 4 } };
    expect(isInvitePreview(older)).toBe(true);
    const current: InvitePreview = {
      ...older,
      guild: { ...older.guild, hue: 150, online_count: 1 },
      faces: [{ initial: 'S', hue: 150 }],
      expires_at: '2026-10-19T12:00:00+00:00',
      instance: { name: 'Crew', version: '3.4.0', credential_version: 2, registration_mode: 'invite_only', require_email: false },
    };
    expect(isInvitePreview(current)).toBe(true);
    expect(isInvitePreview({ ...current, instance: { ...current.instance!, registration_mode: 'closed' } })).toBe(false);
  });
});
