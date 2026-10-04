import { beforeEach, describe, expect, it } from 'vitest';

import { useIxPlaceStore } from '../shell/usePlace';
import { PEOPLE_PLACE } from '../shell/place';
import {
  memoryOfRoute,
  PLACE_MEMORY_KEY,
  readPlaceMemory,
  rememberRoute,
  resolveLastPlace,
  restoreLastPlace,
  type PlaceMemory,
  type ResolveInput,
} from './lastPlace';

/**
 * `/app` and `/app/dms` (docs/index-spec.md §8.1): what is remembered of where you were, and the
 * rule for where each route goes.
 */

const store = (value: unknown) => window.localStorage.setItem(PLACE_MEMORY_KEY, JSON.stringify(value));
const stored = () => JSON.parse(window.localStorage.getItem(PLACE_MEMORY_KEY) ?? 'null');

beforeEach(() => {
  window.localStorage.clear();
  useIxPlaceStore.setState({ last: PEOPLE_PLACE });
});

describe('what is remembered', () => {
  it('reads back a valid memory, and nothing from garbage', () => {
    store({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c1', people: '/app/dms/d1' });
    expect(readPlaceMemory()).toEqual({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c1', people: '/app/dms/d1' });
    window.localStorage.setItem(PLACE_MEMORY_KEY, '{nope');
    expect(readPlaceMemory()).toBeNull();
    store({ place: 'g1' });
    expect(readPlaceMemory()).toBeNull();
    store(['g1']);
    expect(readPlaceMemory()).toBeNull();
    window.localStorage.clear();
    expect(readPlaceMemory()).toBeNull();
  });

  it('keeps only routes that can be restored: a channel of that server, a conversation, Friends, Inbox', () => {
    // A route of another server, a bare `/app` and `/app/dms` (a redirect loop), and a page that is not a conversation are dropped.
    store({ userId: 'me', place: 'g1', path: '/app/guilds/g2/channels/c1', people: '/app' });
    expect(readPlaceMemory()).toEqual({ userId: 'me', place: 'g1', path: null, people: null });
    store({ userId: 'me', place: 'g1', path: '/app/guilds/g1/events', people: '/app/dms' });
    expect(readPlaceMemory()).toEqual({ userId: 'me', place: 'g1', path: null, people: null });
    store({ userId: 'me', place: 'people', path: '/app/guilds/g1/channels/c1', people: '/app/inbox' });
    expect(readPlaceMemory()).toEqual({ userId: 'me', place: 'people', path: null, people: '/app/inbox' });
  });

  describe('memoryOfRoute', () => {
    const guilds = new Set(['g1']);
    it('a channel of a server you are in is the place and the path', () => {
      expect(memoryOfRoute('/app/guilds/g1/channels/c1', guilds)).toEqual({ place: 'g1', path: '/app/guilds/g1/channels/c1' });
    });
    it('a server page that is not a channel keeps the place and no path', () => {
      expect(memoryOfRoute('/app/guilds/g1', guilds)).toEqual({ place: 'g1' });
      expect(memoryOfRoute('/app/guilds/g1/events', guilds)).toEqual({ place: 'g1' });
    });
    it('a server you are not in says nothing (a stale link must not become where you were)', () => {
      expect(memoryOfRoute('/app/guilds/g9/channels/c1', guilds)).toBeNull();
    });
    it('a conversation, Friends and Inbox are People items', () => {
      expect(memoryOfRoute('/app/dms/d1', guilds)).toEqual({ place: 'people', people: '/app/dms/d1' });
      expect(memoryOfRoute('/app/friends', guilds)).toEqual({ place: 'people', people: '/app/friends' });
      expect(memoryOfRoute('/app/inbox', guilds)).toEqual({ place: 'people', people: '/app/inbox' });
    });
    it('the redirects, settings pages and Discover say nothing', () => {
      for (const route of ['/app', '/app/dms', '/app/discovery', '/app/admin', '/app/developers', '/app/templates']) {
        expect(memoryOfRoute(route, guilds)).toBeNull();
      }
    });
  });

  describe('rememberRoute', () => {
    const guilds = new Set(['g1', 'g2']);
    it('remembers the channel, then the People item beside it', () => {
      rememberRoute('/app/guilds/g1/channels/c1', 'me', guilds);
      expect(stored()).toEqual({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c1', people: null });
      rememberRoute('/app/dms/d1', 'me', guilds);
      expect(stored()).toEqual({ userId: 'me', place: 'people', path: null, people: '/app/dms/d1' });
    });

    it('keeps a server\'s channel through its Overview, and starts over in another server', () => {
      rememberRoute('/app/guilds/g1/channels/c1', 'me', guilds);
      rememberRoute('/app/guilds/g1', 'me', guilds);
      expect(stored()).toMatchObject({ place: 'g1', path: '/app/guilds/g1/channels/c1' });
      rememberRoute('/app/guilds/g2', 'me', guilds);
      expect(stored()).toMatchObject({ place: 'g2', path: null });
    });

    it('does not write when nothing changed, and never keeps another account\'s memory', () => {
      store({ userId: 'someone-else', place: 'g1', path: '/app/guilds/g1/channels/c9', people: '/app/dms/d9' });
      rememberRoute('/app/guilds/g1/channels/c1', 'me', guilds);
      expect(stored()).toEqual({ userId: 'me', place: 'g1', path: '/app/guilds/g1/channels/c1', people: null });
      const before = window.localStorage.getItem(PLACE_MEMORY_KEY);
      rememberRoute('/app/guilds/g1/channels/c1', 'me', guilds);
      expect(window.localStorage.getItem(PLACE_MEMORY_KEY)).toBe(before);
    });

    it('ignores routes that are nowhere', () => {
      rememberRoute('/app/admin', 'me', guilds);
      expect(stored()).toBeNull();
    });
  });

  it('puts the sidebar on the remembered server before the first paint of a launch', () => {
    store({ userId: 'me', place: 'g1', path: null, people: null });
    restoreLastPlace();
    expect(useIxPlaceStore.getState().last).toEqual({ kind: 'server', guildId: 'g1' });
    useIxPlaceStore.setState({ last: PEOPLE_PLACE });
    store({ userId: 'me', place: 'people', path: null, people: null });
    restoreLastPlace();
    expect(useIxPlaceStore.getState().last).toEqual(PEOPLE_PLACE);
  });
});

describe('where `/app` and `/app/dms` go', () => {
  const memory = (over: Partial<PlaceMemory> = {}): PlaceMemory => ({ userId: 'me', place: 'people', path: null, people: null, ...over });
  const input = (over: Partial<ResolveInput> = {}): ResolveInput => ({
    mode: 'app',
    memory: null,
    guildIds: ['g1', 'g2'],
    dmIds: ['d2', 'd1'],
    settled: true,
    ...over,
  });

  describe('/app', () => {
    it('opens the channel you were in, in the server you are still in', () => {
      expect(resolveLastPlace(input({ memory: memory({ place: 'g2', path: '/app/guilds/g2/channels/c5' }) }))).toEqual({ kind: 'go', path: '/app/guilds/g2/channels/c5' });
    });

    it('opens the server\'s landing channel when only the server is remembered', () => {
      expect(resolveLastPlace(input({ memory: memory({ place: 'g2' }) }))).toEqual({ kind: 'landing', guildId: 'g2' });
    });

    it('waits for the list of servers while the remembered one has not arrived, and only then calls it gone', () => {
      const gone = memory({ place: 'g9', path: '/app/guilds/g9/channels/c1', people: '/app/friends' });
      expect(resolveLastPlace(input({ memory: gone, settled: false }))).toEqual({ kind: 'wait' });
      expect(resolveLastPlace(input({ memory: gone, settled: true }))).toEqual({ kind: 'go', path: '/app/friends' });
    });

    it('opens the People item you were on when People was the last place', () => {
      expect(resolveLastPlace(input({ memory: memory({ people: '/app/dms/d1' }) }))).toEqual({ kind: 'go', path: '/app/dms/d1' });
      expect(resolveLastPlace(input({ memory: memory({ people: '/app/inbox' }) }))).toEqual({ kind: 'go', path: '/app/inbox' });
    });

    it('with nothing remembered opens your first server, else People', () => {
      expect(resolveLastPlace(input())).toEqual({ kind: 'landing', guildId: 'g1' });
      expect(resolveLastPlace(input({ guildIds: [], settled: false }))).toEqual({ kind: 'wait' });
      expect(resolveLastPlace(input({ guildIds: [] }))).toEqual({ kind: 'go', path: '/app/dms/d2' });
      expect(resolveLastPlace(input({ guildIds: [], dmIds: [] }))).toEqual({ kind: 'go', path: '/app/friends' });
    });
  });

  describe('/app/dms', () => {
    it('ignores the last server: it is the last People item, or the most recent conversation', () => {
      const m = memory({ place: 'g1', path: '/app/guilds/g1/channels/c1', people: '/app/dms/d1' });
      expect(resolveLastPlace(input({ mode: 'dms', memory: m }))).toEqual({ kind: 'go', path: '/app/dms/d1' });
      expect(resolveLastPlace(input({ mode: 'dms' }))).toEqual({ kind: 'go', path: '/app/dms/d2' });
    });

    it('a conversation that is gone (you left the group) falls to the most recent one; waits until the list has answered', () => {
      const m = memory({ people: '/app/dms/d9' });
      expect(resolveLastPlace(input({ mode: 'dms', memory: m, settled: false }))).toEqual({ kind: 'wait' });
      expect(resolveLastPlace(input({ mode: 'dms', memory: m }))).toEqual({ kind: 'go', path: '/app/dms/d2' });
    });

    it('opens Friends when there is no conversation to open (once it is known there is none)', () => {
      expect(resolveLastPlace(input({ mode: 'dms', dmIds: [], settled: false }))).toEqual({ kind: 'wait' });
      expect(resolveLastPlace(input({ mode: 'dms', dmIds: [] }))).toEqual({ kind: 'go', path: '/app/friends' });
    });

    it('Friends and Inbox need no list: they open at once', () => {
      expect(resolveLastPlace(input({ mode: 'dms', memory: memory({ people: '/app/friends' }), dmIds: [], settled: false }))).toEqual({ kind: 'go', path: '/app/friends' });
    });
  });
});
