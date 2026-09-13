import { entityScopeKey } from '../lib/serverScope';
function ref(value: string, userId = 'viewer') { const [serverId, id] = value.split(':'); return { scope: { serverId, userId }, id }; }
function key(value: string, userId = 'viewer') { const channel = ref(value, userId); return entityScopeKey(channel.scope, channel.id); }
import { describe, it, expect, beforeEach } from 'vitest';
import { usePinnedStore } from './pinnedStore';

describe('pinnedStore', () => {
  beforeEach(() => {
    usePinnedStore.setState({ pinnedKeys: [] });
    localStorage.clear();
  });

  it('starts empty', () => {
    expect(usePinnedStore.getState().pinnedKeys).toEqual([]);
  });

  it('pins a key', () => {
    usePinnedStore.getState().pin(ref('srv1:100'));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['srv1:100'].map(value => key(value)));
  });

  it('does not duplicate an already-pinned key', () => {
    const { pin } = usePinnedStore.getState();
    pin(ref('srv1:100'));
    pin(ref('srv1:100'));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['srv1:100'].map(value => key(value)));
  });

  it('preserves pin insertion order', () => {
    const { pin } = usePinnedStore.getState();
    pin(ref('a:1'));
    pin(ref('b:2'));
    pin(ref('c:3'));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['a:1', 'b:2', 'c:3'].map(value => key(value)));
  });

  it('unpins a key', () => {
    const { pin, unpin } = usePinnedStore.getState();
    pin(ref('a:1'));
    pin(ref('b:2'));
    unpin(ref('a:1'));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['b:2'].map(value => key(value)));
  });

  it('unpin of an absent key is a no-op', () => {
    usePinnedStore.getState().pin(ref('a:1'));
    usePinnedStore.getState().unpin(ref('z:9'));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['a:1'].map(value => key(value)));
  });

  it('reorders to the supplied order', () => {
    const { pin, reorder } = usePinnedStore.getState();
    pin(ref('a:1'));
    pin(ref('b:2'));
    pin(ref('c:3'));
    reorder(['c:3', 'a:1', 'b:2'].map(value => ref(value)));
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['c:3', 'a:1', 'b:2'].map(value => key(value)));
  });

  it('reorder ignores unknown keys and appends omitted pinned keys', () => {
    const { pin, reorder } = usePinnedStore.getState();
    pin(ref('a:1'));
    pin(ref('b:2'));
    pin(ref('c:3'));
    reorder(['c:3', 'zzz:0'].map(value => ref(value))); // 'zzz:0' unknown; a:1 & b:2 omitted
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['c:3', 'a:1', 'b:2'].map(value => key(value)));
  });

  it('isPinned reflects current state', () => {
    const { pin, isPinned } = usePinnedStore.getState();
    expect(isPinned(ref('a:1'))).toBe(false);
    pin(ref('a:1'));
    expect(usePinnedStore.getState().isPinned(ref('a:1'))).toBe(true);
    usePinnedStore.getState().unpin(ref('a:1'));
    expect(usePinnedStore.getState().isPinned(ref('a:1'))).toBe(false);
  });

  it('persists under the paracord:pinned-conversations-by-account storage key', () => {
    usePinnedStore.getState().pin(ref('srv1:100'));
    const raw = localStorage.getItem('paracord:pinned-conversations-by-account');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.pinnedKeys).toEqual(['srv1:100'].map(value => key(value)));
  });
});

describe('pin ownership and persistence', () => {
  beforeEach(() => { localStorage.clear(); usePinnedStore.setState({ pinnedKeys: [] }); });

  it('keeps colliding channel IDs separate across accounts and servers', () => {
    const first = ref('a:100', 'first');
    const second = ref('a:100', 'second');
    const remote = ref('b:100', 'first');
    const { pin, unpin, isPinned } = usePinnedStore.getState();
    pin(first); pin(second); pin(remote); unpin(second);
    expect(isPinned(first)).toBe(true);
    expect(isPinned(second)).toBe(false);
    expect(isPinned(remote)).toBe(true);
    expect(usePinnedStore.getState().pinnedKeys).toEqual([key('a:100', 'first'), key('b:100', 'first')]);
  });

  it('rehydrates the original account and ordering without taking unowned legacy pins', async () => {
    const { pin, reorder } = usePinnedStore.getState();
    pin(ref('a:100', 'first')); pin(ref('a:100', 'second'));
    reorder([ref('a:100', 'second'), ref('a:100', 'second')]);
    const saved = localStorage.getItem('paracord:pinned-conversations-by-account')!;
    usePinnedStore.setState({ pinnedKeys: [] });
    localStorage.setItem('paracord:pinned-conversations-by-account', saved);
    localStorage.setItem('paracord:pinned-conversations', JSON.stringify({ state: { pinnedKeys: ['b:100'] }, version: 0 }));
    await usePinnedStore.persist.rehydrate();
    expect(usePinnedStore.getState().pinnedKeys).toEqual([key('a:100', 'second'), key('a:100', 'first')]);
  });

  it('does not assign legacy pins when scoped storage is absent', async () => {
    localStorage.removeItem('paracord:pinned-conversations-by-account');
    localStorage.setItem('paracord:pinned-conversations', JSON.stringify({ state: { pinnedKeys: ['a:100'] }, version: 0 }));
    await usePinnedStore.persist.rehydrate();
    expect(usePinnedStore.getState().pinnedKeys).toEqual([]);
    expect(localStorage.getItem('paracord:pinned-conversations')).toContain('a:100');
  });
});
