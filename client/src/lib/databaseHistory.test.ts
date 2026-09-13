import { beforeEach, expect, it, vi } from 'vitest';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory, getDatabaseHistoryEpoch, registerAccountHistoryReset, subscribeDatabaseHistoryOperation } from './databaseHistory';

const scope = { serverId: 'a', userId: '42' };
const oldHistory = '7257b8f7-610e-4a8b-a20c-5a94a7b98428';
const newHistory = '31349d45-0b51-4c83-b41b-49ac76d648ce';
beforeEach(() => { localStorage.clear(); clearDatabaseHistoryMemory(); });

it('persists an accepted history and does not reset healthy resumes or ordinary reloads', () => {
  const reset = vi.fn(); registerAccountHistoryReset('test', reset);
  expect(acceptDatabaseHistoryEpoch(scope, oldHistory)).toBe(true);
  expect(acceptDatabaseHistoryEpoch(scope, oldHistory)).toBe(false);
  clearDatabaseHistoryMemory();
  expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
  expect(acceptDatabaseHistoryEpoch(scope, oldHistory)).toBe(false);
  expect(reset).toHaveBeenCalledTimes(1);
});

it('expires account operations before clearing projections and preserves another account', () => {
  acceptDatabaseHistoryEpoch(scope, oldHistory);
  const order: string[] = [];
  const other = vi.fn();
  const stop = subscribeDatabaseHistoryOperation(scope, () => order.push('abort'));
  const stopOther = subscribeDatabaseHistoryOperation({ ...scope, serverId: 'b' }, other);
  registerAccountHistoryReset('test', owner => { expect(owner).toEqual(scope); order.push('reset'); });
  expect(acceptDatabaseHistoryEpoch(scope, newHistory)).toBe(true);
  expect(order).toEqual(['abort', 'reset']);
  expect(other).not.toHaveBeenCalled();
  stop(); stopOther();
});

it('rejects malformed metadata and permits only a valid handshake to repair it', () => {
  localStorage.setItem('paracord:database-history:["a","42"]', 'broken');
  expect(() => getDatabaseHistoryEpoch(scope)).toThrow('invalid');
  expect(() => acceptDatabaseHistoryEpoch(scope, 'broken')).toThrow('invalid');
  acceptDatabaseHistoryEpoch(scope, oldHistory);
  expect(getDatabaseHistoryEpoch(scope)).toBe(oldHistory);
});
