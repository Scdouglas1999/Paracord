import { describe, expect, it } from 'vitest';
import type { SportsGame, SportsTeam } from '../../api/sports';
import { isSportsScoreAuthor, parseScoreUpdate, resolveScoreSides, scoreUpdateGame, scoreUpdateHref } from './scoreUpdate';

function team(id: string, short: string, color: string): SportsTeam {
  return {
    id, abbr: short.slice(0, 3).toUpperCase(), name: short, short_name: short, logo: '',
    score: 0, record: null, possession: false, winner: false, color,
  };
}

describe('score update sentences', () => {
  it('reads a scoring play', () => {
    expect(parseScoreUpdate('Touchdown — Chiefs 14, Colts 7 · 8:41 2nd · K.Walker 4 yd run')).toEqual({
      label: 'Touchdown',
      leadName: 'Chiefs',
      leadScore: '14',
      otherName: 'Colts',
      otherScore: '7',
      clock: '8:41 2nd',
      play: 'K.Walker 4 yd run',
      overtime: false,
    });
  });

  it('reads halftime, the final, and overtime', () => {
    expect(parseScoreUpdate('Halftime — Colts 20, Chiefs 17')).toMatchObject({
      label: 'Halftime', leadName: 'Colts', leadScore: '20', clock: null, play: null, overtime: false,
    });
    expect(parseScoreUpdate('Final — Chiefs 33, Colts 30 (OT)')).toMatchObject({
      label: 'Final', overtime: true, leadScore: '33', otherScore: '30',
    });
    expect(parseScoreUpdate('End of regulation — Chiefs 20, Colts 20')).toMatchObject({
      label: 'End of regulation', overtime: false,
    });
  });

  it('leaves an ordinary sentence alone', () => {
    expect(parseScoreUpdate('Chiefs score')).toBeNull();
    expect(parseScoreUpdate('')).toBeNull();
  });

  it('recognizes the Sports author, including a taken handle', () => {
    expect(isSportsScoreAuthor({ bot: true, username: 'Sports', display_name: 'Sports' })).toBe(true);
    expect(isSportsScoreAuthor({ bot: true, username: 'sportsbot', display_name: 'Sports' })).toBe(true);
    expect(isSportsScoreAuthor({ bot: false, username: 'Sports', display_name: 'Sports' })).toBe(false);
    expect(isSportsScoreAuthor({ bot: true, username: 'stats', display_name: 'Stats' })).toBe(false);
  });

  it('uses the pinned game for logos and the game page', () => {
    const home = team('h', 'Colts', '002c5f');
    const away = team('a', 'Chiefs', 'e31837');
    const game = {
      id: '401872945', sport: 'football', league: 'NFL', league_path: 'football/nfl',
      home, away,
    } as SportsGame;
    const entry = {
      settings: { channel_pins: [{ channel_id: 'c1', game: 'football/nfl/401872945', pinned_by: '1', pinned_at: '' }] },
      board: { games: [game] },
    };
    expect(scoreUpdateGame(entry, 'c1')?.id).toBe('401872945');
    expect(scoreUpdateGame(entry, 'other')).toBeNull();
    expect(scoreUpdateHref('g1', game)).toBe('/app/guilds/g1/sports/football/nfl/401872945');
    const update = parseScoreUpdate('Touchdown — Chiefs 14, Colts 7 · 8:41 2nd · K.Walker 4 yd run');
    expect(update && resolveScoreSides(game, update).lead.short_name).toBe('Chiefs');
    expect(update && resolveScoreSides(null, update).lead.logo).toBe('');
  });
});
