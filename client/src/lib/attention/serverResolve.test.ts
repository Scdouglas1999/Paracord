import { describe, it, expect } from 'vitest';
import { buildServerUrlMap, resolveServerIdForGuild } from './serverResolve';
import type { ServerEntry } from '../../stores/serverListStore';

function server(over: Partial<ServerEntry> & { id: string; url: string }): ServerEntry {
  return {
    name: over.id,
    token: null,
    connected: true,
    ...over,
  };
}

describe('buildServerUrlMap', () => {
  it('maps each server by its normalized url', () => {
    const map = buildServerUrlMap([
      server({ id: 'a', url: 'https://alpha.example.com' }),
      server({ id: 'b', url: 'https://beta.example.com:8443' }),
    ]);
    expect(map.get('https://alpha.example.com')).toBe('a');
    expect(map.get('https://beta.example.com:8443')).toBe('b');
    expect(map.size).toBe(2);
  });

  it('normalizes trailing slashes and api/health suffixes so lookups match', () => {
    const map = buildServerUrlMap([
      server({ id: 'a', url: 'https://alpha.example.com/api/v1/' }),
    ]);
    // A guild stamped with the bare origin must resolve to the same id.
    expect(map.get('https://alpha.example.com')).toBe('a');
  });

  it('skips blank urls and keeps the first claimant on a duplicate', () => {
    const map = buildServerUrlMap([
      server({ id: 'blank', url: '   ' }),
      server({ id: 'first', url: 'https://dup.example.com/' }),
      server({ id: 'second', url: 'https://dup.example.com' }),
    ]);
    expect(map.has('')).toBe(false);
    expect(map.get('https://dup.example.com')).toBe('first');
    expect(map.size).toBe(1);
  });
});

describe('resolveServerIdForGuild', () => {
  const map = buildServerUrlMap([
    server({ id: 'a', url: 'https://alpha.example.com' }),
    server({ id: 'b', url: 'https://beta.example.com' }),
  ]);

  it('resolves a guild to its owning server via server_url', () => {
    expect(resolveServerIdForGuild({ server_url: 'https://beta.example.com' }, map, 'a')).toBe('b');
  });

  it('normalizes the guild server_url before lookup', () => {
    expect(
      resolveServerIdForGuild({ server_url: 'https://beta.example.com/api/v1' }, map, 'a'),
    ).toBe('b');
  });

  it('falls back to activeServerId when server_url is missing (§9 flag 3)', () => {
    expect(resolveServerIdForGuild({}, map, 'a')).toBe('a');
    expect(resolveServerIdForGuild({ server_url: null }, map, 'a')).toBe('a');
  });

  it('falls back to activeServerId when server_url is unmapped (§9 flag 3)', () => {
    expect(
      resolveServerIdForGuild({ server_url: 'https://ghost.example.com' }, map, 'b'),
    ).toBe('b');
  });
});
