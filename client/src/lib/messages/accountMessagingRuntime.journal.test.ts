import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import type { AccountScope } from '../serverScope';
import type { Message } from '../../types';

const fixture = vi.hoisted(() => ({ openLocal: vi.fn(), openIdentity: vi.fn(), decrypt: vi.fn(), acknowledge: vi.fn(), review: vi.fn(), preparedAfterDeletion: vi.fn(), sent: vi.fn(), recovery: vi.fn() }));
vi.mock('../crypto/deviceAccountVault', () => ({ openDeviceAccountVault: fixture.openLocal }));
vi.mock('../crypto/accountVaultSession', () => ({ openAccountVault: fixture.openIdentity }));
vi.mock('../crypto/prekeyEnrollment', async importOriginal => ({ ...await importOriginal<object>(), createAccountPrekeyEnrollment: () => ({ ensure: async () => {} }) }));
vi.mock('./legacyRecovery', async importOriginal => ({ ...await importOriginal<object>(), migrateLegacyMessageDrafts: async () => {} }));
vi.mock('./legacySignalRecovery', async importOriginal => ({ ...await importOriginal<object>(), assertLegacySignalReviewed: fixture.review }));
vi.mock('./durableDm', () => ({ createDurableDm: (vault: AccountVault) => ({
  decrypt: fixture.decrypt, acknowledgeSend: fixture.acknowledge,
  // No encrypted attachments are staged in this fixture, so the producer's
  // pre-preparation upload pass has nothing to do.
  uploadStagedAttachments: async () => {},
  markExternalRemoval: async (channelId: string) => vault.transact(async tx => tx.put('test.removals', channelId, true)),
  assertPreparedDeliveryAllowed: async (channelId: string) => vault.transact(async tx => { if (await tx.get('test.removals', channelId)) throw new Error('Unresolved generation removal'); }),
  prepareIntent: async (tx: VaultTransaction, intent: { nonce: string; channelId: string }) => {
    fixture.preparedAfterDeletion(await tx.get('test.removals', intent.channelId));
    tx.remove('test.removals', intent.channelId);
    return { nonce: intent.nonce, content: '', e2ee: { version: 2, nonce: 'payload-nonce', ciphertext: 'prepared-ciphertext', header: 'header' } };
  },
}) }));

import { AccountMessagingRuntime } from './accountMessagingRuntime';
import { MissingPrivatePrekeyError } from '../crypto/sessionManager';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { useAccountStore } from '../../stores/accountStore';
import { useChannelStore } from '../../stores/channelStore';
import { DatabaseHistoryExpiredError } from '../operationContext';
import { acceptDatabaseHistoryEpoch, clearDatabaseHistoryMemory } from '../databaseHistory';

