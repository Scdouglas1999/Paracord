import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  home: { get: vi.fn(), post: vi.fn(), patch: vi.fn() },
  remote: { get: vi.fn(), post: vi.fn() },
  homeClient: vi.fn(),
}));
vi.mock('./activeClient', () => ({ getServerApi: mocks.homeClient, getApi: () => mocks.remote }));
import { authApi } from './auth';

const meResponse = {
  id: '1', username: 'owner', discriminator: 1, display_name: null,
  avatar_hash: null, banner_hash: null, bio: null, flags: 0, bot: false,
  system: false, created_at: '2026-01-01T00:00:00.000Z', pronouns: null,
  linked_accounts: [], email: 'owner@example.com', email_verified: false,
  public_key: null, has_public_key: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.homeClient.mockReturnValue(mocks.home);
  // Contract-validated endpoints need wire-shaped responses, not undefined.
  mocks.home.get.mockResolvedValue({ data: meResponse });
  mocks.home.patch.mockResolvedValue({ data: meResponse });
});

describe('home account API routing', () => {
  it('keeps login and private profile operations on home while a remote is selected', async () => {
    await authApi.login({ identifier: 'owner', password: 'synthetic-password' });
    await authApi.getMe();
    await authApi.updateMe({ display_name: 'Home profile' });
    expect(mocks.homeClient.mock.calls).toEqual([['__local__'], ['__local__'], ['__local__']]);
    expect(mocks.home.post).toHaveBeenCalledWith('/auth/login', { identifier: 'owner', password: 'synthetic-password' });
    expect(mocks.home.get).toHaveBeenCalledWith('/users/@me');
    expect(mocks.home.patch).toHaveBeenCalledWith('/users/@me', { display_name: 'Home profile' });
    expect(mocks.remote.post).not.toHaveBeenCalled();
  });
});
