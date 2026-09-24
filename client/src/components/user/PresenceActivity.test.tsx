import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

import { ActivityCard, PersonStatusLine, StatusLineText } from './PresenceActivity';
import { describeActivity } from '../../lib/activityDisplay';
import { usePresenceStore } from '../../stores/presenceStore';
import { useServerListStore } from '../../stores/serverListStore';

const T0 = Date.parse('2026-09-24T10:00:00.000Z');

describe('ActivityCard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 + 60_000);
  });
  afterEach(() => vi.useRealTimers());

  it('shows the track, the artist and app, and a progress bar that moves', () => {
    const view = describeActivity({
      name: 'Spotify',
      type: 2,
      details: 'Windowlicker',
      state: 'Aphex Twin',
      started_at: new Date(T0).toISOString(),
      ends_at: new Date(T0 + 367_000).toISOString(),
    })!;
    render(<ActivityCard view={view} />);
    expect(screen.getByText('Windowlicker')).toBeTruthy();
    expect(screen.getByText(/Aphex Twin · Spotify/)).toBeTruthy();
    const bar = screen.getByRole('progressbar', { name: 'Track progress' });
    expect(bar.getAttribute('aria-valuetext')).toBe('1:00 of 6:07');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(bar.getAttribute('aria-valuetext')).toBe('1:05 of 6:07');
  });

  it('has no bar without a timeline, and says how long a game has been going', () => {
    const view = describeActivity({
      name: 'Factorio',
      type: 0,
      details: 'Playing Factorio',
      started_at: new Date(T0).toISOString(),
    })!;
    render(<ActivityCard view={view} />);
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getByText('for 1m 0s')).toBeTruthy();
  });
});

describe('status lines', () => {
  beforeEach(() => {
    usePresenceStore.getState().reset();
    useServerListStore.setState({ activeServerId: 'srv' });
  });

  it('a member row shows the track with a note, and the verb for screen readers', () => {
    usePresenceStore.getState().updatePresence(
      {
        user_id: '7',
        status: 'online',
        activities: [{ name: 'Spotify', type: 2, details: 'Windowlicker', state: 'Aphex Twin' }],
      },
      'srv',
    );
    const { container } = render(<PersonStatusLine userId="7" />);
    const line = container.querySelector('[data-activity-kind="listening"]')!;
    expect(line.textContent).toBe('Listening to Windowlicker — Aphex Twin');
    expect(line.getAttribute('title')).toBe('Listening to Windowlicker by Aphex Twin on Spotify');
    expect(container.querySelector('.sr-only')?.textContent).toBe('Listening to ');
  });

  it('a custom status wins in a row', () => {
    usePresenceStore.getState().updatePresence(
      {
        user_id: '8',
        status: 'online',
        custom_status: 'heads down',
        activities: [{ name: 'Spotify', type: 2, details: 'Windowlicker' }],
      },
      'srv',
    );
    render(<PersonStatusLine userId="8" />);
    expect(screen.getByText('heads down')).toBeTruthy();
    expect(screen.queryByText(/Windowlicker/)).toBeNull();
  });

  it('nothing for somebody with no status line', () => {
    const { container } = render(<PersonStatusLine userId="9" />);
    expect(container.textContent).toBe('');
  });

  it('renders a watch-together line', () => {
    const view = describeActivity({ name: 'Paracord', type: 3, details: 'Watching Koyaanisqatsi' })!;
    render(<StatusLineText line={{ type: 'activity', activity: view }} />);
    expect(screen.getByText('Watching Koyaanisqatsi')).toBeTruthy();
  });
});
