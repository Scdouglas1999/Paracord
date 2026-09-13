import { AxiosError } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../operationContext';
import { createDeliveredDeletionTransport } from './deliveredMutationTransport';

const record = { channelId: '10', messageId: '100', deleteNonce: 'immutable-delete' };
const receipt = { channel_id: '10', message_id: '100', actor_id: '42', delete_nonce: record.deleteNonce };
function setup() {
  const request = vi.fn();
  const transport = createDeliveredDeletionTransport({ scope: { userId: '42' }, request } as unknown as OperationContext);
  return { request, transport, signal: new AbortController().signal };
}
describe('delivered deletion receipt contract', () => {
  it.each(['pending', 'deleted'] as const)('resolves an owned %s result without a creation receipt', async state => {
    const f = setup(); f.request.mockResolvedValue({ status: 200, data: { ...receipt, state } });
    await expect(f.transport.resolve(record, f.signal)).resolves.toEqual({ state });
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ method: 'POST', signal: f.signal, timeout: 30_000,
      url: '/channels/10/messages/100/deletions/immutable-delete/resolve' });
  });
  it('requires a committed receipt and reuses the deletion body exactly', async () => {
    const f = setup(); f.request.mockResolvedValue({ status: 200, data: { ...receipt, state: 'deleted', delete_replayed: false } });
    await f.transport.send(record, f.signal); await f.transport.send(record, f.signal);
    expect(f.request.mock.calls[0]).toEqual(f.request.mock.calls[1]);
    expect(f.request.mock.calls[0][0]).toEqual({ method: 'DELETE', signal: f.signal, timeout: 30_000,
      url: '/channels/10/messages/100', data: '{"delete_nonce":"immutable-delete"}', headers: { 'Content-Type': 'application/json' } });
  });
  it.each([
    { actor_id: 'other' }, { message_id: 'other' }, { channel_id: 'other' },
    { delete_nonce: 'other' }, { state: 'absent' },
  ])('rejects mismatched resolution and deletion identities: %j', async change => {
    const f = setup(); f.request.mockResolvedValue({ status: 200, data: { ...receipt, state: 'deleted', delete_replayed: true, ...change } });
    await expect(f.transport.resolve(record, f.signal)).rejects.toThrow('did not acknowledge');
    await expect(f.transport.send(record, f.signal)).rejects.toThrow('did not acknowledge');
  });
  it.each([202, 204])('does not accept HTTP %s for a durable deletion', async status => {
    const f = setup(); f.request.mockResolvedValue({ status, data: { ...receipt, state: 'deleted', delete_replayed: true } });
    await expect(f.transport.send(record, f.signal)).rejects.toThrow('did not commit');
    await expect(f.transport.resolve(record, f.signal)).rejects.toThrow('did not resolve');
  });
  it.each([{ state: 'pending', delete_replayed: false }, { state: 'deleted' }, { state: 'deleted', delete_replayed: 'yes' }])('rejects uncommitted deletion responses: %j', async data => {
    const f = setup(); f.request.mockResolvedValue({ status: 200, data: { ...receipt, ...data } });
    await expect(f.transport.send(record, f.signal)).rejects.toThrow('committed deletion receipt');
  });
  it('propagates revoked access and missing targets without manufacturing deletion', async () => {
    const f = setup(); const error = new AxiosError('Missing target without receipt'); f.request.mockRejectedValue(error);
    await expect(f.transport.resolve(record, f.signal)).rejects.toBe(error);
    await expect(f.transport.send(record, f.signal)).rejects.toBe(error);
  });
});
