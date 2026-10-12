import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostProgress } from '../api/generated/HostProgress';

const listeners = new Set<(event: { payload: HostProgress }) => void>();
const invokeMock = vi.fn();
/** Scripted `host_setup_start` runs: each call emits the next batch. */
let setupRuns: HostProgress[][] = [];
let completedSteps: string[] = [];

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: HostProgress }) => void) => {
    listeners.add(handler);
    return () => listeners.delete(handler);
  }),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('../lib/tauriEnv', () => ({ isTauri: () => true }));

import { MIN_RUN_MS, useHostStore } from './hostStore';

function emit(event: HostProgress) {
  for (const listener of listeners) listener({ payload: event });
}

const rowStates = () => useHostStore.getState().rows.map((r) => r.state);

const ROWS_1_2: HostProgress[] = [
  { row: 1, step: 'install', state: 'run' },
  { row: 1, step: 'install', state: 'ok' },
  { row: 1, step: 'init', state: 'run' },
  { row: 1, step: 'init', state: 'ok' },
  { row: 1, step: 'service', state: 'run' },
  { row: 1, step: 'service', state: 'ok' },
  { row: 1, step: 'start', state: 'run' },
  { row: 1, step: 'start', state: 'ok' },
  { row: 2, step: 'storage', state: 'run' },
  { row: 2, step: 'storage', state: 'ok' },
];
const ROWS_4_5: HostProgress[] = [
  { row: 1, step: 'install', state: 'ok' },
  { row: 1, step: 'init', state: 'ok' },
  { row: 1, step: 'service', state: 'ok' },
  { row: 1, step: 'start', state: 'run' },
  { row: 1, step: 'start', state: 'ok' },
  { row: 2, step: 'storage', state: 'ok' },
  { row: 4, step: 'reach', state: 'run' },
  {
    row: 4,
    step: 'reach',
    state: 'warn',
    code: 'refused',
    detail: "Your router didn't allow it, so for now only people on your home network can join.",
  },
  { row: 5, step: 'backup', state: 'run' },
  { row: 5, step: 'backup', state: 'ok' },
];