const scope = { serverId: '__local__', userId: '1' };
const epochs = { first: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', second: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
const key = (namespace: string, id: string) => JSON.stringify([namespace, id]);
function memoryVault(owner: AccountScope) {
  const rows = new Map<string, unknown>(); let fail: Error | null = null; let tail: Promise<unknown> = Promise.resolve();
  const vault = { scope: owner, transact<T>(run: (tx: VaultTransaction) => Promise<T>) {
    const pending = tail.then(async () => {
      if (fail) throw fail;
      const next = new Map(rows);
      const tx: VaultTransaction = {
        get: async <V>(ns: string, id: string) => (next.get(key(ns, id)) as V | undefined) ?? null,
        list: async <V>(ns: string) => [...next].flatMap(([address, value]) => { const [namespace, id] = JSON.parse(address); return namespace === ns ? [{ id, value: structuredClone(value) as V }] : []; }),
        put: (ns, id, value) => { next.set(key(ns, id), structuredClone(value)); },
        remove: (ns, id) => { next.delete(key(ns, id)); },
      };
      const result = await run(tx); if (fail) throw fail;
      rows.clear(); for (const [id, value] of next) rows.set(id, value);
      return result;
    });
    tail = pending.catch(() => {}); return pending;
  } } as AccountVault;
  return { vault, rows, fail: (error: Error | null) => { fail = error; } };
}
function session(vault: AccountVault, epoch = epochs.first) {
  const abort = new AbortController();
  const assertCurrent = () => abort.signal.throwIfAborted();
  return { vault, privateKey: new Uint8Array(32).fill(1), signal: abort.signal, assertCurrent,
    context: { scope, historyEpoch: epoch, signal: abort.signal, assertCurrent, api: {}, request: vi.fn(async (config: { data: string; method: string; params?: { after: string; through?: string; known_ids: string } }) => {
      if (config.method === 'GET') { const response = await fixture.recovery(config); return { ...response, data: { ...response.data, database_history_epoch: epoch } }; }
      fixture.sent(config); const request = JSON.parse(config.data);
      return { status: 201, data: { ...message('300'), ...request, author: { id: '1' } } };
    }) },
    dispose: () => abort.abort(new Error('Identity locked')), abort };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const message = (id: string): Message => ({ id, channel_id: '10', author: { id: '2', username: 'Bob', discriminator: '0001' }, content: 'must not persist transport plaintext',
  e2ee: { version: 2, nonce: 'nonce', ciphertext: `cipher-${id}`, header: 'header' }, tts: false, mention_everyone: false, pinned: false, type: 0, attachments: [], reactions: [] });
let local: ReturnType<typeof memoryVault>; let identity: ReturnType<typeof memoryVault>; let runtime: AccountMessagingRuntime;
beforeEach(async () => {
  vi.clearAllMocks();
  fixture.recovery.mockReset().mockImplementation(async (config: { params: { after: string; through?: string; known_ids: string } }) => {
    const { after, through = after, known_ids } = config.params;
    return { status: 200, data: { database_history_epoch: epochs.first, channel_id: '10', after, through, floor: '0', next: through, complete: true, projection_head: through, changes: [],
      states: known_ids.split(',').filter(Boolean).map(message_id => ({ message_id, state: 'present', revision: '0', message: { ...message(message_id), message_revision: '0' } })) } };
  });
  fixture.decrypt.mockReset().mockResolvedValue('decrypted'); fixture.review.mockReset().mockResolvedValue(undefined);
  const locks = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { locks: { request: (name: string, options: { signal?: AbortSignal }, run: () => Promise<unknown>) => {
    const pending = (locks.get(name) ?? Promise.resolve()).catch(() => {}).then(() => { options.signal?.throwIfAborted(); return run(); });
    locks.set(name, pending); return pending;
  } } }));
  useServerListStore.setState({ activeServerId: '__local__', servers: [] });
  useAuthStore.setState({ token: 'token', user: { id: '1', username: 'Alice', public_key: '11'.repeat(32) } as never });
  useAccountStore.setState({ isUnlocked: false });
  useChannelStore.getState().reset();
  vi.spyOn(useChannelStore.getState(), 'fetchDmChannels').mockResolvedValue(undefined);
  useChannelStore.getState().addChannel({ id: '10', type: 1, position: 0, name: 'Bob', recipient: { id: '2', public_key: '22'.repeat(32) } } as never, scope);
  local = memoryVault(scope); identity = memoryVault(scope);
  fixture.openLocal.mockReset().mockImplementation(async () => session(local.vault));
  fixture.openIdentity.mockReset().mockImplementation(async () => session(identity.vault));
  runtime = new AccountMessagingRuntime(scope); await runtime.startLocal(); await runtime.acceptHandshake();
});
afterEach(() => { runtime.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); clearDatabaseHistoryMemory(); });

