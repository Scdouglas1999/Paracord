import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../types';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import { DELIVERED_MUTATIONS_NAMESPACE, DeliveredMutations, MUTATION_RECEIPTS_NAMESPACE, type DeliveredMessageTarget } from './deliveredMutations';
import type { PreparedDeliveryEdit } from './durableEdit';
import type { PreparedMessageDeletion } from './deliveredMutationTransport';

const target: DeliveredMessageTarget = { channelId: '10', messageId: '100', authorId: '42', encryption: { kind: 'plain' } };
const message = (content: string) => ({ id: '100', channel_id: '10', author: { id: '42' }, content } as Message);
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function httpFailure(status: number, seconds?: string) {
  return new AxiosError('Rejected', 'ERR_BAD_RESPONSE', undefined, undefined, { status, statusText: 'Rejected', data: { message: 'Access denied' },
    headers: new AxiosHeaders(seconds ? { 'retry-after': seconds } : {}), config: { headers: new AxiosHeaders() } });
}

beforeEach(() => {
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', { locks: { request(name: string, options: { signal: AbortSignal }, run: () => Promise<unknown>) {
    const pending = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(() => { options.signal.throwIfAborted(); return run(); });
    locks.set(name, pending); return pending;
  } } });
});
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let records = new Map<string, string>(); let tail: Promise<unknown> = Promise.resolve(); let failNamespace: string | null = null;
  const vault = { scope: { serverId: 'server', userId: '42' }, transact<T>(run: (tx: VaultTransaction) => Promise<T>): Promise<T> {
    const result = tail.catch(() => {}).then(async () => {
      const next = new Map(records);
      const address = (ns: string, id: string) => JSON.stringify([ns, id]);
      const value = <V>(raw: string | undefined) => raw === undefined ? null : JSON.parse(raw) as V;
      const tx: VaultTransaction = {
        get: async <V>(ns: string, id: string) => value<V>(next.get(address(ns, id))),
        list: async <V>(ns: string) => [...next].flatMap(([key, raw]) => { const [namespace, id] = JSON.parse(key); return namespace === ns ? [{ id, value: JSON.parse(raw) as V }] : []; }),
        put(ns, id, data) { if (failNamespace === ns) { failNamespace = null; throw new Error('Storage quota'); } next.set(address(ns, id), JSON.stringify(data)); },
        remove(ns, id) { next.delete(address(ns, id)); },
      };
      const result = await run(tx); records = next; return result;
    });
    tail = result; return result;
  } } as AccountVault;
  const controller = new AbortController(); let now = 10_000;
  const prepareEdit = vi.fn(async (tx: VaultTransaction, owned: DeliveredMessageTarget, editNonce: string, content: string): Promise<PreparedDeliveryEdit> => {
    tx.put('test.crypto', editNonce, { content });
    return { channelId: owned.channelId, messageId: owned.messageId, editNonce, serializedRequest: JSON.stringify({ content, edit_nonce: editNonce }) };
  });
  const edit = vi.fn(async (prepared: PreparedDeliveryEdit) => message(JSON.parse(prepared.serializedRequest).content));
  const resolveEdit = vi.fn(async () => ({ state: 'applied' as 'applied' | 'cancelled' | 'deleted' }));
  const deletion = { resolve: vi.fn(async (_record: PreparedMessageDeletion) => ({ state: 'pending' as 'pending' | 'deleted' })), send: vi.fn(async () => {}) };
  const options = { vault, lifetime: { signal: controller.signal, assertCurrent() { controller.signal.throwIfAborted(); } }, prepareEdit, edit, resolveEdit, deletion,
    now: () => now, random: () => 0.5, onError: vi.fn() };
  const service = new DeliveredMutations(options);
  return { service, options, controller, vault, prepareEdit, edit, resolveEdit, deletion, reload: () => new DeliveredMutations(options),
    setNow: (value: number) => { now = value; }, fail: (namespace: string) => { failNamespace = namespace; } };
}

