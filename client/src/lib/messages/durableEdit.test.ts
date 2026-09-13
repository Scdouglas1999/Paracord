import { describe, expect, it, vi } from 'vitest';
import type { OperationContext } from '../operationContext';
import { createDeliveryEditTransport, createEditResolutionTransport, type PreparedDeliveryEdit } from './durableEdit';

const prepared: PreparedDeliveryEdit = { channelId: '10', messageId: '100', editNonce: 'original-edit',
  serializedRequest: '{"content":"","edit_nonce":"original-edit","e2ee":{"version":2,"nonce":"cipher-iv","ciphertext":"ciphertext","header":"{}"}}' };
function setup() {
  const message = { id: '100', channel_id: '10', author: { id: '42' }, edit_nonce: 'original-edit', edit_replayed: false, content: '', nonce: 'original-create' };
  const request = vi.fn().mockResolvedValue({ status: 200, data: message });
  const context = { scope: { serverId: 'a', userId: '42' }, request } as unknown as OperationContext;
  return { message, request, send: createDeliveryEditTransport(context), signal: new AbortController().signal };
}

describe('durable edit transport', () => {
  it('retries the identical committed JSON and accepts an acknowledgement carrying a newer edit', async () => {
    const f = setup();
    f.request.mockRejectedValueOnce(new Error('Lost response')).mockResolvedValueOnce({ status: 200, data: { ...f.message, edit_replayed: true, content: 'Newer version' } });
    await expect(f.send(prepared, f.signal)).rejects.toThrow('Lost response');
    await expect(f.send(prepared, f.signal)).resolves.toMatchObject({ content: 'Newer version', edit_replayed: true });
    expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.request.mock.calls[0][0]).toEqual(f.request.mock.calls[1][0]);
    expect(f.request.mock.calls[0][0]).toEqual({ method: 'PATCH', signal: f.signal, timeout: 30_000,
      url: '/channels/10/messages/100', data: prepared.serializedRequest, headers: { 'Content-Type': 'application/json' } });
  });

  it.each([
    { id: 'wrong' }, { channel_id: 'wrong' }, { author: { id: 'other' } },
    { edit_nonce: 'wrong' }, { edit_replayed: undefined }, { edit_replayed: 'true' },
  ])('rejects a mismatched acknowledgement: %j', async changed => {
    const f = setup(); f.request.mockResolvedValue({ status: 200, data: { ...f.message, ...changed } });
    await expect(f.send(prepared, f.signal)).rejects.toThrow('did not acknowledge');
  });

  it('rejects asynchronous acceptance and missing response data', async () => {
    const f = setup(); f.request.mockResolvedValueOnce({ status: 202, data: f.message }).mockResolvedValueOnce({ status: 200, data: null });
    await expect(f.send(prepared, f.signal)).rejects.toThrow('did not acknowledge');
    await expect(f.send(prepared, f.signal)).rejects.toThrow('did not acknowledge');
  });

  it.each(['not JSON', 'null', '{}', '{"edit_nonce":"different"}'])('does not transmit an edit with broken local identity: %s', async body => {
    const f = setup(); await expect(f.send({ ...prepared, serializedRequest: body }, f.signal)).rejects.toThrow();
    expect(f.request).not.toHaveBeenCalled();
  });

  it('propagates permission failures instead of acknowledging or recreating the message', async () => {
    const f = setup(); const error = new Error('Permission revoked'); f.request.mockRejectedValue(error);
    await expect(f.send(prepared, f.signal)).rejects.toBe(error); expect(f.request).toHaveBeenCalledOnce();
    expect(f.request.mock.calls[0][0].method).toBe('PATCH');
  });
});


describe('durable edit resolution', () => {
  function resolution(data: unknown, status = 200) {
    const request = vi.fn().mockResolvedValue({ status, data });
    const context = { request, scope: { userId: '42' } } as unknown as OperationContext;
    return { request, resolve: createEditResolutionTransport(context), signal: new AbortController().signal };
  }
  const receipt = { channel_id: '10', message_id: '100', actor_id: '42', edit_nonce: 'original-edit' };
  it.each(['cancelled', 'applied', 'deleted'] as const)('requires a committed %s resolution for the exact original operation', async state => {
    const f = resolution({ ...receipt, state });
    await expect(f.resolve(prepared, f.signal)).resolves.toEqual({ state });
    expect(f.request).toHaveBeenCalledExactlyOnceWith({ method: 'POST', signal: f.signal, timeout: 30_000,
      url: '/channels/10/messages/100/edits/original-edit/resolve' });
  });
  it.each([
    null, { ...receipt, state: 'unknown' }, { ...receipt, state: null },
    { ...receipt, channel_id: 'other', state: 'cancelled' },
    { ...receipt, message_id: 'other', state: 'cancelled' },
    { ...receipt, actor_id: 'other', state: 'cancelled' },
    { ...receipt, edit_nonce: 'other', state: 'cancelled' },
  ])('rejects malformed or differently owned resolution: %j', async data => {
    const f = resolution(data);
    await expect(f.resolve(prepared, f.signal)).rejects.toThrow('did not resolve');
  });
  it('does not accept HTTP 202 or replace a request after permission failure', async () => {
    const f = resolution({ ...receipt, state: 'cancelled' }, 202);
    await expect(f.resolve(prepared, f.signal)).rejects.toThrow('did not resolve');
    const denied = new Error('Permission revoked'); f.request.mockRejectedValue(denied);
    await expect(f.resolve(prepared, f.signal)).rejects.toBe(denied);
    expect(f.request.mock.calls.every(call => call[0].method === 'POST')).toBe(true);
  });
});
