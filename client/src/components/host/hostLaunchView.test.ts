import { describe, expect, it } from 'vitest';

import type { HostInfo, HostLaunch } from '../../lib/host/types';
import { HOST_LAUNCH_COPY, hostLaunchView } from './hostLaunchView';

const info = (patch: Partial<HostInfo> = {}): HostInfo => ({
  enabled: true,
  port: 8443,
  autostart: true,
  installed_version: '3.4.0',
  completed_steps: ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow', 'reach', 'backup'],
  service: { state: 'running', enabled: true, exit_code: null },
  service_error: null,
  home_url: 'https://127.0.0.1:8443',
  storage_key_problem: null,
  update_failure: null,
  held_version: null,
  ...patch,
});

const launch = (patch: Partial<HostLaunch> = {}): HostLaunch => ({ info: info(), update: { kind: 'none' }, start_error: null, ...patch });
const idle = { kind: 'idle' } as const;

describe('the launch strip for Paracord on this computer (spec §2.8)', () => {
  it('says nothing when all is well, or off the desktop', () => {
    expect(hostLaunchView(null, idle)).toBeNull();
    expect(hostLaunchView(launch(), idle)).toBeNull();
    expect(hostLaunchView(launch({ update: { kind: 'updated', from: '3.3.0', to: '3.4.0' } }), idle)).toBeNull();
  });

  it('a failed update: the spec sentence, Show details and the restore', () => {
    const view = hostLaunchView(launch({ update: { kind: 'failed', from: '3.3.0', to: '3.4.0', detail: 'no /health in 60 s' } }), idle)!;
    expect(view.text).toBe("Paracord on this computer didn't start after the update.");
    expect(view.primary).toEqual({ action: 'rollback', label: 'Restore the backup from before the update' });
    expect(view.details).toBe(true);
    expect(view.tone).toBe('danger');
    expect(view.role).toBe('alert');
  });

  it('is said again on a later launch from host.json until the person acts', () => {
    const later = launch({ info: info({ update_failure: { from_version: '3.3.0', to_version: '3.4.0', backup_name: 'b.tar.gz', failure: 'x' } }) });
    expect(hostLaunchView(later, idle)?.id).toBe('host-update-failed');
  });

  it('while and after the restore', () => {
    const failed = launch({ update: { kind: 'failed', from: '3.3.0', to: '3.4.0', detail: 'x' } });
    expect(hostLaunchView(failed, { kind: 'running' })).toMatchObject({ text: HOST_LAUNCH_COPY.rollingBack, primary: null });
    expect(hostLaunchView(failed, { kind: 'done' })?.text).toBe(
      "Paracord on this computer is running 3.3.0 again, with the backup from before the update. 3.4.0 won't be installed again until a newer version comes out.",
    );
    const again = hostLaunchView(failed, { kind: 'failed', error: 'The restore didn\'t finish: disk full.' })!;
    expect(again.text).toBe("Restoring the backup from before the update didn't finish: The restore didn't finish: disk full.");
    expect(again.primary?.action).toBe('rollback');
  });

  it('an update that never started changed nothing, and says so', () => {
    const view = hostLaunchView(launch({ update: { kind: 'not_started', detail: "The backup before the update didn't finish." } }), idle)!;
    expect(view.text).toBe("Paracord on this computer wasn't updated, and nothing changed: The backup before the update didn't finish.");
    expect(view.tone).toBe('plain');
  });

  it('a storage key it cannot open, or a start that failed: the reason and Try again', () => {
    const key = hostLaunchView(launch({ info: info({ storage_key_problem: 'the system keychain is locked' }) }), idle)!;
    expect(key.text).toBe("Paracord on this computer can't open its storage key: the system keychain is locked.");
    expect(key.primary).toMatchObject({ action: 'start', label: 'Try again' });
    const start = hostLaunchView(launch({ start_error: "Paracord on this computer didn't start." }), idle, true)!;
    expect(start.text).toBe("Paracord on this computer didn't start: Paracord on this computer didn't start.");
    expect(start.primary).toMatchObject({ label: 'Starting…', disabled: true });
  });
});
