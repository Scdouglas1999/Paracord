import { describe, expect, it } from 'vitest';

import type { HostStatus, Reachability } from '../../api/generated/HostStatus';
import {
  ESCROW_COPY,
  UPDATE_COPY,
  backupView,
  hostSettingsView,
  reachIsSettling,
  reachView,
  removeConfirmed,
  serviceActions,
  serviceView,
  storageView,
} from './settingsView';
import type { HostInfo } from './types';

const NOW = Date.parse('2026-10-12T20:30:00Z');

function info(over: Partial<HostInfo> = {}): HostInfo {
  return {
    enabled: true,
    port: 8443,
    autostart: true,
    installed_version: '3.5.0',
    completed_steps: [],
    service: { state: 'running', enabled: true, exit_code: null },
    service_error: null,
    home_url: 'https://127.0.0.1:8443',
    storage_key_problem: null,
    update_failure: null,
    held_version: null,
    ...over,
  };
}

function reach(over: Partial<Reachability> = {}): Reachability {
  return {
    state: 'open',
    method: 'upnp',
    external_ip: '73.162.4.19',
    gateway_ip: '192.168.1.1',
    lan_ip: '192.168.1.28',
    port: 8443,
    lease_expires_at: null,
    next_retry_at: null,
    last_error: null,
    confirmed_at: null,
    ...over,
  };
}

function status(over: Partial<HostStatus> = {}): HostStatus {
  return {
    version: '3.5.1',
    started_at: '2026-10-12T20:00:00Z',
    setup_required: false,
    storage: { enabled: true, sqlite_encrypted: true, files_encrypted: true, key_source: 'keychain', protection: 'login', escrowed: true },
    reachability: reach(),
    backups: { enabled: true, interval_seconds: 86400, keep: 14, last_backup_at: '2026-10-12T18:30:00Z', last_error: null },
    tls: { fingerprint_sha256: 'ab'.repeat(32), self_signed: true },
    ...over,
  };
}

