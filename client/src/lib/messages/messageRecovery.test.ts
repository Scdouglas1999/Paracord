import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import type { OperationContext } from '../operationContext';
import { createMessageRecoveryTransport, MessageRecoveryGapError, readRecoveryPage, recoverChannelMessages, RECOVERY_ARCHIVE_NAMESPACE, RECOVERY_CURSOR_NAMESPACE, RECOVERY_STATE_NAMESPACE, stageRecoveryPage, stageLiveRecoveryMutation, type RecoveryPage, type RecoveryRequest, type RecoveryState } from './messageRecovery';
const epoch = 'history-a';
const archived = (messageId = '100') => ({ id: messageId, channel_id: '10', author: { id: '20' }, content: '' as const, e2ee: { version: 2, nonce: 'iv', ciphertext: 'ciphertext', header: 'header' }, nonce: 'creation-nonce' });
const present = (revision = '1', messageId = '100'): RecoveryState => ({ message_id: messageId, state: 'present', revision, message: { ...archived(messageId), message_revision: revision } as never });
const page = (overrides: Partial<RecoveryPage> = {}): RecoveryPage => ({ database_history_epoch: epoch, channel_id: '10', after: '0', through: '1', floor: '0', next: '1', complete: true, projection_head: '1', changes: [{ kind: 'create', revision: '1', message_id: '100', archived_message: archived() }], states: [present()], ...overrides });
const request: RecoveryRequest = { channelId: '10', after: '0', knownIds: [] };
function memoryVault() {
  let rows = new Map<string, unknown>(); const key = (ns: string, id: string) => JSON.stringify([ns, id]);
  return { scope: { serverId: 'server', userId: '20' }, transact: async <T>(run: (tx: VaultTransaction) => Promise<T>) => {
    const next = new Map(rows); const tx: VaultTransaction = {
      get: async <V>(ns: string, id: string) => (next.get(key(ns, id)) as V | undefined) ?? null,
      list: async <V>(ns: string) => [...next].flatMap(([key, value]) => { const [namespace, id] = JSON.parse(key); return namespace === ns ? [{ id, value: value as V }] : []; }),
      put: (ns, id, value) => { next.set(key(ns, id), structuredClone(value)); }, remove: (ns, id) => { next.delete(key(ns, id)); },
    }; const result = await run(tx); rows = next; return result;
  } } as AccountVault;
}
const controller = () => { const abort = new AbortController(); return { signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted(), abort }; };
beforeEach(() => vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request: async (_name: string, options: { signal: AbortSignal }, run: () => Promise<unknown>) => { options.signal.throwIfAborted(); return run(); } } })));
afterEach(() => vi.unstubAllGlobals());
describe('owned authoritative recovery contract', () => {
  it('accepts bound encrypted archives and current state', () => expect(readRecoveryPage(page(), request, epoch)).toEqual(page()));
  it.each([
    ['history', { database_history_epoch: 'other' }], ['channel', { channel_id: '11' }], ['cursor', { after: '2' }], ['missing state', { states: [] }], ['missing committed mutations', { changes: [] }],
    ['unbounded cursor', { next: '900719925474099300000' }], ['nonadvancing page', { next: '0', complete: false }], ['future state', { states: [present('2')] }],
    ['plaintext archive', { changes: [{ ...page().changes[0], archived_message: { ...archived(), content: 'private text' } }] }],
  ])('rejects %s before persistence', (_label, bad) => expect(() => readRecoveryPage(page(bad as Partial<RecoveryPage>), request, epoch)).toThrow());
  it('requires an explicit state for every known cached ID', () => {
    expect(() => readRecoveryPage(page(), { ...request, knownIds: ['101'] }, epoch)).toThrow('omitted');
    expect(readRecoveryPage(page({ states: [present(), { message_id: '101', state: 'deleted', revision: '1' }] }), { ...request, knownIds: ['101'] }, epoch).states).toHaveLength(2);
  });
  it('holds newer authority separately while rejecting a moving chosen fence', () => {
    expect(() => readRecoveryPage(page({ through: '2' }), { ...request, through: '1' }, epoch)).toThrow('cursor');
    expect(readRecoveryPage(page({ projection_head: '3', states: [present('3')] }), { ...request, through: '1' }, epoch).through).toBe('1');
  });
  it('accepts the bound anonymous plaintext author projection without permitting anonymous encrypted archives', () => {
    const current = present(); if (current.state !== 'present') throw new Error('fixture');
    current.message = { ...current.message, content: 'anonymous guild text', e2ee: null, author: { id: 'anon:10:Quiet Fox', username: 'Quiet Fox', discriminator: '0' }, anonymous: { alias: 'Quiet Fox', is_anonymous: true, can_deanonymize: false } };
    expect(readRecoveryPage(page({ changes: [{ ...page().changes[0], archived_message: null }], states: [current] }), request, epoch)).toBeTruthy();
    current.message.author.id = 'anon:11:Quiet Fox';
    expect(() => readRecoveryPage(page({ states: [current] }), request, epoch)).toThrow('anonymous');
    expect(() => readRecoveryPage(page({ changes: [{ ...page().changes[0], archived_message: { ...archived(), author: { id: 'anon:10:Quiet Fox' } } }] }), request, epoch)).toThrow();
  });
  it('binds gap errors and preserves an unproven 404 as failure', async () => {
    const requestHttp = vi.fn().mockResolvedValue({ status: 409, data: { code: 'MESSAGE_RECOVERY_GAP', database_history_epoch: epoch, channel_id: '10', after: '0', floor: '9', head: '10', reason: 'retention' } });
    const transport = createMessageRecoveryTransport({ ...controller(), historyEpoch: epoch, request: requestHttp } as unknown as OperationContext);
    await expect(transport(request)).rejects.toBeInstanceOf(MessageRecoveryGapError);
    requestHttp.mockResolvedValueOnce({ status: 404, data: {} }); await expect(transport(request)).rejects.toThrow('did not confirm');
    requestHttp.mockResolvedValueOnce({ status: 409, data: { code: 'MESSAGE_RECOVERY_GAP', database_history_epoch: 'other' } }); await expect(transport(request)).rejects.toThrow('Invalid');
  });
  it('accepts a deleted-account current projection while retaining the original archived sender', async () => {
    const current = present(); if (current.state !== 'present') throw new Error('fixture');
    current.message.author = { ...current.message.author, id: '-1' };
    expect(readRecoveryPage(page({ states: [current] }), request, epoch)).toBeTruthy();
    const vault = memoryVault(); await vault.transact(tx => stageRecoveryPage(tx, page()));
    await expect(vault.transact(tx => stageRecoveryPage(tx, page({ states: [current] })))).resolves.toBeUndefined();
    expect(() => readRecoveryPage(page({ changes: [{ ...page().changes[0], archived_message: { ...archived(), author: { id: '-1' } } }] }), request, epoch)).toThrow();
  });
});
describe('durable fixed-fence recovery', () => {
  it('accepts a message from an instance system account, such as the Sports add-on posting a score', () => {
    const current = present(); if (current.state !== 'present') throw new Error('fixture');
    current.message = { ...current.message, e2ee: null, content: 'Touchdown — Chiefs 14, Colts 7', author: { ...current.message.author, id: '-7', username: 'Sports', bot: true } };
    expect(readRecoveryPage(page({ states: [current] }), request, epoch)).toBeTruthy();
  });

  it('resumes the original fence after a later page fails', async () => {
    const vault = memoryVault(); const lifetime = controller(); const fetchPage = vi.fn().mockResolvedValueOnce(page({ through: '2', complete: false, projection_head: '2' })).mockRejectedValueOnce(new Error('network lost'));
    await expect(recoverChannelMessages({ vault, lifetime, channelId: '10', knownIds: [], fetchPage })).rejects.toThrow('network lost');
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toEqual({ cursor: '1', through: '2', complete: false });
    fetchPage.mockResolvedValueOnce(page({ after: '1', through: '2', next: '2', projection_head: '9', changes: [{ kind: 'delete', revision: '2', message_id: '100', archived_message: null }], states: [{ message_id: '100', state: 'deleted', revision: '9' }] }));
    await expect(recoverChannelMessages({ vault, lifetime, channelId: '10', knownIds: [], fetchPage })).resolves.toBe('2');
    expect(fetchPage.mock.calls[2][0]).toEqual({ channelId: '10', after: '1', through: '2', knownIds: [] });
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toEqual({ cursor: '2', through: null, complete: true });
    expect(await vault.transact(tx => tx.list(RECOVERY_ARCHIVE_NAMESPACE))).toHaveLength(1);
  });
  it('atomically rolls back archive, authority and cursor when journal acceptance fails', async () => {
    const vault = memoryVault(); await expect(recoverChannelMessages({ vault, lifetime: controller(), channelId: '10', knownIds: [], fetchPage: async () => page(), stage: async () => { throw new Error('quota'); } })).rejects.toThrow('quota');
    for (const ns of [RECOVERY_CURSOR_NAMESPACE, RECOVERY_STATE_NAMESPACE, RECOVERY_ARCHIVE_NAMESPACE]) expect(await vault.transact(tx => tx.list(ns))).toEqual([]);
  });
  it('rejects a late page after account/history cancellation', async () => {
    const vault = memoryVault(); const lifetime = controller(); await expect(recoverChannelMessages({ vault, lifetime, channelId: '10', knownIds: [], fetchPage: async () => { lifetime.abort.abort(new Error('history changed')); return page(); } })).rejects.toThrow('history changed');
    expect(await vault.transact(tx => tx.list(RECOVERY_CURSOR_NAMESPACE))).toEqual([]);
  });
  it('audits 201 known IDs in bounded batches without chasing a moving projection head', async () => {
    const vault = memoryVault(); const knownIds = Array.from({ length: 201 }, (_, i) => String(i + 100)); let head = 1;
    const fetchPage = vi.fn(async (req: RecoveryRequest) => page({ after: req.after, changes: req.after === '0' ? page().changes : [], projection_head: String(head++), states: req.knownIds.map(message_id => ({ message_id, state: 'deleted', revision: String(head - 1) })) }));
    await recoverChannelMessages({ vault, lifetime: controller(), channelId: '10', knownIds, fetchPage });
    expect(fetchPage.mock.calls.map(([req]) => req.knownIds.length)).toEqual([100, 100, 1]); expect(fetchPage.mock.calls.slice(1).map(([req]) => req.through)).toEqual(['1', '1']);
    expect(await vault.transact(tx => tx.list(RECOVERY_STATE_NAMESPACE))).toHaveLength(201);
  });
  it('uses an explicit server-proven plaintext snapshot fence to audit known IDs without inventing ratchet history', async () => {
    const vault = memoryVault();
    const fetchPage = vi.fn(async (req: RecoveryRequest) => page({ after: req.after, through: '9', next: '9', projection_head: '9', changes: [], states: [{ message_id: '100', state: 'deleted', revision: '9' }] }));
    await recoverChannelMessages({ vault, lifetime: controller(), channelId: '10', knownIds: ['100'], plaintextSnapshotAt: '9', fetchPage });
    expect(fetchPage).toHaveBeenCalledWith({ channelId: '10', after: '9', through: '9', knownIds: ['100'] });
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toEqual({ cursor: '9', through: null, complete: true });
    expect(await vault.transact(tx => tx.list(RECOVERY_ARCHIVE_NAMESPACE))).toEqual([]);
    expect(await vault.transact(tx => tx.list(RECOVERY_STATE_NAMESPACE))).toHaveLength(1);
  });
  it('never regresses a durable cursor for a stale plaintext snapshot or live audit fence', async () => {
    const vault = memoryVault(); await vault.transact(async tx => tx.put(RECOVERY_CURSOR_NAMESPACE, '10', { cursor: '10', through: null, complete: true }));
    const fetchPage = vi.fn(async (req: RecoveryRequest) => page({ after: req.after, through: req.through, next: req.after, projection_head: '10', changes: [], states: [] }));
    await expect(recoverChannelMessages({ vault, lifetime: controller(), channelId: '10', knownIds: [], plaintextSnapshotAt: '8', fetchPage })).resolves.toBe('10');
    await expect(recoverChannelMessages({ vault, lifetime: controller(), channelId: '10', knownIds: [], through: '8', fetchPage })).resolves.toBe('10');
    expect(fetchPage.mock.calls.map(([req]) => [req.after, req.through])).toEqual([['10', '10'], ['10', '10']]);
  });
  it('ignores older authority and rejects resurrection after a durable tombstone', async () => {
    const vault = memoryVault(); await vault.transact(tx => stageRecoveryPage(tx, page({ projection_head: '2', states: [{ message_id: '100', state: 'deleted', revision: '2' }] })));
    await vault.transact(tx => stageRecoveryPage(tx, page())); expect(await vault.transact(tx => tx.get(RECOVERY_STATE_NAMESPACE, '["10","100"]'))).toMatchObject({ value: { state: 'deleted' } });
    await expect(vault.transact(tx => stageRecoveryPage(tx, page({ projection_head: '3', states: [present('3')] })))).rejects.toThrow('cannot be recreated');
  });
});


