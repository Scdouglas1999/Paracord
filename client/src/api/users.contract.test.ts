import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from './generated/CurrentUser';
import type { UpdatedCurrentUser } from './generated/UpdatedCurrentUser';
import type { UserSettingsResponse } from './generated/UserSettingsResponse';
import type { PublicUserProfile } from './generated/PublicUserProfile';
import { ApiContractError } from './responseContracts';

// The domain modules resolve the axios instance per request through
// activeClient; point it at a real axios instance driven by a stub adapter so
// the full axios pipeline (URL, method, JSON body, response.data) is exercised.
const mocks = vi.hoisted(() => ({ client: undefined as AxiosInstance | undefined }));
vi.mock('./activeClient', () => ({
  getApi: () => mocks.client,
  getServerApi: () => mocks.client,
}));
import { authApi } from './auth';
import { userApi } from './users';

function clientWith(data: unknown, status = 200): AxiosInstance {
  const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => ({
    data,
    status,
    statusText: 'OK',
    headers: new AxiosHeaders(),
    config,
  });
  const client = axios.create({ adapter });
  mocks.client = client;
  return client;
}

const currentUser: CurrentUser = {
  id: '123456789012345678',
  username: 'wire',
  discriminator: 42,
  display_name: null,
  avatar_hash: null,
  banner_hash: null,
  bio: null,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-09-12T12:00:00+00:00',
  pronouns: null,
  linked_accounts: [],
  email: 'wire@example.com',
  email_verified: false,
  public_key: null,
  has_public_key: false,
};

const updatedUser: UpdatedCurrentUser = {
  id: currentUser.id,
  username: currentUser.username,
  discriminator: 42,
  display_name: 'Wire',
  avatar_hash: null,
  banner_hash: null,
  bio: 'hi',
  flags: 0,
  bot: false,
  system: false,
  created_at: currentUser.created_at,
  email: 'wire@example.com',
};

const settings: UserSettingsResponse = {
  user_id: currentUser.id,
  theme: 'dark',
  locale: 'en-US',
  message_display_compact: false,
  custom_css: null,
  status: 'online',
  custom_status: null,
  crypto_auth_enabled: false,
  notifications: {},
  keybinds: {},
};

const profile: PublicUserProfile = {
  user: {
    id: '987654321098765432',
    username: 'subject',
    discriminator: 7,
    display_name: 'Subject',
    avatar_hash: null,
    banner_hash: null,
    bio: null,
    flags: 0,
    bot: false,
    system: false,
    created_at: '2026-09-12T12:00:00+00:00',
    pronouns: 'they/them',
    linked_accounts: [{ label: 'web', url: 'https://example.com' }],
  },
  roles: [],
  mutual_guilds: [{ id: '5', name: 'Shared', icon_url: null }],
  mutual_friends: [],
  created_at: '2026-09-12T12:00:00+00:00',
};

describe('current user contract', () => {
  it('accepts a fully nullable CurrentUser', async () => {
    clientWith(currentUser);
    const response = await authApi.getMe();
    expect(response.data).toEqual(currentUser);
  });

  it('rejects missing required fields and wrong types', async () => {
    const { email: _email, ...noEmail } = currentUser;
    clientWith(noEmail);
    await expect(authApi.getMe()).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...currentUser, discriminator: '0042' });
    await expect(authApi.getMe()).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' });

    clientWith({ ...currentUser, flags: '0' });
    await expect(authApi.getMe()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('rejects omitted nullable fields (bio must be present even when null)', async () => {
    const { bio: _bio, ...noBio } = currentUser;
    clientWith(noBio);
    await expect(authApi.getMe()).rejects.toBeInstanceOf(ApiContractError);
    const { public_key: _pk, ...noKey } = currentUser;
    clientWith(noKey);
    await expect(authApi.getMe()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('rejects a missing email on the update response but accepts the valid shape', async () => {
    clientWith(updatedUser);
    expect((await authApi.updateMe({ display_name: 'Wire' })).data).toEqual(updatedUser);

    const { email: _email, ...noEmail } = updatedUser;
    clientWith(noEmail);
    await expect(authApi.updateMe({ display_name: 'Wire' })).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe('user settings contract', () => {
  it('accepts the settings response with opaque theme/status strings', async () => {
    clientWith({ ...settings, theme: 'solarized-custom', status: 'lurking' });
    const response = await authApi.getSettings();
    expect(response.data.theme).toBe('solarized-custom');
    expect(response.data.status).toBe('lurking');
  });

  it('rejects missing required keys and non-object notifications', async () => {
    const { theme: _theme, ...noTheme } = settings;
    clientWith(noTheme);
    await expect(authApi.getSettings()).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...settings, notifications: [] });
    await expect(authApi.getSettings()).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...settings, message_display_compact: 'yes' });
    await expect(authApi.updateSettings({ theme: 'dark' })).rejects.toBeInstanceOf(ApiContractError);
  });

  it('rejects omitted custom_css/custom_status (nullable, not optional)', async () => {
    const { custom_css: _css, ...noCss } = settings;
    clientWith(noCss);
    await expect(authApi.getSettings()).rejects.toBeInstanceOf(ApiContractError);
    const { custom_status: _cs, ...noStatus } = settings;
    clientWith(noStatus);
    await expect(authApi.getSettings()).rejects.toBeInstanceOf(ApiContractError);
  });
});

describe('public profile contract', () => {
  it('accepts the profile card and preserves transport metadata', async () => {
    const client = clientWith(profile);
    const response = await userApi.getProfile('987654321098765432');
    expect(response.data).toEqual(profile);
    expect(response.config.url).toBe('/users/987654321098765432/profile');
    expect(client).toBeDefined();
  });

  it('rejects profiles missing required sections or with wrongly typed ids', async () => {
    const noRoles = { ...profile, roles: undefined };
    clientWith(noRoles);
    await expect(userApi.getProfile('1')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...profile, user: { ...profile.user, id: 123 } });
    await expect(userApi.getProfile('1')).rejects.toBeInstanceOf(ApiContractError);

    const { mutual_friends: _mf, ...noFriends } = profile;
    clientWith(noFriends);
    await expect(userApi.getProfile('1')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('rejects omitted nullable user fields but accepts present nulls', async () => {
    const { bio: _bio, ...userNoBio } = profile.user;
    clientWith({ ...profile, user: userNoBio });
    await expect(userApi.getProfile('1')).rejects.toBeInstanceOf(ApiContractError);

    const { pronouns: _p, ...userNoPronouns } = profile.user;
    clientWith({ ...profile, user: userNoPronouns });
    await expect(userApi.getProfile('1')).rejects.toBeInstanceOf(ApiContractError);
  });
});