describe('production encrypted event journal', () => {
  it('commits encrypted envelopes with no transport plaintext while identity is locked, idempotently', async () => {
    await runtime.ingestEncryptedMessage(message('100')); await runtime.ingestEncryptedMessage(message('100'));
    const rows = await local.vault.transact(tx => tx.list<Message>('messages.encrypted-inbox'));
    expect(rows).toHaveLength(1); expect(rows[0].value).toMatchObject({ id: '100', content: '', e2ee: message('100').e2ee });
    expect(fixture.decrypt).not.toHaveBeenCalled();
  });
  it('does not reinsert historical creation receipts after reload, but publishes newly confirmed sends', async () => {
    runtime.dispose();
    const old = { nonce: 'old', channelId: '10', acknowledgedAt: '2026-09-11T00:00:00Z', result: { kind: 'message', message: message('100') } };
    await local.vault.transact(async tx => tx.put('messages.delivery-receipts', 'old', old));
    runtime = new AccountMessagingRuntime(scope); const events: unknown[] = [];
    runtime.subscribeMessages(event => { if (event.kind !== 'authoritative') events.push(event); }); await runtime.startLocal(); await runtime.acceptHandshake();
    expect(events).toEqual([]);
    await local.vault.transact(async tx => tx.put('messages.delivery-receipts', 'new', { ...old, nonce: 'new', result: { kind: 'message', message: message('101') } }));
    await runtime.refresh();
    expect(events).toEqual([{ kind: 'create', message: { ...message('101'), message_revision: '0' } }]);
  });
  it('rejects checkpoint acceptance when encrypted persistence fails', async () => {
    local.fail(new Error('Device vault quota exhausted'));
    await expect(runtime.ingestEncryptedMessage(message('100'))).rejects.toThrow('quota exhausted');
    expect([...local.rows].some(([id]) => id.includes('messages.encrypted-inbox'))).toBe(false);
    local.fail(null);
    await expect(runtime.ingestEncryptedMessage(message('100'))).resolves.toBeUndefined();
  });
  it('refreshes account-owned DM metadata when a peer enrolls after the conversation opens', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    useChannelStore.getState().updateChannel({ id: '10', recipient: { id: '2', public_key: null } } as never, scope);
    const fetch = vi.spyOn(useChannelStore.getState(), 'fetchDmChannels').mockImplementation(async captured => {
      expect(captured).toEqual(scope);
      useChannelStore.getState().updateChannel({ id: '10', recipient: { id: '2', public_key: '22'.repeat(32) } } as never, scope);
    });
    await runtime.ingestEncryptedMessage(message('100'));
    expect(fetch).toHaveBeenCalledOnce();
    expect(fixture.decrypt).toHaveBeenCalledWith('10', { id: '2', publicKey: '22'.repeat(32) }, message('100').e2ee, '100');
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toEqual([]);
  });
  it('drains an envelope that arrives while an earlier decrypt is pending', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    const first = deferred<string>(); fixture.decrypt.mockReturnValueOnce(first.promise);
    const initial = runtime.ingestEncryptedMessage(message('100'));
    await vi.waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
    const following = runtime.ingestEncryptedMessage(message('101'));
    await vi.waitFor(() => expect([...local.rows].filter(([id]) => id.includes('messages.encrypted-inbox'))).toHaveLength(2));
    first.resolve('first'); await Promise.all([initial, following]);
    expect(fixture.decrypt).toHaveBeenCalledTimes(2);
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toEqual([]);
  });
  it('retains a failed encrypted envelope for a later recovery drain', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    fixture.decrypt.mockRejectedValueOnce(new Error('Recover peer session'));
    await runtime.ingestEncryptedMessage(message('100'));
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toHaveLength(1);
    await runtime.ingestEncryptedMessage(message('101'));
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toEqual([]);
  });
  // The other half of that rule: a message sealed to a key this device has
  // never held is not evidence of anything. It is what history looks like after
  // a recovery-phrase restore, and fencing the conversation for it would leave
  // the restored device unable to send at all — and would hand anyone who can
  // post ciphertext a way to silence a conversation by naming a prekey id
  // nobody has.
  it('leaves a conversation usable when a message was sealed to a key this device never held', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    fixture.decrypt.mockRejectedValueOnce(new MissingPrivatePrekeyError('never held'));
    await runtime.ingestEncryptedMessage(message('100'));
    const state = runtime.store.getState();
    expect(state.encryptionError).toBeNull();
    expect(state.channelErrors?.['10']).toBeUndefined();
    // The envelope stays, in case the account's encrypted backup is imported.
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toHaveLength(1);
    // And the next message in the same conversation is still read.
    await runtime.ingestEncryptedMessage(message('101'));
    expect(fixture.decrypt).toHaveBeenCalledTimes(3);
  });
  // A failed AEAD open is a DOMException named OperationError whose message is
  // the empty string; the composer's recovery notice and the per-channel error
  // map both gate on non-empty text, so an empty message reported the failure
  // and silenced it at once. A tampered ciphertext must never be quiet.
  it('reports a ciphertext that fails authentication with real text, never the empty string', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    const authenticationFailure = Object.assign(new Error(''), { name: 'OperationError' });
    fixture.decrypt.mockRejectedValueOnce(authenticationFailure);
    await runtime.ingestEncryptedMessage(message('100'));
    const state = runtime.store.getState();
    expect(state.encryptionError).toBeTruthy();
    expect(state.encryptionError).toMatch(/did not decrypt/);
    expect(state.channelErrors?.['10']).toMatch(/did not decrypt/);
  });
  it('does not retire the journal when an old identity decrypt finishes after lock', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    const first = deferred<string>(); fixture.decrypt.mockReturnValueOnce(first.promise);
    const ingestion = runtime.ingestEncryptedMessage(message('100'));
    const failure = expect(ingestion).rejects.toThrow('Identity locked');
    await vi.waitFor(() => expect(fixture.decrypt).toHaveBeenCalledTimes(1));
    useAccountStore.setState({ isUnlocked: false }); await runtime.reconcile();
    first.resolve('late plaintext'); await failure;
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toHaveLength(1);
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toEqual([]);
  });
  it('applies a deletion from a locked peer window before an unlocked sender prepares its next intent', async () => {
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    await local.vault.transact(async tx => tx.put('messages.deleted', JSON.stringify(['10', '100']), { observedAt: 1 }));
    await runtime.send('10', 'fresh encrypted text');
    await vi.waitFor(() => expect(fixture.sent).toHaveBeenCalledTimes(1));
    expect(fixture.preparedAfterDeletion).toHaveBeenCalledWith(true);
    expect(await identity.vault.transact(tx => tx.get('messages.deleted', JSON.stringify(['10', '100'])))).not.toBeNull();
    expect(JSON.parse(fixture.sent.mock.calls[0][0].data)).toMatchObject({ content: '', e2ee: { ciphertext: 'prepared-ciphertext' } });
  });
  it('holds current-history envelopes and deletions separately until explicit review', async () => {
    runtime.dispose();
    local.rows.set(key('messages.runtime-history', 'current'), { epoch: epochs.first, initialLease: null });
    local.rows.set(key('messages.deleted', JSON.stringify(['10', '100'])), { observedAt: 1 });
    fixture.openLocal.mockImplementation(async () => session(local.vault, epochs.second));
    runtime = new AccountMessagingRuntime(scope); await runtime.startLocal();
    expect(runtime.store.getState().storage).toBe('review');
    await runtime.ingestEncryptedMessage(message('100')); await runtime.observeDeleted('10', '101');
    expect((await runtime.filterDeletedMessages([message('100'), message('101')])).map(row => row.id)).toEqual(['100']);
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toEqual([]);
    await runtime.preservePreviousHistoryForReview();
    expect(await local.vault.transact(tx => tx.list('messages.encrypted-inbox'))).toHaveLength(1);
    expect((await runtime.filterDeletedMessages([message('100'), message('101')])).map(row => row.id)).toEqual(['100']);
  });
});

