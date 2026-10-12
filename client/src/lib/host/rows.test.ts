import { describe, expect, it } from 'vitest';
import type { HostProgress } from '../../api/generated/HostProgress';
import type { Reachability } from '../../api/generated/HostStatus';
import {
  applyProgress,
  initialHostRows,
  previewStatus,
  reachabilityCopy,
  setAccountRow,
  setupCanContinue,
  type HostRow,
} from './rows';

const fold = (events: HostProgress[], rows: HostRow[] = initialHostRows()) => events.reduce(applyProgress, rows);
const row = (rows: HostRow[], id: number) => rows.find((r) => r.row === id)!;

describe('host setup rows', () => {
  it('start waiting with the pending lines', () => {
    const rows = initialHostRows();
    expect(rows.map((r) => r.state)).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(row(rows, 1).title).toBe('Starting Paracord on this computer');
    expect(row(rows, 5).detail).toBe('Kept on this computer for 14 days.');
    expect(setupCanContinue(rows)).toBe(false);
    expect(previewStatus(rows)).toBe('not_running');
  });

  it('keeps row 1 running through its inner steps and finishes on start', () => {
    const rows = fold([
      { row: 1, step: 'install', state: 'run' },
      { row: 1, step: 'install', state: 'ok' },
      { row: 1, step: 'init', state: 'run' },
      { row: 1, step: 'init', state: 'ok' },
    ]);
    expect(row(rows, 1).state).toBe('run');
    expect(row(rows, 1).step).toBe('init');
    expect(previewStatus(rows)).toBe('starting');
    const done = fold([{ row: 1, step: 'start', state: 'ok' }], rows);
    expect(row(done, 1).state).toBe('ok');
    expect(previewStatus(done)).toBe('online');
  });

  it('shows a failure with its words and the Try again / Show details chips', () => {
    const rows = fold([
      { row: 1, step: 'start', state: 'run' },
      { row: 1, step: 'start', state: 'fail', code: 'start_timeout', detail: "Paracord on this computer didn't start." },
    ]);
    expect(row(rows, 1)).toMatchObject({
      state: 'fail',
      code: 'start_timeout',
      detail: "Paracord on this computer didn't start.",
      chips: ['try_again', 'show_details'],
    });
    expect(previewStatus(rows)).toBe('not_running');
  });

  it('gives row 4 the chips its reachability state calls for', () => {
    const warn = (code: string) =>
      row(fold([{ row: 4, step: 'reach', state: 'warn', code, detail: 'x' }]), 4).chips;
    expect(warn('refused')).toEqual(['show_me_how', 'try_again']);
    expect(warn('no_answer')).toEqual(['show_me_how', 'try_again']);
    expect(warn('shared_address')).toEqual(['what_can_i_do']);
    expect(warn('firewall_blocked')).toEqual(['allow']);
  });

  it('lets the page drive row 3 and enables Continue when every row is ok or warn', () => {
    let rows = fold([
      { row: 1, step: 'start', state: 'ok' },
      { row: 2, step: 'storage', state: 'ok' },
    ]);
    rows = setAccountRow(rows, 'run');
    expect(row(rows, 3).state).toBe('run');
    rows = setAccountRow(rows, 'ok');
    rows = fold(
      [
        { row: 4, step: 'reach', state: 'warn', code: 'refused', detail: 'r' },
        { row: 5, step: 'backup', state: 'ok' },
      ],
      rows,
    );
    expect(setupCanContinue(rows)).toBe(true);
    const failed = setAccountRow(rows, 'fail', 'That username is taken.');
    expect(row(failed, 3)).toMatchObject({ state: 'fail', detail: 'That username is taken.', chips: ['try_again'] });
    expect(setupCanContinue(failed)).toBe(false);
  });

  it('words reachability like spec 5.4', () => {
    const base: Reachability = { state: 'open', external_ip: '203.0.113.1', port: 8443 } as Reachability;
    expect(reachabilityCopy(base)).toEqual({
      tone: 'ok',
      text: 'Your router opened the way. Friends can reach you at 203.0.113.1.',
    });
    expect(reachabilityCopy({ ...base, state: 'direct' }).text).toBe(
      'This computer has its own public address (203.0.113.1). Friends can reach it if your firewall allows port 8443.',
    );
    expect(reachabilityCopy({ ...base, state: 'refused' }).tone).toBe('warn');
    expect(reachabilityCopy({ ...base, state: 'off' }).text).toBe("Paracord isn't asking your router to let friends in.");
  });
});
