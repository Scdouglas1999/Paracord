import { beforeEach, describe, expect, it, vi } from 'vitest';

const dropServer = vi.fn();
const logout = vi.fn(async () => undefined);
vi.mock('../connectionManager', () => ({ connectionManager: { dropServer: (id: string) => dropServer(id) } }));
vi.mock('../secureStorage', () => ({ secureGet: vi.fn(async () => null), secureSet: vi.fn(async () => undefined), secureDelete: vi.fn(async () => undefined) }));

import { getStoredServerUrl, setStoredServerUrl } from '../config/apiBaseUrl';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import { leaveRemovedHost } from './afterRemove';

const HOST = 'https://127.0.0.1:8443';

function reset(servers: Array<{ id: string; url: string }>) {
  useServerListStore.setState({
    servers: servers.map((s) => ({ id: s.id, url: s.url, name: s.id, token: 't', connected: false })),
    activeServerId: servers[0]?.id ?? null,
  });
}

describe('leaveRemovedHost (Remove from this computer)', () => {
  beforeEach(() => {
    dropServer.mockClear();
    logout.mockClear();
    window.localStorage.clear();
    useAuthStore.setState({ logout });
  });

  it('signs out of the home server and goes to the welcome screen when nothing else is saved', async () => {
    setStoredServerUrl(HOST);
    reset([]);
    expect(await leaveRemovedHost(HOST)).toEqual({ kind: 'welcome' });
    expect(dropServer).toHaveBeenCalledWith('__local__');
    expect(logout).toHaveBeenCalledOnce();
    expect(getStoredServerUrl()).toBeNull();
  });

  it('removes a saved entry for the host and switches to another saved server', async () => {
    setStoredServerUrl(HOST);
    reset([{ id: 'host', url: HOST }, { id: 'other', url: 'https://friends.example.com' }]);
    expect(await leaveRemovedHost(HOST)).toEqual({ kind: 'switched', serverId: 'other' });
    expect(useServerListStore.getState().servers.map((s) => s.id)).toEqual(['other']);
    expect(useServerListStore.getState().activeServerId).toBe('other');
    expect(dropServer).toHaveBeenCalledWith('host');
    expect(getStoredServerUrl()).toBe('https://friends.example.com');
    expect(logout).toHaveBeenCalledOnce();
  });

  it('leaves a session on some other server alone', async () => {
    setStoredServerUrl('https://friends.example.com');
    reset([{ id: 'other', url: 'https://friends.example.com' }]);
    expect(await leaveRemovedHost(HOST)).toEqual({ kind: 'unchanged' });
    expect(dropServer).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
    expect(useServerListStore.getState().servers).toHaveLength(1);
  });

  it('a host that was only a saved entry is removed without signing the home session out', async () => {
    setStoredServerUrl('https://friends.example.com');
    reset([{ id: 'host', url: HOST }, { id: 'other', url: 'https://friends.example.com' }]);
    expect(await leaveRemovedHost(HOST)).toEqual({ kind: 'switched', serverId: 'other' });
    expect(logout).not.toHaveBeenCalled();
    expect(getStoredServerUrl()).toBe('https://friends.example.com');
  });
});
