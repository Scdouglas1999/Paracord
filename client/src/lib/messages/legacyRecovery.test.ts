import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountVault, VaultTransaction } from '../crypto/accountVault';
import { entityScopeKey } from '../serverScope';
import { migrateLegacyMessageDrafts, RECOVERY_NAMESPACE } from './legacyRecovery';

const scope = { serverId: 'a', userId: 'viewer' };
const queueKey = 'paracord:v2:offline-message-queue';
function fixture() {
  const records = new Map<string, unknown>(); let fail = false;
  const tx = { put(namespace: string, id: string, value: unknown) { if (fail) throw new Error('Quota exceeded'); records.set(`${namespace}:${id}`, value); } } as VaultTransaction;
  return { vault: { scope, transact: async <T>(run: (tx: VaultTransaction) => Promise<T>) => run(tx) } as AccountVault,
    records, fail() { fail = true; } };
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto); });
afterEach(() => vi.unstubAllGlobals());
describe('legacy draft recovery migration', () => {
  it('moves only owned queued text into recovery records and never enqueues delivery', async () => {
    const f = fixture(); const owned = { scope, id: 'old', channelId: 'dm', content: 'May already be delivered', nonce: 'unreliable' };
    const others = [{ scope: { ...scope, serverId: 'b' }, content: 'Other server' }, { channelId: 'dm', content: 'Unowned' }];
    localStorage.setItem(queueKey, JSON.stringify([owned, ...others]));
    await migrateLegacyMessageDrafts(f.vault);
    expect(JSON.parse(localStorage.getItem(queueKey)!)).toEqual(others);
    expect([...f.records.keys()].every(key => key.startsWith(RECOVERY_NAMESPACE))).toBe(true);
    expect([...f.records.values()][0]).toMatchObject({ channelId: 'dm', content: owned.content, reason: expect.stringContaining('already have committed') });
  });
  it('never moves or deletes the source before encrypted persistence succeeds', async () => {
    const f = fixture(); const raw = JSON.stringify([{ scope, channelId: 'dm', content: 'Must survive failure' }]);
    localStorage.setItem('paracord:offline-message-queue', raw); f.fail();
    await expect(migrateLegacyMessageDrafts(f.vault)).rejects.toThrow('Quota exceeded');
    expect(localStorage.getItem('paracord:offline-message-queue')).toBe(raw); expect(localStorage.getItem(queueKey)).toBeNull();
  });
  it('retains malformed sources unchanged and does not silently treat them as empty', async () => {
    const f = fixture(); localStorage.setItem(queueKey, '{unfinished backup');
    await expect(migrateLegacyMessageDrafts(f.vault)).rejects.toThrow(); expect(localStorage.getItem(queueKey)).toBe('{unfinished backup');
  });
  it('recovers a scoped composer draft separately from ordinary current-history drafts', async () => {
    const f = fixture(); const key = `paracord:account-draft:${entityScopeKey(scope, 'dm')}`;
    localStorage.setItem(key, JSON.stringify({ revision: 'old', content: 'Review before sending' }));
    localStorage.setItem('paracord:v2:draft:dm', 'No recorded owner');
    await migrateLegacyMessageDrafts(f.vault, 'dm');
    expect(localStorage.getItem(key)).toBeNull(); expect(localStorage.getItem('paracord:v2:draft:dm')).toBe('No recorded owner');
    expect([...f.records.values()][0]).toMatchObject({ content: 'Review before sending', source: key });
  });
  it('does not erase a new legacy write that arrives during the encrypted copy', async () => {
    const f = fixture(); const initial = JSON.stringify([{ scope, channelId: 'dm', content: 'Old' }]);
    const replacement = JSON.stringify([{ scope, channelId: 'dm', content: 'New in another window' }]);
    localStorage.setItem(queueKey, initial);
    const transact = f.vault.transact.bind(f.vault);
    f.vault.transact = async run => { const result = await transact(run); localStorage.setItem(queueKey, replacement); return result; };
    await migrateLegacyMessageDrafts(f.vault);
    expect(localStorage.getItem(queueKey)).toBe(replacement);
  });
});
