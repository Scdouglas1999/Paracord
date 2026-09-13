import { afterEach, describe, expect, it } from 'vitest';
import { clearUnlockedPrivateKey, hasUnlockedPrivateKey, leaseUnlockedPrivateKey, setUnlockedPrivateKey, withUnlockedPrivateKey } from './accountSession';

afterEach(clearUnlockedPrivateKey);

describe('unlocked key operation lifetime', () => {
  it('takes ownership of input and isolates disposable operation copies', async () => {
    const input = new Uint8Array(32).fill(7);
    setUnlockedPrivateKey(input);
    expect(input.every(value => value === 0)).toBe(true);
    let used: Uint8Array | undefined;
    await withUnlockedPrivateKey(async privateKey => { used = privateKey; privateKey[0] = 1; });
    expect(used?.every(value => value === 0)).toBe(true);
    await withUnlockedPrivateKey(async privateKey => { expect(privateKey[0]).toBe(7); });
    expect(hasUnlockedPrivateKey()).toBe(true);
  });

  it('aborts and wipes every active lease on lock', () => {
    setUnlockedPrivateKey(new Uint8Array(32).fill(8));
    const first = leaseUnlockedPrivateKey(); const second = leaseUnlockedPrivateKey();
    clearUnlockedPrivateKey();
    for (const lease of [first, second]) {
      expect(lease.signal.aborted).toBe(true);
      expect(lease.privateKey.every(value => value === 0)).toBe(true);
      expect(() => lease.assertCurrent()).toThrow(/changed/);
    }
    expect(() => leaseUnlockedPrivateKey()).toThrow('Account not unlocked');
  });

  it('rejects late results after identity replacement and preserves the new identity', async () => {
    setUnlockedPrivateKey(new Uint8Array(32).fill(9));
    let finish!: () => void;
    const wait = new Promise<void>(resolve => { finish = resolve; });
    const running = withUnlockedPrivateKey(async () => { await wait; return 'stale'; });
    setUnlockedPrivateKey(new Uint8Array(32).fill(10)); finish();
    await expect(running).rejects.toThrow(/changed/);
    await withUnlockedPrivateKey(async key => { expect(key[0]).toBe(10); });
  });

  it('wipes copies when a callback fails and rejects invalid replacements without locking', async () => {
    setUnlockedPrivateKey(new Uint8Array(32).fill(11));
    let used: Uint8Array | undefined;
    await expect(withUnlockedPrivateKey(async key => { used = key; throw new Error('Failed'); })).rejects.toThrow('Failed');
    expect(used?.every(value => value === 0)).toBe(true);
    expect(() => setUnlockedPrivateKey(new Uint8Array(16))).toThrow(/32 bytes/);
    expect(hasUnlockedPrivateKey()).toBe(true);
  });
});
