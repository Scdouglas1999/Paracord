import type { AxiosInstance } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A server with no connection must never make a domain call throw: every one of them is a
 * promise, so `fetch().then().catch()` in an effect (which is how most callers read) lands
 * in its catch and not in the error boundary. The selected server here has no client, as
 * in the seconds after a relaunch.
 */

const mocks = vi.hoisted(() => ({ getApiClient: vi.fn((): AxiosInstance | undefined => undefined) }));
vi.mock('./client', () => ({ apiClient: { id: 'home' } }));
vi.mock('../lib/connectionManager', () => ({ connectionManager: { getApiClient: mocks.getApiClient } }));

import { useServerListStore } from '../stores/serverListStore';
import { ServerNotConnectedError, getApi, getServerApi, isServerNotConnectedError } from './activeClient';
import { dailyWordApi } from './dailyWord';
import { feedsApi } from './feeds';
import { galleryApi } from './gallery';
import { gameServersApi } from './gameServers';
import { rejectWhenUnavailable, type RestClient } from './restClient';
import { serverFeedApi } from './serverFeed';
import { sportsApi } from './sports';

beforeEach(() => {
  mocks.getApiClient.mockReset();
  mocks.getApiClient.mockReturnValue(undefined);
  useServerListStore.setState({ activeServerId: 's_lan', servers: [] });
});

describe('the typed refusal', () => {
  it('names the server and is recognizable', () => {
    let thrown: unknown;
    try {
      getApi();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServerNotConnectedError);
    expect(isServerNotConnectedError(thrown)).toBe(true);
    expect((thrown as ServerNotConnectedError).serverId).toBe('s_lan');
    expect((thrown as Error).message).toBe('This server is not connected. Reconnect before trying again.');
    expect(isServerNotConnectedError(new Error('This server is not connected.'))).toBe(false);
  });

  it('is still the explicit refusal of getApi and getServerApi, and never the home client', () => {
    expect(() => getApi()).toThrow('not connected');
    expect(() => getServerApi('s_lan')).toThrow(ServerNotConnectedError);
  });
});

describe('rejectWhenUnavailable', () => {
  it('hands the client through when there is one', () => {
    const client = { get: vi.fn() } as unknown as RestClient;
    expect(rejectWhenUnavailable(() => client)()).toBe(client);
  });

  it('turns a missing client into rejected requests, for every verb', async () => {
    const failure = new ServerNotConnectedError('s_lan');
    const rest = rejectWhenUnavailable(() => {
      throw failure;
    })();
    for (const call of [rest.get('/x'), rest.post('/x'), rest.put('/x'), rest.patch('/x'), rest.delete('/x')]) {
      await expect(call).rejects.toBe(failure);
    }
  });
});

describe('domain calls that are not async themselves', () => {
  const calls: Array<[string, () => Promise<unknown>]> = [
    ['dailyWordApi.getToday', () => dailyWordApi.getToday()],
    ['dailyWordApi.getSettings', () => dailyWordApi.getSettings('g')],
    ['feedsApi.list', () => feedsApi.list('g')],
    ['feedsApi.adminSettings', () => feedsApi.adminSettings()],
    ['gameServersApi.list', () => gameServersApi.list('g')],
    ['sportsApi.listLeagues', () => sportsApi.listLeagues()],
    ['sportsApi.getSettings', () => sportsApi.getSettings('g')],
    ['sportsApi.getBoard', () => sportsApi.getBoard('g')],
    ['sportsApi.getStandings', () => sportsApi.getStandings('g', 'baseball/mlb')],
    ['galleryApi.guildAttachments', () => galleryApi.guildAttachments('g', { kind: 'image', limit: 6 })],
    ['galleryApi.channelLinks', () => galleryApi.channelLinks('c')],
    ['serverFeedApi.page', () => serverFeedApi.page('g', null)],
  ];

  it.each(calls)('%s rejects instead of throwing while the server is not connected', async (_name, call) => {
    let returned: Promise<unknown> | undefined;
    expect(() => {
      returned = call();
    }).not.toThrow();
    await expect(returned).rejects.toBeInstanceOf(ServerNotConnectedError);
  });
});
