import { beforeEach, describe, expect, it } from 'vitest';
import type { SportsScoreEvent } from '../../api/sports';
import { writeHideScores } from './model';
import {
  createRepeatFilter,
  createSportsLineOnce,
  isScoreEvent,
  readScoreAlertsOn,
  scoreAlertText,
  shouldAlert,
  writeScoreAlertsOn,
} from './scoreAlerts';

function event(over: Partial<SportsScoreEvent> = {}): SportsScoreEvent {
  return {
    guild_id: 'g1',
    game: 'football/nfl/100',
    league_path: 'football/nfl',
    event_id: '100',
    kind: 'score',
    content: 'Touchdown — Chiefs 21, Colts 7 · 2:10 2nd · P.Mahomes 12 yd pass to T.Kelce',
    team_id: '12',
    favorite_team_ids: ['12'],
    home: { id: '12', abbr: 'KC', name: 'Chiefs', score: 21, logo: '' },
    away: { id: '11', abbr: 'IND', name: 'Colts', score: 7, logo: '' },
    ...over,
  };
}

describe('score alerts', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('names the team that scored, and the final', () => {
    expect(scoreAlertText(event())).toEqual({ title: 'Chiefs score', body: event().content });
    expect(scoreAlertText(event({ team_id: '11' })).title).toBe('Colts score');
    expect(scoreAlertText(event({ team_id: null })).title).toBe('Score');
    expect(scoreAlertText(event({ kind: 'final', team_id: null, content: 'Final — Chiefs 21, Colts 7' })))
      .toEqual({ title: 'Final', body: 'Final — Chiefs 21, Colts 7' });
  });

  it('accepts only a well-formed event', () => {
    expect(isScoreEvent(event())).toBe(true);
    expect(isScoreEvent({ ...event(), kind: 'halftime' })).toBe(false);
    expect(isScoreEvent({ guild_id: 'g1' })).toBe(false);
    expect(isScoreEvent(null)).toBe(false);
  });

  it('is on until this viewer turns it off for that server', () => {
    expect(readScoreAlertsOn('g1')).toBe(true);
    writeScoreAlertsOn('g1', false);
    expect(readScoreAlertsOn('g1')).toBe(false);
    expect(readScoreAlertsOn('g2')).toBe(true);
    expect(shouldAlert(event(), { serverMuted: false, fresh: () => true })).toBe(false);
    writeScoreAlertsOn('g1', true);
    expect(shouldAlert(event(), { serverMuted: false, fresh: () => true })).toBe(true);
  });

  it('stays quiet for a muted server and for someone hiding scores', () => {
    expect(shouldAlert(event(), { serverMuted: true, fresh: () => true })).toBe(false);
    writeHideScores(true);
    expect(shouldAlert(event(), { serverMuted: false, fresh: () => true })).toBe(false);
    writeHideScores(false);
    expect(shouldAlert(event(), { serverMuted: false, fresh: () => true })).toBe(true);
  });

  it('says a score once when two servers send it', () => {
    const fresh = createRepeatFilter(60_000);
    expect(fresh(event(), 0)).toBe(true);
    expect(fresh(event({ guild_id: 'g2' }), 1_000)).toBe(false);
    expect(fresh(event({ kind: 'final', content: 'Final — Chiefs 21, Colts 7' }), 2_000)).toBe(true);
    expect(fresh(event(), 70_000)).toBe(true);
  });

  it('says a score once when the channel post and the alert carry the same sentence', () => {
    const once = createSportsLineOnce(120_000);
    const line = 'Field goal — Chiefs 33, Colts 30 · 0:00 OT · Harrison Butker 40 Yd Field Goal';
    expect(once(line, 0)).toBe(true);
    expect(once(`${line} `, 50)).toBe(false);
    expect(once('Final — Chiefs 33, Colts 30 (OT)', 60)).toBe(true);
    expect(once(line, 200_000)).toBe(true);
  });
});
