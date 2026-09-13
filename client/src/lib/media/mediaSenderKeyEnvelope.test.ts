import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex } from '../crypto/util';
import type { OperationContext } from '../operationContext';
import type { VaultTransaction } from '../crypto/accountVault';
import type { AccountScope } from '../serverScope';
import { useChannelStore } from '../../stores/channelStore';
import { useMemberStore } from '../../stores/memberStore';
import { useServerListStore } from '../../stores/serverListStore';
import { wrapMediaSenderKeyForRecipient, unwrapDeliveredMediaSenderKey } from './mediaSenderKeyEnvelope';
import { wrapSenderKeyForRecipients } from './engineShared';

const fixture = vi.hoisted(() => ({ open: vi.fn(), legacy: vi.fn() }));
vi.mock('../crypto/accountVaultSession', () => ({ openAccountVault: fixture.open }));
vi.mock('../secureStorage', () => ({ readStoredValueForMigration: fixture.legacy }));
const alice = { serverId: 'server-a', userId: '100' }; const bob = { serverId: 'server-a', userId: '200' };
const privateKeys = new Map<string, Uint8Array>(); const records = new Map<string, Map<string, unknown>>();
const ownerKey = (scope: AccountScope) => JSON.stringify([scope.serverId, scope.userId]);
const publicKey = (scope: AccountScope) => bytesToHex(ed25519.getPublicKey(privateKeys.get(ownerKey(scope))!));
function context(scope: AccountScope) {
  const abort = new AbortController();
  return { scope, historyEpoch: 'history-a', signal: abort.signal, assertCurrent: () => abort.signal.throwIfAborted(), abort } as unknown as OperationContext & { abort: AbortController };
}
function peerFor(owner: AccountScope, peer: AccountScope) {
  useMemberStore.setState(state => ({ members: new Map([...state.members, [JSON.stringify([owner.serverId, owner.userId, 'guild']), [{ user: { id: peer.userId, public_key: publicKey(peer) } } as never]]]) }));
}
beforeEach(() => {
  vi.clearAllMocks(); records.clear(); privateKeys.clear();
  privateKeys.set(ownerKey(alice), ed25519.utils.randomSecretKey()); privateKeys.set(ownerKey(bob), ed25519.utils.randomSecretKey());
  useChannelStore.setState({ channelsById: {} }); useMemberStore.setState({ members: new Map() });
  useServerListStore.setState({ activeServerId: 'unrelated-active-server', servers: [] });
  peerFor(alice, bob); peerFor(bob, alice); fixture.legacy.mockReset().mockResolvedValue(null);
  fixture.open.mockReset().mockImplementation(async (scope: AccountScope) => {
    const owned = context(scope); const key = ownerKey(scope); let rows = records.get(key);
    if (!rows) { rows = new Map(); records.set(key, rows); }
    const vault = { scope, transact: async <T>(run: (tx: VaultTransaction) => Promise<T>) => {
      const next = new Map(rows); const tx: VaultTransaction = {
        get: async <V>(ns: string, id: string) => (next.get(JSON.stringify([ns, id])) as V | undefined) ?? null,
        list: async () => [], put: (ns, id, value) => { next.set(JSON.stringify([ns, id]), structuredClone(value)); }, remove: (ns, id) => { next.delete(JSON.stringify([ns, id])); },
      };
      const result = await run(tx); owned.assertCurrent(); rows!.clear(); for (const [id, value] of next) rows!.set(id, value); return result;
    } };
    return { vault, context: owned, privateKey: privateKeys.get(key), assertCurrent: owned.assertCurrent, signal: owned.signal, dispose: () => owned.abort.abort(new Error('Vault closed')) };
  });
});
afterEach(() => vi.restoreAllMocks());
const raw = () => Uint8Array.from({ length: 16 }, (_, i) => i + 1);

describe('captured account media sender envelopes', () => {
  it('round trips real authenticated crypto through each owner’s vault while another server is selected', async () => {
    const wrapped = await wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 7, bob.userId, context(alice));
    const result = await unwrapDeliveredMediaSenderKey('room:10:audio', alice.userId, wrapped!, context(bob));
    expect(result).toEqual({ epoch: 7, rawKey: raw() });
    expect(fixture.open.mock.calls.map(([scope]) => scope)).toEqual([alice, bob]);
    expect(records.get(ownerKey(alice))?.get('["signal.identity-pins","200"]')).toMatchObject({ identity: publicKey(bob) });
  });
  it('requires the supplied call owner even when the active account is unlocked', async () => {
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId)).rejects.toThrow('owned account');
    await expect(wrapSenderKeyForRecipients('room:10:audio', raw(), 1, [])).rejects.toThrow('owned account');
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it('does not use a same-ID peer from a different account’s member cache', async () => {
    useMemberStore.setState({ members: new Map([[JSON.stringify(['server-b', alice.userId, 'guild']), [{ user: { id: bob.userId, public_key: publicKey(bob) } } as never]]]) });
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId, context(alice))).rejects.toThrow('identity key');
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it('rejects changed peer keys against the same encrypted account pin', async () => {
    await wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId, context(alice));
    privateKeys.set(ownerKey(bob), ed25519.utils.randomSecretKey()); peerFor(alice, bob);
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 2, bob.userId, context(alice))).rejects.toThrow('identity changed');
  });
  it('does not silently migrate ambiguous legacy trust into a fresh account pin', async () => {
    fixture.legacy.mockResolvedValueOnce(JSON.stringify({ [bob.userId]: { fingerprint: 'old' } }));
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId, context(alice))).rejects.toThrow('older identity trust');
    expect(records.get(ownerKey(alice))?.get('["signal.identity-pins","200"]')).toBeUndefined();
  });
  it('rejects a late vault opening after call/history cancellation', async () => {
    const original = fixture.open.getMockImplementation()!; const account = context(alice);
    fixture.open.mockImplementationOnce(async scope => { const result = await original(scope); account.abort.abort(new Error('History changed')); return result; });
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId, account)).rejects.toThrow('History changed');
    expect(records.get(ownerKey(alice))?.size).toBe(0);
  });
  it('holds identity trust from a different server history for explicit review', async () => {
    records.set(ownerKey(alice), new Map([['["messages.runtime-history","current"]', { epoch: 'older-history', initialLease: null }]]));
    await expect(wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 1, bob.userId, context(alice))).rejects.toThrow('older or unknown server history');
    expect(records.get(ownerKey(alice))?.get('["signal.identity-pins","200"]')).toBeUndefined();
  });
  it('binds the authenticated envelope to its media scope and rejects raw key injection', async () => {
    const wrapped = await wrapMediaSenderKeyForRecipient('room:10:audio', raw(), 7, bob.userId, context(alice));
    await expect(unwrapDeliveredMediaSenderKey('room:11:audio', alice.userId, wrapped!, context(bob))).rejects.toThrow();
    await expect(unwrapDeliveredMediaSenderKey('room:10:audio', alice.userId, raw(), context(bob))).rejects.toThrow();
  });
});
