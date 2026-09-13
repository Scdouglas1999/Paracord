import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { HistoryRequest } from './historyReconciliation';

describe('history request journal', () => {
  it('coalesces repeated edits while bounding distinct mutated IDs', () => {
    const request = new HistoryRequest('latest', 2);
    for (let i = 0; i < 100; i++) request.record({ id: '1', content: String(i) });
    request.remove(['2']);
    expect(request.controller.signal.aborted).toBe(false);
    request.record({ id: '3' });
    expect(request.controller.signal.aborted).toBe(true);
    expect(request.failure).toContain('Retry');
  });

  it('orders adjacent snowflakes beyond JavaScript integer precision', () => {
    const request = new HistoryRequest('latest');
    const ids = ['9223372036854775807', '9223372036854775806', '999999999999999999'];
    expect(request.reconcile(ids.map(id => ({ id }) as Message), []).map(message => message.id))
      .toEqual(['999999999999999999', '9223372036854775806', '9223372036854775807']);
  });

  it('keeps deletion terminal when a replay contains a create or edit', () => {
    const request = new HistoryRequest('latest');
    request.remove(['1']);
    request.record({ id: '1', content: 'replayed' }, true);
    request.record({ id: '1', content: 'replayed edit' });
    expect(request.isDeleted('1')).toBe(true);
    expect(request.reconcile([{ id: '1' } as Message], [])).toEqual([]);
  });
});