describe('delivered mutations across crashes and concurrent intent', () => {
  it('edits an older message without a creation receipt, preserving exact bytes through reload', async () => {
    const f = fixture(); f.edit.mockRejectedValueOnce(new AxiosError('Lost response', 'ERR_NETWORK'));
    const draft = await f.service.edit(target, 'Old message replacement', null);
    expect(f.prepareEdit).not.toHaveBeenCalled();
    await f.service.drain();
    const prepared = (await f.service.snapshot()).mutations[0].prepared!;
    expect(prepared.editNonce).toBe(draft.intent.kind === 'edit' && draft.intent.editNonce);
    f.setNow(11_001); await f.reload().drain();
    expect(f.prepareEdit).toHaveBeenCalledOnce();
    expect(f.edit.mock.calls[0][0]).toEqual(f.edit.mock.calls[1][0]);
    expect((await f.service.snapshot()).mutations).toEqual([]);
    expect((await f.service.snapshot()).receipts[0].result).toEqual({ kind: 'message', message: message('Old message replacement') });
  });

  it.each(['success', 'lost response'] as const)('resolves a superseded PATCH after its late %s before preparing a replacement', async outcome => {
    const f = fixture(); const started = deferred<void>(); const gate = deferred<Message>(); const events: string[] = [];
    f.edit.mockImplementationOnce(async () => { started.resolve(); events.push('old PATCH'); return gate.promise; });
    f.resolveEdit.mockImplementation(async () => { events.push('resolve old'); return { state: 'applied' }; });
    const prepare = f.prepareEdit.getMockImplementation()!;
    f.prepareEdit.mockImplementation(async (...args) => { events.push(`prepare ${args[3]}`); return prepare(...args); });
    const first = await f.service.edit(target, 'first', null); const run = f.service.drain(); await started.promise;
    const latest = await f.service.edit(target, 'second', first.revision);
    expect((await f.service.snapshot()).mutations[0]).toMatchObject({ revision: latest.revision, draft: { content: 'second' } });
    if (outcome === 'success') gate.resolve(message('first')); else gate.reject(new AxiosError('Lost', 'ERR_NETWORK'));
    await run;
    expect(events).toEqual(['prepare first', 'old PATCH', 'resolve old', 'prepare second']);
    expect((await f.service.snapshot()).receipts).toHaveLength(1);
    expect((await f.service.snapshot()).receipts[0].result).toEqual({ kind: 'message', message: message('second') });
  });

  it('persists delete during PATCH and resolves the old edit before deleting without resending content', async () => {
    const f = fixture(); const started = deferred<void>(); const gate = deferred<Message>();
    f.edit.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const first = await f.service.edit(target, 'first', null); const run = f.service.drain(); await started.promise;
    await f.service.delete(target, first.revision); gate.resolve(message('first')); await run;
    expect(f.edit).toHaveBeenCalledOnce(); expect(f.resolveEdit).toHaveBeenCalledOnce(); expect(f.deletion.send).toHaveBeenCalledOnce();
    expect((await f.service.snapshot()).receipts.map(row => row.result)).toEqual([{ kind: 'deleted' }]);
  });

  it('replays a committed delete receipt after a lost response and reload', async () => {
    const f = fixture(); f.deletion.send.mockRejectedValueOnce(new AxiosError('Lost', 'ERR_NETWORK'));
    const first = await f.service.delete(target, null); await f.service.drain();
    const saved = (await f.service.snapshot()).mutations[0]; expect(saved.intent).toEqual(first.intent);
    f.setNow(11_001); f.deletion.resolve.mockResolvedValue({ state: 'deleted' }); await f.reload().drain();
    expect(f.deletion.send).toHaveBeenCalledOnce(); expect(f.deletion.resolve.mock.calls[0][0]).toEqual(f.deletion.resolve.mock.calls[1][0]);
    expect((await f.service.snapshot()).mutations).toEqual([]);
    expect((await f.service.snapshot()).deleted).toEqual([first.id]);
  });

  it.each([403, 404, 409])('retains an unconfirmed HTTP %s delete for recovery', async status => {
    const f = fixture(); f.deletion.resolve.mockRejectedValue(httpFailure(status));
    const first = await f.service.delete(target, null); await f.service.drain();
    expect((await f.service.snapshot()).mutations[0]).toMatchObject({ revision: first.revision, status: 'failed' });
    expect((await f.service.snapshot()).receipts).toEqual([]); expect(f.deletion.send).not.toHaveBeenCalled();
  });

  it('honors Retry-After across editing, manual retry, reload and resolution', async () => {
    const f = fixture(); f.edit.mockRejectedValueOnce(httpFailure(429, '120'));
    const first = await f.service.edit(target, 'first', null); await f.service.drain();
    const latest = await f.service.edit(target, 'second', first.revision); await f.service.retry(latest.id, latest.revision);
    expect((await f.reload().drain()).nextAttemptAt).toBe(130_000); expect(f.resolveEdit).not.toHaveBeenCalled();
    f.setNow(130_001); await f.reload().drain(); expect(f.resolveEdit).toHaveBeenCalledOnce(); expect(f.prepareEdit).toHaveBeenCalledTimes(2);
  });

  it('rolls back crypto preparation when saving the immutable request fails', async () => {
    const f = fixture(); const first = await f.service.edit(target, 'draft', null);
    const prepare = f.prepareEdit.getMockImplementation()!;
    f.prepareEdit.mockImplementationOnce(async (...args) => { const wire = await prepare(...args); f.fail(DELIVERED_MUTATIONS_NAMESPACE); return wire; });
    await f.service.drain();
    expect(f.edit).not.toHaveBeenCalled(); expect(await f.vault.transact(tx => tx.list('test.crypto'))).toEqual([]);
    expect((await f.service.snapshot()).mutations[0]).toMatchObject({ draft: { content: 'draft' }, status: 'failed' });
    await f.service.retry(first.id, first.revision); await f.service.drain(); expect(f.edit).toHaveBeenCalledOnce();
  });

  it('keeps prepared bytes when receipt persistence fails after the server committed', async () => {
    const f = fixture(); const first = await f.service.edit(target, 'draft', null); f.fail(MUTATION_RECEIPTS_NAMESPACE);
    await f.service.drain(); await f.service.retry(first.id, first.revision); await f.reload().drain();
    expect(f.prepareEdit).toHaveBeenCalledOnce(); expect(f.edit.mock.calls[0][0]).toEqual(f.edit.mock.calls[1][0]);
  });

  it('cancels after logout without replacing pending intent with a failure or receipt', async () => {
    const f = fixture(); const started = deferred<void>(); const gate = deferred<Message>();
    f.edit.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const first = await f.service.edit(target, 'draft', null); const run = f.service.drain(); await started.promise;
    f.controller.abort(); gate.resolve(message('draft')); await expect(run).rejects.toThrow();
    const stored = await f.vault.transact(tx => tx.get(DELIVERED_MUTATIONS_NAMESPACE, first.id));
    expect(stored).toMatchObject({ status: 'pending', error: null });
    expect(await f.vault.transact(tx => tx.list(MUTATION_RECEIPTS_NAMESPACE))).toEqual([]);
  });

  it('serializes two drivers sharing the same account and delivers the mutation once', async () => {
    const f = fixture(); const second = f.reload(); await f.service.edit(target, 'draft', null);
    await Promise.all([f.service.drain(), second.drain()]); expect(f.edit).toHaveBeenCalledOnce();
  });

  it('rejects stale editor revisions and other authors without writing intent', async () => {
    const f = fixture(); await expect(f.service.edit({ ...target, authorId: 'other' }, 'draft', null)).rejects.toThrow('own message');
    await f.service.edit(target, 'draft', null);
    await expect(f.service.delete(target, null)).rejects.toThrow('another window');
    expect((await f.service.snapshot()).mutations[0].draft?.content).toBe('draft');
  });

  it('retains the latest edit draft and ignores a late successful PATCH after gateway deletion', async () => {
    const f = fixture(); const started = deferred<void>(); const gate = deferred<Message>();
    f.edit.mockImplementationOnce(async () => { started.resolve(); return gate.promise; });
    const first = await f.service.edit(target, 'draft', null); const run = f.service.drain(); await started.promise;
    await f.service.observeDeleted(target); gate.resolve(message('draft')); await run;
    expect((await f.service.snapshot()).mutations[0]).toMatchObject({ targetDeleted: true, status: 'failed', draft: { content: 'draft' } });
    expect((await f.service.snapshot()).receipts).toEqual([]);
    await expect(f.service.retry(first.id, first.revision)).rejects.toThrow('deleted');
    await expect(f.service.edit(target, 'replacement', first.revision)).rejects.toThrow('deleted');
  });

  it('projects old successful edit receipts as deleted after a later deletion observation', async () => {
    const f = fixture(); await f.service.edit(target, 'draft', null); await f.service.drain();
    await f.service.observeDeleted(target);
    expect((await f.reload().snapshot()).receipts[0].result).toEqual({ kind: 'deleted' });
  });

  it('returns completed receipts in durable intent order so replay cannot replace a newer edit with an older one', async () => {
    const f = fixture(); await f.service.edit(target, 'first', null); await f.service.drain();
    await f.service.edit(target, 'second', null); await f.service.drain();
    expect((await f.reload().snapshot()).receipts.map(row => row.result.kind === 'message' && row.result.message.content)).toEqual(['first', 'second']);
  });
});
