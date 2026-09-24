import { beforeEach, describe, expect, it, vi } from 'vitest';

const gatewayMock = vi.hoisted(() => ({
  updatePresenceAll: vi.fn(),
  getAllConnections: vi.fn(() => [{ serverId: 'srv', connected: true }]),
}));
vi.mock('../gateway/manager', () => ({ gateway: gatewayMock, LOCAL_SERVER_ID: '__local__' }));

import {
  composeActivities,
  publishPresence,
  republishPresenceAfterReconnect,
  resetPresenceActivities,
  setActivitySource,
  setAutoIdle,
  type ActivitySource,
} from './presenceActivities';
import { useAuthStore } from '../stores/authStore';
import { usePresenceStore } from '../stores/presenceStore';
import { useServerListStore } from '../stores/serverListStore';
import type { Activity, UserSettings } from '../types';

const listening: Activity = { name: 'Spotify', type: 2, details: 'Windowlicker', state: 'Aphex Twin' };
const playing: Activity = { name: 'Factorio', type: 0, details: 'Playing Factorio' };
const together: Activity = { name: 'Paracord', type: 3, details: 'Koyaanisqatsi' };

function setSettings(settings: Partial<UserSettings>) {
  useAuthStore.setState({ settings: { status: 'online', ...settings } as UserSettings });
}

function lastSent() {
  const calls = gatewayMock.updatePresenceAll.mock.calls;
  return calls[calls.length - 1];
}

describe('presence activities', () => {
  beforeEach(() => {
    resetPresenceActivities();
    gatewayMock.updatePresenceAll.mockClear();
    usePresenceStore.getState().reset();
    setSettings({ status: 'online', custom_status: null });
    vi.spyOn(useServerListStore.getState(), 'getServer').mockReturnValue({ userId: 'me' } as never);
  });

  it('sends every source together, the together session first', () => {
    const sources = new Map<ActivitySource, Activity>([
      ['playing', playing],
      ['listening', listening],
    ]);
    expect(composeActivities(sources)).toEqual([listening, playing]);
  });

  it('a together session replaces the OS media track while it runs', () => {
    const sources = new Map<ActivitySource, Activity>([
      ['listening', listening],
      ['together', together],
      ['playing', playing],
    ]);
    expect(composeActivities(sources)).toEqual([together, playing]);
  });

  it('one feature setting its activity keeps the others', () => {
    setActivitySource('playing', playing);
    setActivitySource('listening', listening);
    expect(lastSent()).toEqual(['online', [listening, playing], '']);
    setActivitySource('listening', null);
    expect(lastSent()).toEqual(['online', [playing], '']);
  });

  it('going idle keeps what you are listening to and sends your custom status', () => {
    setSettings({ status: 'online', custom_status: 'heads down' });
    setActivitySource('listening', listening);
    setAutoIdle(true);
    expect(lastSent()).toEqual(['idle', [listening], 'heads down']);
    expect(usePresenceStore.getState().getPresence('me', 'srv')).toMatchObject({
      status: 'idle',
      activities: [listening],
      custom_status: 'heads down',
    });
  });

  it('invisible shares nothing', () => {
    setActivitySource('listening', listening);
    setSettings({ status: 'invisible' });
    publishPresence();
    expect(lastSent()).toEqual(['offline', [], '']);
  });

  it('does not resend an unchanged presence, but does after a reconnect', () => {
    setActivitySource('listening', listening);
    const count = gatewayMock.updatePresenceAll.mock.calls.length;
    setActivitySource('listening', { ...listening });
    publishPresence();
    expect(gatewayMock.updatePresenceAll.mock.calls.length).toBe(count);
    republishPresenceAfterReconnect();
    expect(gatewayMock.updatePresenceAll.mock.calls.length).toBe(count + 1);
  });

  it('a reconnect with nothing to say sends nothing', () => {
    republishPresenceAfterReconnect();
    expect(gatewayMock.updatePresenceAll).not.toHaveBeenCalled();
  });
});