describe('contiguous live channel mutation acceptance', () => {
  it('requires the complete initial fence and refuses a missing committed revision', async () => {
    const vault = memoryVault(); const message = { ...archived(), message_revision: '3' } as never;
    expect(await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'create', message }))).toBe('gap');
    await vault.transact(async tx => tx.put(RECOVERY_CURSOR_NAMESPACE, '10', { cursor: '1', through: null, complete: true }));
    expect(await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'create', message }))).toBe('gap');
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toMatchObject({ cursor: '1' });
    expect(await vault.transact(tx => tx.list(RECOVERY_ARCHIVE_NAMESPACE))).toEqual([]);
  });
  it('commits the exact next encrypted body with its cursor, then ignores a stale replay after delete', async () => {
    const vault = memoryVault(); await vault.transact(async tx => tx.put(RECOVERY_CURSOR_NAMESPACE, '10', { cursor: '0', through: null, complete: true }));
    const message = { ...archived(), message_revision: '1' } as never;
    expect(await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'create', message }))).toBe('accepted');
    expect(await vault.transact(tx => tx.list(RECOVERY_ARCHIVE_NAMESPACE))).toHaveLength(1);
    expect(await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'delete', channelId: '10', messageId: '100', revision: '2' }))).toBe('accepted');
    expect(await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'create', message }))).toBe('duplicate');
    expect(await vault.transact(tx => tx.get(RECOVERY_STATE_NAMESPACE, '["10","100"]'))).toMatchObject({ value: { state: 'deleted' } });
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toMatchObject({ cursor: '2' });
  });
  it('accepts the same live/archive envelope despite null fields and JSON key order, but rejects changed ciphertext', async () => {
    const vault = memoryVault(); await vault.transact(async tx => tx.put(RECOVERY_CURSOR_NAMESPACE, '10', { cursor: '0', through: null, complete: true }));
    const message = { ...archived(), message_revision: '1', e2ee: { ciphertext: 'ciphertext', version: 2, nonce: 'iv' } } as never;
    await vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'create', message }));
    const replay = page({ changes: [{ ...page().changes[0], archived_message: { ...archived(), edited_timestamp: null, e2ee: { version: 2, nonce: 'iv', ciphertext: 'ciphertext', header: null } } }], states: [] });
    await expect(vault.transact(tx => stageRecoveryPage(tx, replay))).resolves.toBeUndefined();
    replay.changes[0].archived_message!.e2ee.ciphertext = 'changed';
    await expect(vault.transact(tx => stageRecoveryPage(tx, replay))).rejects.toThrow('immutable');
  });
  it('rolls back the live cursor if durable tombstone acceptance fails', async () => {
    const vault = memoryVault(); await vault.transact(async tx => tx.put(RECOVERY_CURSOR_NAMESPACE, '10', { cursor: '0', through: null, complete: true }));
    await expect(vault.transact(tx => stageLiveRecoveryMutation(tx, { kind: 'delete', channelId: '10', messageId: '100', revision: '1' }, async () => { throw new Error('quota'); }))).rejects.toThrow('quota');
    expect(await vault.transact(tx => tx.get(RECOVERY_CURSOR_NAMESPACE, '10'))).toMatchObject({ cursor: '0' });
    expect(await vault.transact(tx => tx.list(RECOVERY_STATE_NAMESPACE))).toEqual([]);
  });
});