beforeEach(() => {
  vi.useFakeTimers();
  listeners.clear();
  setupRuns = [];
  completedSteps = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (command: string) => {
    switch (command) {
      case 'host_info':
        return {
          enabled: true,
          port: 8443,
          autostart: true,
          installed_version: '3.4.0',
          completed_steps: completedSteps,
          service: null,
          service_error: null,
          home_url: 'https://127.0.0.1:8443',
          storage_key_problem: null,
          update_failure: null,
          held_version: null,
        };
      case 'host_setup_start': {
        const batch = setupRuns.shift() ?? [];
        // Events reach the window around the time the command resolves.
        setTimeout(() => batch.forEach(emit), 0);
        return undefined;
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  });
  useHostStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('hostStore setup', () => {
  it('runs rows 1-2, then the page row 3, then rows 4-5', async () => {
    setupRuns = [ROWS_1_2, ROWS_4_5];
    const account = vi.fn(async () => {
      expect(useHostStore.getState().phase).toBe('account');
      expect(rowStates()).toEqual(['ok', 'ok', 'run', 'waiting', 'waiting']);
      completedSteps = ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow'];
    });
    const done = useHostStore.getState().runSetup({ port: 8443, account });
    await vi.runAllTimersAsync();
    expect(await done).toBe('done');
    expect(account).toHaveBeenCalledOnce();
    expect(rowStates()).toEqual(['ok', 'ok', 'ok', 'warn', 'ok']);
    const row4 = useHostStore.getState().rows[3];
    expect(row4.chips).toEqual(['show_me_how', 'try_again']);
    expect(invokeMock.mock.calls.filter(([c]) => c === 'host_setup_start')).toEqual([
      ['host_setup_start', { port: 8443 }],
      ['host_setup_start', { port: 8443 }],
    ]);
    expect(listeners.size).toBe(0);
  });

  it('shows each row running for at least 300 ms', async () => {
    setupRuns = [
      [
        { row: 1, step: 'start', state: 'run' },
        { row: 1, step: 'start', state: 'ok' },
        { row: 2, step: 'storage', state: 'run' },
        { row: 2, step: 'storage', state: 'ok' },
      ],
    ];
    const done = useHostStore.getState().runSetup({ port: 8443, account: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(1);
    expect(rowStates().slice(0, 2)).toEqual(['run', 'waiting']);
    await vi.advanceTimersByTimeAsync(MIN_RUN_MS - 10);
    expect(rowStates()[0]).toBe('run');
    await vi.advanceTimersByTimeAsync(20);
    expect(rowStates()[0]).toBe('ok');
    expect(rowStates()[1]).toBe('run');
    await vi.advanceTimersByTimeAsync(MIN_RUN_MS);
    expect(rowStates().slice(0, 3)).toEqual(['ok', 'ok', 'run']);
    void done;
  });

  it('stops at a failed row and Try again resumes', async () => {
    setupRuns = [
      [
        { row: 1, step: 'install', state: 'run' },
        { row: 1, step: 'install', state: 'ok' },
        { row: 1, step: 'start', state: 'run' },
        { row: 1, step: 'start', state: 'fail', code: 'start_timeout', detail: "Paracord on this computer didn't start." },
      ],
      ROWS_1_2,
    ];
    const account = vi.fn(async () => {});
    const first = useHostStore.getState().runSetup({ port: 8443, account });
    await vi.runAllTimersAsync();
    expect(await first).toBe('failed');
    expect(account).not.toHaveBeenCalled();
    expect(useHostStore.getState().rows[0]).toMatchObject({ state: 'fail', chips: ['try_again', 'show_details'] });

    setupRuns.push([]);
    const again = useHostStore.getState().retry();
    await vi.runAllTimersAsync();
    expect(await again).toBe('done');
    expect(account).toHaveBeenCalledOnce();
    expect(rowStates().slice(0, 3)).toEqual(['ok', 'ok', 'ok']);
  });

  it('a failed account row stops before rows 4 and 5', async () => {
    setupRuns = [ROWS_1_2];
    const done = useHostStore.getState().runSetup({
      port: 8443,
      account: async () => {
        throw new Error('That username is taken.');
      },
    });
    await vi.runAllTimersAsync();
    expect(await done).toBe('failed');
    expect(useHostStore.getState().rows[2]).toMatchObject({ state: 'fail', detail: 'That username is taken.' });
    expect(invokeMock.mock.calls.filter(([c]) => c === 'host_setup_start')).toHaveLength(1);
  });

  it('a resumed setup whose account is done goes straight to rows 4 and 5', async () => {
    completedSteps = ['install', 'init', 'service', 'start', 'storage', 'claim', 'escrow'];
    setupRuns = [ROWS_4_5];
    const account = vi.fn(async () => {});
    const done = useHostStore.getState().runSetup({ port: 8443, account });
    await vi.runAllTimersAsync();
    expect(await done).toBe('done');
    expect(account).not.toHaveBeenCalled();
    expect(rowStates()).toEqual(['ok', 'ok', 'ok', 'warn', 'ok']);
  });
});

describe('hostStore commands', () => {
  it('passes camelCase arguments and records Settings errors', async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'host_remove') throw 'Couldn\'t delete the server\'s storage key';
      if (command === 'host_info') return { enabled: false, completed_steps: [] };
      return undefined;
    });
    await useHostStore.getState().writeEscrow('d3JhcA');
    expect(invokeMock).toHaveBeenCalledWith('host_write_escrow', { wrappingKey: 'd3JhcA' });
    expect(await useHostStore.getState().setAutostart(false)).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith('host_set_autostart', { enabled: false });
    expect(await useHostStore.getState().remove(true)).toBe(false);
    expect(invokeMock).toHaveBeenCalledWith('host_remove', { deleteData: true });
    expect(useHostStore.getState().error).toBe("Couldn't delete the server's storage key");
  });
});
