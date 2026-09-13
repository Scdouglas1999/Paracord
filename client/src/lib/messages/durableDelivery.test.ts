import { AxiosError, AxiosHeaders } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../operationContext';
import type { DurableSend } from './durableOutbox';
import { classifyDeliveryFailure, createDeliveryTransport, createDeliveryResolutionTransport, createDeliveryDiscardTransport, DeliveryProtocolError } from './durableDelivery';

function failure(status: number, retryAfter?: string) {
  return new AxiosError('Rejected', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status, statusText: 'Rejected', data: { message: 'Keep my draft' },
    config: { headers: new AxiosHeaders() }, headers: new AxiosHeaders(retryAfter === undefined ? {} : { 'retry-after': retryAfter }),
  });
}

describe('durable delivery HTTP contract', () => {
  const record = { nonce: 'original', channelId: 'channel', serializedRequest: '{"nonce":"original","content":""}' } as DurableSend;
  function setup(message: unknown, status = 201) {
    const request = vi.fn().mockResolvedValue({ status, data: message });
    const context = { scope: { serverId: 'owned-server', userId: 'owner' }, request, assertCurrent: vi.fn() } as unknown as OperationContext;
    return { request, context, transport: createDeliveryTransport(context) };
  }
  it('sends the exact committed string with a bounded request lifetime', async () => {
    const message = { id: 'm', nonce: 'original', channel_id: 'channel', author: { id: 'owner' } };
    const { request, transport } = setup(message); const signal = new AbortController().signal;
    await expect(transport(record, signal)).resolves.toEqual({ kind: 'message', message });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ url: '/channels/channel/messages', data: record.serializedRequest, method: 'POST', timeout: 30_000, signal }));
  });
  it.each([
    { nonce: 'different', channel_id: 'channel', author: { id: 'owner' } },
    { nonce: 'original', channel_id: 'wrong', author: { id: 'owner' } },
    { nonce: 'original', channel_id: 'channel', author: { id: 'other' } },
  ])('rejects an acknowledgement for another request, channel or sender', async fields => {
    await expect(setup({ id: 'm', ...fields }).transport(record)).rejects.toBeInstanceOf(DeliveryProtocolError);
  });
  it('does not interpret asynchronous server acceptance as a committed message', async () => {
    await expect(setup({ id: 'm', nonce: 'original', channel_id: 'channel', author: { id: 'owner' } }, 202).transport(record)).rejects.toBeInstanceOf(DeliveryProtocolError);
  });
  it('recognizes only an explicit server delivery-deletion receipt', async () => {
    const { request, transport } = setup(null);
    const deleted = failure(410); deleted.response!.data = Object.assign(deleted.response!.data, { code: 'DELIVERY_ALREADY_DELETED' });
    request.mockRejectedValueOnce(deleted);
    await expect(transport(record)).resolves.toEqual({ kind: 'deleted' });
    const cancelled = failure(410); cancelled.response!.data = Object.assign(cancelled.response!.data, { code: 'DELIVERY_CANCELLED' });
    request.mockRejectedValueOnce(cancelled);
    await expect(transport(record)).resolves.toEqual({ kind: 'cancelled' });
    request.mockRejectedValueOnce(failure(410));
    await expect(transport(record)).rejects.toBeInstanceOf(AxiosError);
  });
});

describe('durable retry policy', () => {
  it('backs off network failures without dropping drafts or resetting the attempt count', () => {
    const error = new AxiosError('Connection lost', 'ERR_NETWORK');
    expect(classifyDeliveryFailure(error, 1, 1000, 0.5)).toMatchObject({ status: 'pending', nextAttemptAt: 2000 });
    expect(classifyDeliveryFailure(error, 3, 1000, 0.5)).toMatchObject({ status: 'pending', nextAttemptAt: 5000 });
    expect(classifyDeliveryFailure(error, 100, 1000, 1).nextAttemptAt).toBe(61_000);
  });
  it('honors both seconds and HTTP-date Retry-After deadlines', () => {
    expect(classifyDeliveryFailure(failure(429, '120'), 1, 1000, 0).nextAttemptAt).toBe(121_000);
    const deadline = Date.UTC(2026, 8, 9, 12);
    expect(classifyDeliveryFailure(failure(503, new Date(deadline).toUTCString()), 1, deadline - 60_000, 0).nextAttemptAt).toBe(deadline);
  });
  it.each([400, 401, 403, 404, 409, 413, 422])('retains HTTP %s as an explicit failed draft', status => {
    expect(classifyDeliveryFailure(failure(status), 1, 1000, 0.5)).toMatchObject({ status: 'failed', nextAttemptAt: 0, error: 'Keep my draft' });
  });
  it('says a refused send cannot be delivered rather than repeating "forbidden"', () => {
    // The server answers a blocked sender with a bare FORBIDDEN on purpose —
    // being told you were blocked is the thing a block must not reveal — so the
    // author was left with a word that explains nothing. The neutral sentence
    // is the same for a block, a lost permission or a closed conversation.
    const refused = (message?: string) => {
      const error = failure(403);
      error.response!.data = (message === undefined ? {} : { message }) as { message: string };
      return classifyDeliveryFailure(error, 1, 1000, 0.5);
    };
    expect(refused('forbidden')).toMatchObject({ status: 'failed', error: 'This message can’t be delivered.' });
    expect(refused('Forbidden')).toMatchObject({ error: 'This message can’t be delivered.' });
    expect(refused()).toMatchObject({ error: 'This message can’t be delivered.' });
    // A 403 that actually explains itself keeps its explanation.
    expect(refused('This channel is read-only for your role.')).toMatchObject({
      error: 'This channel is read-only for your role.',
    });
    // Nothing else is rewritten.
    expect(classifyDeliveryFailure(failure(404), 1, 1000, 0.5).error).toBe('Keep my draft');
  });
});


