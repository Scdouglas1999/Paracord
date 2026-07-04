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
    usePinnedStore.getState().pin('srv1:100');
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['srv1:100']);
  });

  it('does not duplicate an already-pinned key', () => {
    const { pin } = usePinnedStore.getState();
    pin('srv1:100');
    pin('srv1:100');
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['srv1:100']);
  });

  it('preserves pin insertion order', () => {
    const { pin } = usePinnedStore.getState();
    pin('a:1');
    pin('b:2');
    pin('c:3');
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['a:1', 'b:2', 'c:3']);
  });

  it('unpins a key', () => {
    const { pin, unpin } = usePinnedStore.getState();
    pin('a:1');
    pin('b:2');
    unpin('a:1');
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['b:2']);
  });

  it('unpin of an absent key is a no-op', () => {
    usePinnedStore.getState().pin('a:1');
    usePinnedStore.getState().unpin('z:9');
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['a:1']);
  });

  it('reorders to the supplied order', () => {
    const { pin, reorder } = usePinnedStore.getState();
    pin('a:1');
    pin('b:2');
    pin('c:3');
    reorder(['c:3', 'a:1', 'b:2']);
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['c:3', 'a:1', 'b:2']);
  });

  it('reorder ignores unknown keys and appends omitted pinned keys', () => {
    const { pin, reorder } = usePinnedStore.getState();
    pin('a:1');
    pin('b:2');
    pin('c:3');
    reorder(['c:3', 'zzz:0']); // 'zzz:0' unknown; a:1 & b:2 omitted
    expect(usePinnedStore.getState().pinnedKeys).toEqual(['c:3', 'a:1', 'b:2']);
  });

  it('isPinned reflects current state', () => {
    const { pin, isPinned } = usePinnedStore.getState();
    expect(isPinned('a:1')).toBe(false);
    pin('a:1');
    expect(usePinnedStore.getState().isPinned('a:1')).toBe(true);
    usePinnedStore.getState().unpin('a:1');
    expect(usePinnedStore.getState().isPinned('a:1')).toBe(false);
  });

  it('persists under the paracord:pinned-conversations storage key', () => {
    usePinnedStore.getState().pin('srv1:100');
    const raw = localStorage.getItem('paracord:pinned-conversations');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string).state.pinnedKeys).toEqual(['srv1:100']);
  });
});
