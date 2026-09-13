import { describe, expect, it } from 'vitest';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import { archiveLocalMessagingHistory, bindMessagingHistory, HISTORY_ARCHIVE_NAMESPACE } from './runtimeHistory';

function vault() {
  const rows = new Map<string, unknown>();
  const tx: VaultTransaction = {
    get: async <T>(namespace: string, id: string) => (rows.get(`${namespace}:${id}`) as T | undefined) ?? null,
    list: async <T>(namespace: string) => [...rows].filter(([id]) => id.startsWith(`${namespace}:`)).map(([id, value]) => ({ id: id.slice(namespace.length + 1), value: value as T })),
    put(namespace, id, value) { rows.set(`${namespace}:${id}`, structuredClone(value)); },
    remove(namespace, id) { rows.delete(`${namespace}:${id}`); },
  };
  return { tx, vault: { transact: async <T>(run: (tx: VaultTransaction) => Promise<T>) => run(tx) } as AccountVault };
}
describe('durable database history ownership', () => {
  it('binds an empty store to a known authenticated history', async () => {
    const f = vault();
    await expect(bindMessagingHistory(f.vault, 'history-a', 'lease')).resolves.toEqual({ kind: 'ready' });
    await expect(bindMessagingHistory(f.vault, 'history-a', 'next-lease')).resolves.toEqual({ kind: 'ready' });
  });
  it('adopts pre-handshake drafts only through the same original in-memory account lease', async () => {
    const f = vault();
    await expect(bindMessagingHistory(f.vault, null, 'initial-lease')).resolves.toEqual({ kind: 'awaiting-handshake' });
    f.tx.put('messages.drafts', 'channel', { content: 'Before first handshake' });
    await expect(bindMessagingHistory(f.vault, 'history-a', 'initial-lease')).resolves.toEqual({ kind: 'ready' });
  });
  it('adopts the first authenticated history after a reload that saved nothing', async () => {
    const f = vault();
    await expect(bindMessagingHistory(f.vault, null, 'first-lease')).resolves.toEqual({ kind: 'awaiting-handshake' });
    await expect(bindMessagingHistory(f.vault, null, 'reloaded-lease')).resolves.toEqual({ kind: 'awaiting-handshake' });
    f.tx.put('messages.drafts', 'channel', { content: 'Typed in the reloaded window' });
    await expect(bindMessagingHistory(f.vault, 'history-a', 'reloaded-lease')).resolves.toEqual({ kind: 'ready' });
    expect(await f.tx.get('messages.drafts', 'channel')).toEqual({ content: 'Typed in the reloaded window' });
  });
  it('requires review for unknown-history drafts after reload', async () => {
    const f = vault(); await bindMessagingHistory(f.vault, null, 'initial-lease');
    f.tx.put('messages.drafts', 'channel', { content: 'Unknown history after reload' });
    await expect(bindMessagingHistory(f.vault, 'history-a', 'replacement-lease')).resolves.toEqual({ kind: 'review', previousEpoch: null });
    expect(await f.tx.get('messages.drafts', 'channel')).toEqual({ content: 'Unknown history after reload' });
  });
  it('never adopts old records after a database restore, even in the original lease', async () => {
    const f = vault(); await bindMessagingHistory(f.vault, 'history-a', 'same-lease');
    f.tx.put('messages.outbox', 'nonce', { serializedRequest: 'original immutable bytes' });
    await expect(bindMessagingHistory(f.vault, 'history-b', 'same-lease')).resolves.toEqual({ kind: 'review', previousEpoch: 'history-a' });
    expect(await f.tx.get('messages.outbox', 'nonce')).toEqual({ serializedRequest: 'original immutable bytes' });
  });
  it.each(['messages.outbox', 'messages.intents', 'messages.drafts', 'messages.delivered-mutations', 'signal.prekeys', 'signal.sessions'])('refuses to invent provenance for existing unmarked %s records', async namespace => {
    const f = vault(); f.tx.put(namespace, 'old', { data: 'older encrypted state' });
    await expect(bindMessagingHistory(f.vault, 'history-a', 'new-lease')).resolves.toEqual({ kind: 'review', previousEpoch: null });
    expect(await f.tx.get('messages.runtime-history', 'current')).toBeNull();
  });
  it('preserves exact old requests and text while enabling only fresh local history work', async () => {
    const f = vault(); await bindMessagingHistory(f.vault, 'old', 'lease');
    const request = { channelId: 'channel', serializedRequest: 'immutable ciphertext', draft: { content: 'Keep old text' } };
    f.tx.put('messages.outbox', 'nonce', request);
    await archiveLocalMessagingHistory(f.vault, 'new', 'old');
    expect(await f.tx.get('messages.outbox', 'nonce')).toBeNull();
    expect((await f.tx.list<{ value: unknown }>(HISTORY_ARCHIVE_NAMESPACE))[0].value.value).toEqual(request);
    expect((await f.tx.list<{ content: string }>('messages.recovery-drafts'))[0].value.content).toBe('Keep old text');
    await expect(bindMessagingHistory(f.vault, 'new', 'lease')).resolves.toEqual({ kind: 'ready' });
  });
  it('rejects stale review and does not use local draft recovery to reset encryption state', async () => {
    const f = vault(); await bindMessagingHistory(f.vault, 'old', 'lease');
    await expect(archiveLocalMessagingHistory(f.vault, 'new', 'stale')).rejects.toThrow('another window');
    f.tx.put('signal.prekeys', 'keys', { secret: 'retained' });
    await expect(archiveLocalMessagingHistory(f.vault, 'new', 'old')).rejects.toThrow('identity recovery');
    expect(await f.tx.get('signal.prekeys', 'keys')).toEqual({ secret: 'retained' });
  });
});