describe('delivery resolution transport', () => {
  function setup(data: unknown, status = 200) {
    const request = vi.fn().mockResolvedValue({ status, data });
    const context = { scope: { serverId: 'server', userId: 'author' }, request } as unknown as OperationContext;
    return { request, resolve: createDeliveryResolutionTransport(context) };
  }
  const record = { channelId: 'channel', nonce: 'request-id' };
  const owner = { channel_id: 'channel', author_id: 'author', nonce: 'request-id' };
  it.each(['delivered', 'deleted'] as const)('preserves an exact %s snowflake', async state => {
    const { resolve, request } = setup({ ...owner, state, message_id: '9223372036854775807' });
    const signal = new AbortController().signal;
    await expect(resolve(record, signal)).resolves.toEqual({ state, messageId: '9223372036854775807' });
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', signal, timeout: 30_000,
      url: '/channels/channel/message-deliveries/request-id/resolve' }));
  });
  it('distinguishes cancellation before creation from a deleted delivered message', async () => {
    await expect(setup({ ...owner, state: 'cancelled' }).resolve(record)).resolves.toEqual({ state: 'cancelled' });
  });
  it.each([
    { ...owner, author_id: 'other', state: 'cancelled' },
    { ...owner, channel_id: 'other', state: 'cancelled' },
    { ...owner, nonce: 'other', state: 'cancelled' },
    { ...owner, state: 'unknown' },
    { ...owner, state: 'cancelled', message_id: '123' },
    { ...owner, state: 'delivered', message_id: '0' },
    { ...owner, state: 'deleted', message_id: '9223372036854775808' },
    { ...owner, state: 'delivered', message_id: 123 },
  ])('rejects a malformed or differently owned resolution', async data => {
    await expect(setup(data).resolve(record)).rejects.toBeInstanceOf(DeliveryProtocolError);
  });
  it('rejects acceptance without a committed resolution', async () => {
    await expect(setup({ ...owner, state: 'cancelled' }, 202).resolve(record)).rejects.toBeInstanceOf(DeliveryProtocolError);
  });
});


describe('prepared message discard transport', () => {
  const record = { channelId: 'channel', nonce: 'nonce' } as DurableSend;
  const response = (state: string, message_id?: string) => ({ status: 200, data: { state, message_id, channel_id: 'channel', author_id: 'author', nonce: 'nonce' } });
  function setup() {
    const request = vi.fn();
    const context = { request, scope: { userId: 'author' }, assertCurrent: vi.fn() } as unknown as OperationContext;
    return { request, discard: createDeliveryDiscardTransport(context), signal: new AbortController().signal };
  }
  it('never issues a delete for a delivery cancelled before creation', async () => {
    const { request, discard, signal } = setup(); request.mockResolvedValueOnce(response('cancelled'));
    await expect(discard(record, signal)).resolves.toEqual({ kind: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('deletes exactly the resolved message with the captured signal', async () => {
    const { request, discard, signal } = setup();
    request.mockResolvedValueOnce(response('delivered', '123')).mockResolvedValueOnce({ status: 204 });
    await expect(discard(record, signal)).resolves.toEqual({ kind: 'deleted' });
    expect(request).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'DELETE', url: '/channels/channel/messages/123', signal }));
  });
  it('does not accept a 404 without a matching deleted receipt', async () => {
    const { request, discard, signal } = setup();
    request.mockResolvedValueOnce(response('delivered', '123')).mockRejectedValueOnce(failure(404)).mockResolvedValueOnce(response('deleted', '456'));
    await expect(discard(record, signal)).rejects.toBeInstanceOf(AxiosError);
  });
  it('accepts a concurrent deletion only after resolving the same message', async () => {
    const { request, discard, signal } = setup();
    request.mockResolvedValueOnce(response('delivered', '123')).mockRejectedValueOnce(failure(404)).mockResolvedValueOnce(response('deleted', '123'));
    await expect(discard(record, signal)).resolves.toEqual({ kind: 'deleted' });
  });
  it('recovers a lost deletion response through resolution without repeating creation', async () => {
    const { request, discard, signal } = setup();
    request.mockResolvedValueOnce(response('delivered', '123')).mockRejectedValueOnce(new AxiosError('Lost delete response', 'ERR_NETWORK')).mockResolvedValueOnce(response('deleted', '123'));
    await expect(discard(record, signal)).rejects.toBeInstanceOf(AxiosError);
    await expect(discard(record, signal)).resolves.toEqual({ kind: 'deleted' });
    expect(request.mock.calls.map(call => call[0].method)).toEqual(['POST', 'DELETE', 'POST']);
    expect(request.mock.calls[2][0].url).toContain('/message-deliveries/nonce/resolve');
  });
});
