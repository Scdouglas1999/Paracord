import { describe, expect, it, vi } from 'vitest';
import type { RestClient } from './restClient';
import { createSportsApi, leaguePathError } from './sports';

describe('sports api', () => {
  it('calls the four endpoints with the contract paths and methods', async () => {
    const calls: { method: string; url: string; data?: unknown }[] = [];
    const client = {
      get: vi.fn((url: string) => {
        calls.push({ method: 'GET', url });
        return Promise.resolve({ data: {} });
      }),
      put: vi.fn((url: string, data?: unknown) => {
        calls.push({ method: 'PUT', url, data });
        return Promise.resolve({ data });
      }),
    };
    const api = createSportsApi(() => client as unknown as RestClient);

    await api.listLeagues();
    await api.getSettings('99');
    await api.getBoard('99');
    await api.listTeams('football/nfl');
    await api.getGame('99', 'football', 'nfl', '401872945');
    await api.updateSettings('99', { enabled: true, default_view: 'live', layout: 'cards' });

    expect(calls).toEqual([
      { method: 'GET', url: '/sports/leagues' },
      { method: 'GET', url: '/guilds/99/sports' },
      { method: 'GET', url: '/guilds/99/sports/board' },
      { method: 'GET', url: '/sports/leagues/football/nfl/teams' },
      { method: 'GET', url: '/guilds/99/sports/games/football/nfl/401872945' },
      { method: 'PUT', url: '/guilds/99/sports', data: { enabled: true, default_view: 'live', layout: 'cards' } },
    ]);
  });
});

describe('league path validation', () => {
  it('accepts a single slash of letters, digits, dots and dashes, up to 48 characters', () => {
    expect(leaguePathError('football/nfl')).toBeNull();
    expect(leaguePathError(' basketball/mens-college-basketball ')).toBeNull();
    expect(leaguePathError(`${'a'.repeat(46)}/b`)).toBeNull();
    expect(leaguePathError('a/b')).toBeNull();
  });

  it('rejects anything that could not safely sit in the outbound path', () => {
    expect(leaguePathError('')).toMatch(/football\/nfl/);
    expect(leaguePathError('   ')).toMatch(/football\/nfl/);
    expect(leaguePathError('nope')).toMatch(/one slash/);
    expect(leaguePathError('/nfl')).toMatch(/one slash/);
    expect(leaguePathError('football/')).toMatch(/one slash/);
    expect(leaguePathError('football/nfl/scores')).toMatch(/one slash/);
    expect(leaguePathError('foot ball/nfl')).toMatch(/one slash/);
    expect(leaguePathError('football/nf_l')).toMatch(/one slash/);
    expect(leaguePathError(`${'a'.repeat(47)}/b`)).toMatch(/48/);
  });

  it('refuses a team-list request whose path could not be sent', async () => {
    const get = vi.fn();
    const api = createSportsApi(() => ({ get }) as unknown as RestClient);
    await expect(api.listTeams('nope')).rejects.toThrow(/one slash/);
    expect(get).not.toHaveBeenCalled();
  });

  it('refuses a game id that is not 1 to 20 digits', async () => {
    const get = vi.fn();
    const api = createSportsApi(() => ({ get }) as unknown as RestClient);
    await expect(api.getGame('1', 'football', 'nfl', 'nope')).rejects.toThrow(/not valid/);
    await expect(api.getGame('1', 'football', 'nfl', '')).rejects.toThrow(/not valid/);
    expect(get).not.toHaveBeenCalled();
  });
});
