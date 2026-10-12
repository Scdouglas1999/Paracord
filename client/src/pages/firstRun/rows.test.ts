import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { chipsFor, hostRows, joinRows, MIN_RUN_MS, RowSequencer, storageCopy } from './rows';
import type { SetupRow } from '../../stores/firstRunStore';

describe('the setup rows', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function sequencer(rows: SetupRow[]) {
    let shown: SetupRow[] = rows;
    let now = 0;
    const seq = new RowSequencer(rows, (next) => (shown = next), () => now);
    return {
      seq,
      states: () => shown.map((r) => r.state),
      advance: (ms: number) => {
        now += ms;
        vi.advanceTimersByTime(ms);
      },
    };
  }

  it('shows rows in order and runs each at least 300 ms', () => {
    const { seq, states, advance } = sequencer(joinRows('Kanto Friends'));
    seq.set(2, { state: 'ok' });
    expect(states()).toEqual(['waiting', 'waiting', 'waiting']);
    seq.set(1, { state: 'ok' });
    expect(states()).toEqual(['run', 'waiting', 'waiting']);
    advance(MIN_RUN_MS);
    expect(states()).toEqual(['ok', 'run', 'waiting']);
    advance(MIN_RUN_MS);
    expect(states()).toEqual(['ok', 'ok', 'waiting']);
  });

  it('stops at a failed row and gives it Try again and Show details', () => {
    const { seq, states, advance } = sequencer(hostRows({ claim: false }));
    seq.set(1, { state: 'fail', detail: "Paracord on this computer didn't start." });
    seq.set(2, { state: 'ok' });
    advance(MIN_RUN_MS);
    expect(states()).toEqual(['fail', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(chipsFor(1, 'fail')).toEqual(['retry-row', 'show-details']);
  });

  it('chips for the reach row follow the router (§5.4)', () => {
    expect(chipsFor(4, 'warn', 'refused')).toEqual(['show-me-how', 'try-again']);
    expect(chipsFor(4, 'warn', 'shared_address')).toEqual(['what-can-i-do']);
    expect(chipsFor(4, 'warn', 'firewall_blocked')).toEqual(['allow']);
    expect(chipsFor(4, 'ok', 'open')).toBeUndefined();
  });

  it('claim mode has no row 1 and makes the account first; the web join has no row 1', () => {
    expect(hostRows({ claim: true }).map((r) => r.row)).toEqual([3, 2, 4, 5]);
    expect(joinRows('Kanto Friends', { web: true }).map((r) => r.title)).toEqual(['Creating your encryption keys', 'Joining Kanto Friends']);
  });

  it('a dropped row no longer holds the others back', () => {
    const { seq, states, advance } = sequencer(hostRows({ claim: true }));
    seq.set(3, { state: 'ok' });
    seq.set(2, { state: 'ok' });
    seq.drop(4);
    seq.set(5, { state: 'ok' });
    for (let i = 0; i < 4; i += 1) advance(MIN_RUN_MS);
    expect(states()).toEqual(['ok', 'ok', 'ok']);
  });

  it('says how stored data is protected, by label (§4.6)', () => {
    expect(storageCopy('login', true)).toMatch(/system keychain/);
    expect(storageCopy('same_disk', true)).toMatch(/same disk/);
    expect(storageCopy(null, false)).toMatch(/Not encrypted/);
  });
});
