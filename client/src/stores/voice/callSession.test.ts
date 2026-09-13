import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../../lib/operationContext';
import { CallSession } from './callSession';

function fixture() {
  const account = new AbortController();
  const context = { signal: account.signal, assertCurrent: vi.fn() } as unknown as OperationContext;
  let selected = true;
  const call: CallSession = new CallSession(context, { scope: { serverId: 'A', userId: '1' }, channelId: '7', guildId: '2' }, () => selected, () => { void call.close(); });
  return { call, account, replace: () => { selected = false; } };
}

describe('CallSession owns incomplete and committed work', () => {
  it('revokes callbacks synchronously, attempts every release and releases only once', async () => {
    const { call } = fixture();
    const callback = vi.fn();
    const event = call.guard(callback);
    const broken = vi.fn(() => { throw new Error('screen stop failed'); });
    const microphone = vi.fn();
    call.own(broken); call.own(microphone);
    event();
    const closing = call.close();
    event();
    await closing; await call.close();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(microphone).toHaveBeenCalledTimes(1);
  });

  it('immediately releases a resource returned after account cancellation', async () => {
    const { call, account } = fixture();
    account.abort();
    const lateStream = vi.fn();
    await call.own(lateStream)();
    expect(lateStream).toHaveBeenCalledTimes(1);
    expect(call.current).toBe(false);
  });

  it('superseding one camera action preserves independent device operations', () => {
    const { call, replace } = fixture();
    const camera = call.operation('camera');
    const device = call.operation('output');
    call.operation('camera');
    expect(camera.current()).toBe(false);
    expect(device.current()).toBe(true);
    replace();
    expect(device.current()).toBe(false);
  });
});