describe('serviceView (spec 2.9 status words)', () => {
  it('running, starting, stopped', () => {
    expect(serviceView(info(), null, null)).toMatchObject({ kind: 'running', label: 'Running', tone: 'ok' });
    expect(serviceView(info({ service: { state: 'starting', enabled: true, exit_code: null } }), null, null).label).toBe('Starting');
    const stopped = serviceView(info({ service: { state: 'stopped', enabled: true, exit_code: null } }), null, null);
    expect(stopped).toMatchObject({ kind: 'stopped', label: 'Stopped', tone: 'warn' });
    expect(stopped.reason).toMatch(/until it starts again/);
  });

  it('a pressed Start or Stop wins over the last reported state', () => {
    expect(serviceView(info(), 'stop', null).label).toBe('Stopping');
    expect(serviceView(info({ service: { state: 'stopped', enabled: true, exit_code: null } }), 'start', null).label).toBe('Starting');
  });

  it("can't start: a port another program holds is named (spec 2.10)", () => {
    const view = serviceView(
      info({ service: { state: 'stopped', enabled: true, exit_code: null }, port_problem: 'Port 8443 is in use by another program.' }),
      null,
      null,
    );
    expect(view).toMatchObject({ kind: 'cant_start', label: "Can't start", reason: 'Port 8443 is in use by another program.' });
    // A running server holds its own port; that is never a problem.
    expect(
      serviceView(info({ service: { state: 'running', enabled: true, exit_code: null }, port_problem: 'Port 8443 is in use by another program.' }), null, null).kind,
    ).toBe('running');
  });

  it("can't start: the storage key, the start error, the exit code, an unregistered service", () => {
    const key = serviceView(
      info({ service: { state: 'failed', enabled: true, exit_code: 78 }, storage_key_problem: 'the system keychain is locked' }),
      null,
      'ignored',
    );
    expect(key).toMatchObject({ kind: 'cant_start', label: "Can't start", tone: 'fail' });
    expect(key.reason).toBe("It can't open its storage key: the system keychain is locked.");

    expect(serviceView(info({ service: { state: 'failed', enabled: true, exit_code: 1 } }), null, 'Port 8443 is in use by another program').reason).toBe(
      'Port 8443 is in use by another program.',
    );
    expect(serviceView(info({ service: { state: 'failed', enabled: true, exit_code: 1 } }), null, null).reason).toMatch(/exit code 1/);
    // A Start that failed leaves the unit stopped: still "Can't start", with why.
    expect(serviceView(info({ service: { state: 'stopped', enabled: true, exit_code: null } }), null, "didn't answer within 30 s").label).toBe("Can't start");
    expect(serviceView(info({ service: { state: 'not_installed', enabled: false, exit_code: null } }), null, null).reason).toMatch(/isn't registered/);
  });

  it('says so when the service manager could not be asked', () => {
    const v = serviceView(info({ service: null, service_error: 'systemctl: Failed to connect to bus' }), null, null);
    expect(v).toMatchObject({ kind: 'unknown', tone: 'fail' });
    expect(v.reason).toContain('Failed to connect to bus.');
  });

  it('offers Start only when not running and Stop only when running', () => {
    expect(serviceActions(serviceView(info(), null, null))).toEqual({ start: false, stop: true });
    expect(serviceActions(serviceView(info({ service: { state: 'stopped', enabled: true, exit_code: null } }), null, null))).toEqual({ start: true, stop: false });
    expect(serviceActions(serviceView(info(), 'start', null))).toEqual({ start: false, stop: false });
  });
});

describe('reachView (spec 5.4, Settings column)', () => {
  it('open: the router copy, plus the outside connection when one was seen', () => {
    expect(reachView(reach(), NOW)).toMatchObject({
      tone: 'ok',
      text: 'Your router opened the way. Friends can reach you at 73.162.4.19.',
      note: null,
      chips: [],
      recheck: true,
    });
    expect(reachView(reach({ confirmed_at: '2026-10-12T20:25:00Z' }), NOW).note).toBe('A friend connected from outside 5 minutes ago.');
  });

  it('direct names the port', () => {
    expect(reachView(reach({ state: 'direct' }), NOW).text).toBe(
      'This computer has its own public address (73.162.4.19). Friends can reach it if your firewall allows port 8443.',
    );
  });

  it('refused and no answer: setup copy, "checks again every minute", Show me how + Try again', () => {
    const refused = reachView(reach({ state: 'refused', external_ip: null }), NOW);
    expect(refused).toMatchObject({
      tone: 'warn',
      text: "Your router didn't allow it, so for now only people on your home network can join.",
      note: 'Paracord checks again every minute.',
      chips: ['show_me_how', 'try_again'],
      sheet: 'refused',
      recheck: false,
    });
    const silent = reachView(reach({ state: 'no_answer', external_ip: null }), NOW);
    expect(silent.text).toBe("Your router didn't answer, so for now only people on your home network can join.");
    expect(silent.sheet).toBe('no_answer');
  });

  it('shared address: What can I do?; firewall: Allow', () => {
    expect(reachView(reach({ state: 'shared_address' }), NOW).chips).toEqual(['what_can_i_do']);
    expect(reachView(reach({ state: 'firewall_blocked' }), NOW)).toMatchObject({ text: 'Windows Firewall is blocking friends.', chips: ['allow'] });
  });

  it('asking: the row 4 line, no chips, and the page reads again', () => {
    const asking = reach({ state: 'asking', external_ip: null });
    expect(reachView(asking, NOW)).toMatchObject({ tone: 'plain', text: 'Asking your router to open a port.', chips: [] });
    expect(reachIsSettling(asking)).toBe(true);
    expect(reachIsSettling(reach())).toBe(false);
  });

  it('never says friends can reach you without open or direct', () => {
    for (const state of ['refused', 'no_answer', 'shared_address', 'firewall_blocked', 'off', 'asking'] as const) {
      expect(reachView(reach({ state }), NOW).text).not.toMatch(/Friends can reach/);
    }
  });

  it('names the public address (router or STUN) with what still has to change', () => {
    const silent = reachView(reach({ state: 'no_answer', external_ip: null, observed_ip: '198.51.100.4' }), NOW);
    expect(silent.tone).toBe('warn');
    expect(silent.text).toBe(
      "Your router didn't answer. Once port 8443 is forwarded on your router, friends will reach you at 198.51.100.4; people on your home network can join now.",
    );
    expect(silent.chips).toEqual(['show_me_how', 'try_again']);
    expect(silent.linkHint).toBe(
      "Invite links use your public address, 198.51.100.4. To give out a domain name instead, set public_url under [server] in the server's paracord.toml and restart it.",
    );
    // A carrier-grade NAT address is never offered as the way in.
    const cgnat = reachView(reach({ state: 'no_answer', external_ip: null, observed_ip: '100.64.2.2' }), NOW);
    expect(cgnat.text).toBe("Your router didn't answer, so for now only people on your home network can join.");
    expect(cgnat.linkHint).toMatch(/^Invite links use your address on the home network\./);
  });

  it('a connection seen from outside confirms a port forwarded by hand', () => {
    const view = reachView(
      reach({ state: 'no_answer', external_ip: null, observed_ip: '198.51.100.4', confirmed_at: '2026-10-12T20:25:00Z' }),
      NOW,
    );
    expect(view).toMatchObject({ tone: 'ok', text: 'Friends can reach you at 198.51.100.4.', chips: [], recheck: true });
    expect(view.note).toMatch(/^A friend connected from outside 5 minutes ago\.$/);
  });
});

describe('storageView (spec 4.6, 4.7)', () => {
  it('keychain + escrowed', () => {
    expect(storageView(status().storage)).toEqual({
      tone: 'ok',
      text: "Encrypted on this computer's disk. The key lives in your system keychain.",
      escrow: { tone: 'ok', text: ESCROW_COPY.saved, canSave: false },
    });
  });

  it('no recovery copy yet: a warning with Save it now', () => {
    expect(storageView({ ...status().storage, escrowed: false }).escrow).toEqual({ tone: 'warn', text: ESCROW_COPY.missing, canSave: true });
  });

  it('same disk says what it does not protect', () => {
    expect(storageView({ ...status().storage, key_source: 'file', protection: 'same_disk' }).text).toMatch(/not a stolen disk/);
  });

  it('unencrypted: a warning and no key to keep', () => {
    expect(storageView({ ...status().storage, enabled: false, sqlite_encrypted: false, files_encrypted: false })).toEqual({
      tone: 'warn',
      text: "Not encrypted on this server's disk.",
      escrow: null,
    });
  });
});

describe('backupView (spec 2.9)', () => {
  it('last backup, relative', () => {
    expect(backupView(status().backups, NOW)).toEqual({ tone: 'ok', text: 'Last backup about 2 hours ago.', note: 'Daily. Kept on this computer for 14 days.' });
  });
  it('none yet, failed, off', () => {
    expect(backupView({ ...status().backups, last_backup_at: null }, NOW).text).toBe('No backup yet.');
    expect(backupView({ ...status().backups, last_error: 'disk full' }, NOW)).toMatchObject({ tone: 'fail', text: "The last backup didn't finish: disk full." });
    expect(backupView({ ...status().backups, enabled: false }, NOW)).toMatchObject({ tone: 'warn', note: expect.stringMatching(/Daily backups are off/) });
  });
});

describe('hostSettingsView', () => {
  it('running and answering: every live row, the running version', () => {
    const v = hostSettingsView({ info: info(), status: status(), statusError: null, pending: null, startError: null, now: NOW });
    expect(v.service.label).toBe('Running');
    expect(v.facts).toBe('Version 3.5.1 · port 8443');
    expect(v.live?.fingerprint).toBe('ab'.repeat(32));
    expect(v.liveMissing).toBeNull();
    expect(v.update).toBeNull();
  });

  it('stopped: no live rows, the installed version, and why', () => {
    const v = hostSettingsView({
      info: info({ service: { state: 'stopped', enabled: true, exit_code: null } }),
      status: status(),
      statusError: null,
      pending: null,
      startError: null,
      now: NOW,
    });
    expect(v.live).toBeNull();
    expect(v.liveMissing).toBe('Who can reach it, its words, its storage and its backups show here while it runs.');
    expect(v.facts).toBe('Version 3.5.1 · port 8443');
  });

  it('running but the status call failed: says so', () => {
    const v = hostSettingsView({ info: info(), status: null, statusError: 'connection refused', pending: null, startError: null, now: NOW });
    expect(v.live).toBeNull();
    expect(v.liveMissing).toBe("It's running but didn't answer: connection refused.");
    expect(v.facts).toBe('Version 3.5.0 · port 8443');
  });

  it('an update that did not come up, and a held version', () => {
    const failure = { from_version: '3.4.0', to_version: '3.5.0', backup_name: 'b.tar.gz', failure: 'no /health' };
    expect(hostSettingsView({ info: info({ update_failure: failure }), status: null, statusError: null, pending: null, startError: null, now: NOW }).update).toEqual({
      kind: 'failed',
      text: UPDATE_COPY.failed,
    });
    expect(hostSettingsView({ info: info({ held_version: '3.5.0' }), status: null, statusError: null, pending: null, startError: null, now: NOW }).update?.text).toBe(
      "Version 3.5.0 didn't start here, so it won't be installed again until a newer version comes out.",
    );
  });
});

describe('removeConfirmed (spec 2.9: deleting data needs the name typed)', () => {
  it('keeping the data needs nothing typed', () => {
    expect(removeConfirmed(false, '', 'Sam’s Crew')).toBe(true);
  });
  it('deleting needs the exact name', () => {
    expect(removeConfirmed(true, '', 'Crew')).toBe(false);
    expect(removeConfirmed(true, 'Crw', 'Crew')).toBe(false);
    expect(removeConfirmed(true, '  crew ', 'Crew')).toBe(true);
    expect(removeConfirmed(true, '', '')).toBe(false);
  });
});
