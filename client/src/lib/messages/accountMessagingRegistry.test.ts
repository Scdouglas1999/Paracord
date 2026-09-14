import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../crypto/deviceAccountVault', () => ({ openDeviceAccountVault: vi.fn(async () => { throw new Error('no vault in this test'); }) }));
vi.mock('../crypto/accountVaultSession', () => ({ openAccountVault: vi.fn(async () => { throw new Error('no vault in this test'); }) }));

import { getAccountMessagingRuntime, reconcileAccountMessaging, resetAccountMessagingRuntimes } from './accountMessagingRuntime';
import { useAuthStore } from '../../stores/authStore';
import { useServerListStore } from '../../stores/serverListStore';
import type { User } from '../../types';

const serverId = 's_registry-test';
const scope = { serverId, userId: '42' };
const entry = {
  id: serverId, name: 'Registry test', url: 'http://localhost:8090', connected: true,
  token: 'token', userId: '42', user: { id: '42', username: 'owner' } as User,
};

function setServers(servers: unknown[]) {
  useServerListStore.setState({ servers: servers as never });
}

beforeEach(() => {
  resetAccountMessagingRuntimes();
  useAuthStore.setState({ token: null, user: null });
  setServers([entry]);
});
afterEach(() => { resetAccountMessagingRuntimes(); vi.restoreAllMocks(); });

describe('account messaging runtime registry', () => {
  /**
   * The registry runs on every auth/server-list/account-store change, and a
   * server entry reads as "no account" for as long as its token is momentarily
   * absent — token hydration, a credential being re-verified, a refresh that
   * clears before it sets. Throwing the runtime away there hands the live
   * gateway session a *replacement* runtime, and a replacement has never
   * accepted a handshake: the next ordinary message then failed as "the message
   * event preceded authenticated recovery", which the gateway reported as a
   * durable storage failure and answered by dropping a healthy transport.
   */
  it('keeps the account runtime while its scope is momentarily unreadable', () => {
    const runtime = getAccountMessagingRuntime(scope);
    setServers([{ ...entry, token: null }]);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(scope)).toBe(runtime);

    setServers([{ ...entry, user: undefined, userId: undefined }]);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(scope)).toBe(runtime);

    setServers([entry]);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(scope)).toBe(runtime);
  });

  it('releases a runtime whose account really is gone', () => {
    const runtime = getAccountMessagingRuntime(scope);
    setServers([]);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(scope)).not.toBe(runtime);
  });

  it('releases a runtime whose server now names a different account', () => {
    const runtime = getAccountMessagingRuntime(scope);
    setServers([{ ...entry, userId: '84', user: { id: '84', username: 'someone-else' } as User }]);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(scope)).not.toBe(runtime);
  });

  it('releases the home runtime once the home session signs out', () => {
    setServers([]);
    useAuthStore.setState({ token: 'home-token', user: { id: '42', username: 'owner' } as User });
    const home = { serverId: '__local__', userId: '42' };
    const runtime = getAccountMessagingRuntime(home);
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(home)).toBe(runtime);

    useAuthStore.setState({ token: null });
    reconcileAccountMessaging();
    expect(getAccountMessagingRuntime(home)).not.toBe(runtime);
  });
});
