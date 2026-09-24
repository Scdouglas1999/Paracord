import { describe, expect, it } from 'vitest';
import { checkedLabel, feedStatusLine, inputProblem } from './feedStatus';

const NOW = Date.parse('2026-09-24T12:00:00Z');

describe('feed status', () => {
  it('says how long ago a source was checked', () => {
    expect(checkedLabel(null, NOW)).toBe('Waiting for the first check');
    expect(checkedLabel('2026-09-24T11:59:40Z', NOW)).toBe('Checked just now');
    expect(checkedLabel('2026-09-24T11:56:00Z', NOW)).toBe('Checked 4 min ago');
    expect(checkedLabel('2026-09-24T09:00:00Z', NOW)).toBe('Checked 3 h ago');
    expect(checkedLabel('2026-09-23T09:00:00Z', NOW)).toBe('Checked yesterday');
  });

  it('puts pause first, then the error in plain words, then the last check', () => {
    const status = {
      last_checked_at: '2026-09-24T11:56:00Z',
      last_success_at: null,
      next_check_at: null,
      last_posted_at: null,
      error: null as string | null,
    };
    expect(feedStatusLine({ paused: false, status }, NOW)).toEqual({ text: 'Checked 4 min ago', tone: 'ok' });
    const failing = { ...status, error: 'The feed address returned 404.' };
    expect(feedStatusLine({ paused: false, status: failing }, NOW)).toEqual({
      text: 'The feed address returned 404.',
      tone: 'error',
    });
    expect(feedStatusLine({ paused: true, status: failing }, NOW)).toEqual({ text: 'Paused', tone: 'paused' });
  });

  it('names an obviously wrong entry before asking the server', () => {
    expect(inputProblem('rss', 'ftp://example.com/feed')).toBe('Only http and https addresses can be used.');
    expect(inputProblem('rss', 'example.com/feed')).toBeNull();
    expect(inputProblem('youtube', 'https://vimeo.com/1')).toMatch(/youtube\.com/);
    expect(inputProblem('youtube', '@lanternworks')).toBeNull();
    expect(inputProblem('github', 'not a repo')).toBe('Type the repository as owner/repo.');
    expect(inputProblem('github', 'https://github.com/tokio-rs/axum')).toBeNull();
    expect(inputProblem('github', 'a/b', '')).toBe('Name the branch to follow.');
    expect(inputProblem('twitch', 'twitch.tv/x')).toMatch(/3 to 25/);
    expect(inputProblem('twitch', 'https://www.twitch.tv/lantern_works')).toBeNull();
  });
});