function installFeed(changes: import('./messageRecovery').RecoveryPage['changes'], states: import('./messageRecovery').RecoveryState[], head: string) {
  fixture.recovery.mockImplementation(async (config: { params: { after: string; through?: string; known_ids: string } }) => {
    const { after, through = head, known_ids } = config.params;
    const selected = changes.filter(row => BigInt(row.revision) > BigInt(after) && BigInt(row.revision) <= BigInt(through));
    const required = new Set([...known_ids.split(',').filter(Boolean), ...selected.map(row => row.message_id)]);
    return { status: 200, data: { database_history_epoch: epochs.first, channel_id: '10', after, through, floor: '0', next: through, complete: true, projection_head: head,
      changes: selected, states: states.filter(row => required.has(row.message_id)) } };
  });
}
const archive = (id: string) => ({ ...message(id), content: '' as const, e2ee: message(id).e2ee! });
const state = (id: string, revision: string): import('./messageRecovery').RecoveryState => ({ message_id: id, state: 'present', revision, message: { ...message(id), content: '', message_revision: revision } });

describe('production authoritative recovery gate', () => {
  it('does not let an old handshake adopt a replacement connection while storage opens', async () => {
    runtime.dispose(); const opened = deferred<ReturnType<typeof session>>(); fixture.openLocal.mockReturnValueOnce(opened.promise);
    runtime = new AccountMessagingRuntime(scope);
    const old = runtime.acceptHandshake(); const failure = expect(old).rejects.toThrow('connection changed');
    await vi.waitFor(() => expect(fixture.openLocal).toHaveBeenCalledTimes(2));
    runtime.pauseForRecovery(); opened.resolve(session(local.vault)); await failure;
    expect(runtime.store.getState().synchronization).toBe('awaiting-handshake');
    expect(fixture.sent).not.toHaveBeenCalled();
  });
  it('keeps a matching-history reloaded queue paused until the authenticated fixed fence commits', async () => {
    const { enqueueMessageIntent } = await import('./durableOutbox');
    runtime.dispose();
    useChannelStore.getState().reset(); useChannelStore.getState().addChannel({ id: '10', type: 0, channel_type: 0, guild_id: '50' } as never, scope);
    await enqueueMessageIntent(local.vault, '10', 'queued text', { encryption: { kind: 'plain' } });
    runtime = new AccountMessagingRuntime(scope); await runtime.startLocal();
    expect(runtime.store.getState().synchronization).toBe('awaiting-handshake');
    await runtime.writeDraft('10', { revision: 'new', content: 'still editable before handshake' });
    await expect(runtime.send('10', 'not yet')).rejects.toThrow('authenticated');
    const response = deferred<unknown>(); fixture.recovery.mockReturnValueOnce(response.promise);
    const recovery = runtime.acceptHandshake();
    await vi.waitFor(() => expect(fixture.recovery).toHaveBeenCalledOnce());
    expect(fixture.sent).not.toHaveBeenCalled();
    response.resolve({ status: 200, data: { database_history_epoch: epochs.first, channel_id: '10', after: '0', through: '0', floor: '0', next: '0', complete: true, projection_head: '0', changes: [], states: [] } });
    await recovery; await vi.waitFor(() => expect(fixture.sent).toHaveBeenCalledOnce());
    expect(await runtime.readDraft('10')).toEqual({ revision: 'new', content: 'still editable before handshake' });
  });
  it('recovers an omitted starter before a dependent message while its current deletion stays hidden', async () => {
    installFeed([
      { kind: 'create', revision: '1', message_id: '100', archived_message: archive('100') },
      { kind: 'create', revision: '2', message_id: '101', archived_message: archive('101') },
      { kind: 'delete', revision: '3', message_id: '100', archived_message: null },
    ], [{ message_id: '100', state: 'deleted', revision: '3' }, state('101', '2')], '3');
    const result = await runtime.acceptGatewayMutation({ kind: 'delete', channelId: '10', messageId: '100', revision: '3' });
    expect(result).toBeNull(); expect(fixture.decrypt).not.toHaveBeenCalled();
    expect(await local.vault.transact(tx => tx.list('messages.recovery-envelopes'))).toHaveLength(2);
    useAccountStore.setState({ isUnlocked: true }); await runtime.enroll();
    expect(fixture.decrypt.mock.calls.map(args => args[3])).toEqual(['100', '101']);
    expect(await local.vault.transact(tx => tx.list('messages.recovery-envelopes'))).toEqual([]);
    expect((await runtime.filterDeletedMessages([message('100'), message('101')])).map(row => row.id)).toEqual(['101']);
  });
  it('rejects a failed page commit and replays the immutable starter after reload', async () => {
    installFeed([{ kind: 'create', revision: '1', message_id: '100', archived_message: archive('100') }], [state('100', '1')], '1');
    local.fail(new Error('quota'));
    await expect(runtime.acceptGatewayMutation({ kind: 'create', channelId: '10', messageId: '100', revision: '1', message: { ...message('100'), message_revision: '1' } })).rejects.toThrow('quota');
    local.fail(null); expect(await local.vault.transact(tx => tx.list('messages.recovery-cursors'))).toEqual([]);
    runtime.dispose(); runtime = new AccountMessagingRuntime(scope); await runtime.startLocal();
    runtime.registerKnownMessages(() => [message('100')]);
    await runtime.acceptHandshake();
    expect(await local.vault.transact(tx => tx.list('messages.recovery-envelopes'))).toHaveLength(1);
  });
  it('audits an unknown stale HTTP row even when its revision is below the durable cursor', async () => {
    await local.vault.transact(async tx => tx.put('messages.recovery-cursors', '10', { cursor: '10', through: null, complete: true }));
    installFeed([], [{ message_id: '100', state: 'deleted', revision: '10' }], '10');
    expect(await runtime.filterDeletedMessages([{ ...message('100'), e2ee: null, message_revision: '0' }])).toEqual([]);
    expect(fixture.recovery).toHaveBeenCalledWith(expect.objectContaining({ params: expect.objectContaining({ after: '10', through: '10', known_ids: '100' }) }));
  });
  it('never commits a paused connection’s late recovery page into its replacement', async () => {
    const response = deferred<unknown>(); fixture.recovery.mockReturnValueOnce(response.promise);
    const pending = runtime.acceptGatewayMutation({ kind: 'delete', channelId: '10', messageId: '100', revision: '1' });
    const failure = expect(pending).rejects.toThrow('connection changed');
    await vi.waitFor(() => expect(fixture.recovery).toHaveBeenCalledOnce()); runtime.pauseForRecovery();
    response.resolve({ status: 200, data: { database_history_epoch: epochs.first, channel_id: '10', after: '0', through: '1', floor: '0', next: '1', complete: true, projection_head: '1',
      changes: [{ kind: 'delete', revision: '1', message_id: '100', archived_message: null }], states: [{ message_id: '100', state: 'deleted', revision: '1' }] } });
    await failure;
    expect(await local.vault.transact(tx => tx.list('messages.recovery-cursors'))).toEqual([]);
    expect(runtime.store.getState().synchronization).toBe('awaiting-handshake');
  });
  it('keeps a future edited body behind the fixed fence and releases it when its live revision arrives', async () => {
    const edited = { ...archive('100'), e2ee: { ...archive('100').e2ee, ciphertext: 'independent-edit' } };
    installFeed([
      { kind: 'create', revision: '1', message_id: '100', archived_message: archive('100') },
      { kind: 'update', revision: '2', message_id: '100', archived_message: edited },
    ], [{ message_id: '100', state: 'present', revision: '2', message: { ...edited, message_revision: '2' } }], '2');
    const first = await runtime.acceptGatewayMutation({ kind: 'create', channelId: '10', messageId: '100', revision: '1', message: { ...message('100'), message_revision: '1' } });
    expect(first).toMatchObject({ id: '100', content: 'Loading message…', e2ee: null });
    expect((await local.vault.transact(tx => tx.get<{ cursor: string }>('messages.recovery-cursors', '10')))?.cursor).toBe('1');
    const second = await runtime.acceptGatewayMutation({ kind: 'update', channelId: '10', messageId: '100', revision: '2', message: { ...edited, message_revision: '2' } });
    expect(second?.e2ee?.ciphertext).toBe('independent-edit');
  });
  it('retains an inaccessible channel for review without inventing deletion proof or blocking the account handshake', async () => {
    runtime.registerKnownMessages(() => [message('100')]);
    fixture.recovery.mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { isAxiosError: true, response: { status: 403 } }));
    await runtime.acceptHandshake();
    expect(runtime.store.getState().synchronization).toBe('ready');
    expect(runtime.store.getState().channelErrors?.['10']).toContain('unavailable');
    expect(await local.vault.transact(tx => tx.list('messages.deleted'))).toEqual([]);
    expect(await local.vault.transact(tx => tx.get('messages.recovery-blocks', '10'))).toEqual({ reason: 'unavailable', status: 403 });
  });
  it('uses a bound plaintext snapshot after a retention gap without requiring Signal enrollment', async () => {
    useChannelStore.getState().reset(); useChannelStore.getState().addChannel({ id: '10', type: 0, channel_type: 0, guild_id: '50' } as never, scope);
    runtime.registerKnownMessages(() => [{ ...message('100'), e2ee: null }]);
    fixture.recovery.mockResolvedValueOnce({ status: 409, data: { code: 'MESSAGE_RECOVERY_GAP', database_history_epoch: epochs.first, channel_id: '10', after: '0', floor: '5', head: '10', reason: 'retention' } });
    installFeed([], [{ message_id: '100', state: 'deleted', revision: '10' }], '10');
    await runtime.acceptHandshake();
    expect(runtime.store.getState()).toMatchObject({ synchronization: 'ready', encryption: 'locked' });
    expect(runtime.store.getState().channelErrors).toEqual({});
    expect((await local.vault.transact(tx => tx.get<{ cursor: string }>('messages.recovery-cursors', '10')))?.cursor).toBe('10');
    expect(await runtime.filterDeletedMessages([{ ...message('100'), e2ee: null }])).toEqual([]);
  });
  it('audits a recovery-required event after an unrelated in-flight fixed fence completes', async () => {
    const first = deferred<unknown>(); fixture.recovery.mockReturnValueOnce(first.promise);
    installFeed([{ kind: 'delete', revision: '1', message_id: '100', archived_message: null }], [{ message_id: '100', state: 'deleted', revision: '1' }], '1');
    const history = runtime.prepareChannelHistory('10');
    await vi.waitFor(() => expect(fixture.recovery).toHaveBeenCalledOnce());
    const incoming = runtime.acceptGatewayMutation({ kind: 'delete', channelId: '10', messageId: '100', recoveryRequired: true });
    first.resolve({ status: 200, data: { database_history_epoch: epochs.first, channel_id: '10', after: '0', through: '0', next: '0', floor: '0', complete: true, projection_head: '0', changes: [], states: [] } });
    await Promise.all([history, incoming]);
    expect(fixture.recovery).toHaveBeenCalledTimes(2);
    expect(fixture.recovery.mock.calls[1][0].params).toMatchObject({ after: '0', known_ids: '100' });
    expect(await local.vault.transact(tx => tx.get('messages.deleted', '["10","100"]'))).not.toBeNull();
  });
  // Every first login accepts the account's first history epoch from READY,
  // which cancels the vault open already in flight. The cancellation lands
  // before the session exists — so before `invalidateLocal` can move the
  // generation — and the coalesced handshake used to inherit the rejection,
  // rejecting READY and forcing a full gateway reconnect on every first login.
  it('retries an open cancelled by the account\'s own first authenticated history instead of failing the handshake', async () => {
    runtime.dispose();
    let attempts = 0;
    fixture.openLocal.mockReset().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) throw new DatabaseHistoryExpiredError();
      return session(local.vault);
    });
    runtime = new AccountMessagingRuntime(scope);
    const cancelled = runtime.startLocal();
    await expect(runtime.acceptHandshake()).resolves.toBeUndefined();
    await expect(cancelled).rejects.toBeInstanceOf(DatabaseHistoryExpiredError);
    expect(attempts).toBe(2);
    expect(runtime.store.getState().storage).toBe('ready');
    expect(runtime.store.getState().synchronization).toBe('ready');
  });
  // The abort that acceptance raises lands wherever the open happens to be, and
  // every step reports it in its own words — a cancelled IndexedDB key write, a
  // vault closed under a transaction. Recognising the cancellation only by its
  // error class therefore left most of the open reporting a storage failure,
  // and READY still reconnected the gateway, intermittently, on a fresh login.
  it('retries an open cancelled by its own history even when the cancellation is not reported as one', async () => {
    runtime.dispose();
    let attempts = 0;
    fixture.openLocal.mockReset().mockImplementation(async () => {
      attempts += 1;
      if (attempts === 1) {
        acceptDatabaseHistoryEpoch(scope, epochs.first);
        throw new Error('Encrypted account storage is closed. Unlock the account to continue.');
      }
      return session(local.vault);
    });
    runtime = new AccountMessagingRuntime(scope);
    const cancelled = runtime.startLocal();
    await expect(runtime.acceptHandshake()).resolves.toBeUndefined();
    await expect(cancelled).rejects.toThrow('Encrypted account storage is closed');
    expect(attempts).toBe(2);
    expect(runtime.store.getState().storage).toBe('ready');
    expect(runtime.store.getState().synchronization).toBe('ready');
  });
});
