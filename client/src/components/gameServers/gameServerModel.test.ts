import { describe, expect, it } from 'vitest';
import type { GameServer, GameServerStatus } from '../../api/gameServers';
import {
  addressProblem,
  connectUrl,
  detailLine,
  joinAddress,
  playerInitials,
  playersLabel,
  splitAddress,
  summaryLine,
  upCount,
} from './gameServerModel';

const up = (extra: Partial<GameServerStatus> = {}): GameServerStatus => ({ state: 'up', ...extra });

function server(id: string, status: GameServerStatus, kind: GameServer['kind'] = 'minecraft_java'): GameServer {
  return { id, guild_id: 'g', kind, name: id, address: 'play.example.com:25565', created_at: '', status };
}

describe('addresses', () => {
  it('splits a pasted host:port, a bracketed IPv6 and a bare IPv6', () => {
    expect(splitAddress('play.example.com:25566')).toEqual({ host: 'play.example.com', port: '25566' });
    expect(splitAddress('play.example.com')).toEqual({ host: 'play.example.com', port: null });
    expect(splitAddress('[2001:db8::1]:27015')).toEqual({ host: '2001:db8::1', port: '27015' });
    expect(splitAddress('2001:db8::1')).toEqual({ host: '2001:db8::1', port: null });
  });

  it('joins with brackets around IPv6', () => {
    expect(joinAddress('play.example.com', '25565')).toBe('play.example.com:25565');
    expect(joinAddress('2001:db8::1', '27015')).toBe('[2001:db8::1]:27015');
    expect(joinAddress(' host ', '')).toBe('host');
  });

  it('names obvious problems before asking the instance', () => {
    expect(addressProblem('', '', 'tcp')).toBeNull();
    expect(addressProblem('https://example.com', '25565', 'minecraft_java')).toMatch(/just the host/);
    expect(addressProblem('example.com', '', 'tcp')).toBe('This type needs a port.');
    expect(addressProblem('example.com', '', 'minecraft_java')).toBeNull();
    expect(addressProblem('example.com', '70000', 'source')).toMatch(/1 to 65535/);
    expect(addressProblem('example.com', '27015', 'source')).toBeNull();
  });
});

describe('status words', () => {
  it('says how many are on, and the map', () => {
    expect(playersLabel(up({ players_online: 5, players_max: 20 }))).toBe('5/20 online');
    expect(playersLabel(up({ players_online: 2 }))).toBe('2 online');
    expect(playersLabel({ state: 'down', players_online: 5 })).toBeNull();
    expect(summaryLine(up({ players_online: 5, players_max: 20, map: 'ctf_2fort' }))).toBe('5/20 online · ctf_2fort');
    expect(summaryLine(up())).toBe('Up');
    expect(summaryLine({ state: 'down' })).toBe('Down');
    expect(summaryLine({ state: 'checking' })).toBe('Checking…');
  });

  it('explains a down server with when it was last up', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(
      detailLine(
        { state: 'down', error: 'No answer within 3 seconds.', last_seen_online: '2026-09-24T10:00:00Z' },
        now,
      ),
    ).toEqual({ text: 'No answer within 3 seconds. Last up 2 h ago.', tone: 'error' });
    expect(detailLine({ state: 'checking' }, now).tone).toBe('muted');
    expect(
      detailLine(up({ players_online: 1, players_max: 8, latency_ms: 42, last_checked_at: '2026-09-24T11:59:40Z' }), now)
        .text,
    ).toBe('1/8 online · 42 ms · checked just now');
  });

  it('counts the servers that are up', () => {
    expect(upCount([server('a', up()), server('b', { state: 'down' }), server('c', up())])).toBe(2);
  });
});

describe('connect and initials', () => {
  it('offers steam://connect only for Steam games', () => {
    expect(connectUrl({ kind: 'source', address: '203.0.113.10:27015' })).toBe('steam://connect/203.0.113.10:27015');
    expect(connectUrl({ kind: 'minecraft_java', address: 'play.example.com:25565' })).toBeNull();
    expect(connectUrl({ kind: 'tcp', address: 'x:1' })).toBeNull();
  });

  it('makes one or two letters from a player name', () => {
    expect(playerInitials('mira_builds')).toBe('MB');
    expect(playerInitials('TomasB')).toBe('TB');
    expect(playerInitials('jonas')).toBe('JO');
    expect(playerInitials('.BedrockKen')).toBe('BK');
    expect(playerInitials('')).toBe('?');
  });
});
