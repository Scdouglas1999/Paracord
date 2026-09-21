import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { GuildInvite } from './generated/GuildInvite';
import type { InvitePreview } from './generated/InvitePreview';
import type { InviteAcceptResponse } from './generated/InviteAcceptResponse';
import { ApiContractError } from './responseContracts';

const mocks = vi.hoisted(() => ({ client: undefined as AxiosInstance | undefined }));
vi.mock('./activeClient', () => ({
  getApi: () => mocks.client,
  getServerApi: () => mocks.client,
}));
import { inviteApi } from './invites';

function clientWith(data: unknown, status = 200): AxiosInstance {
  const adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => ({
    data,
    status,
    statusText: status === 201 ? 'Created' : 'OK',
    headers: new AxiosHeaders(),
    config,
  });
  const client = axios.create({ adapter });
  mocks.client = client;
  return client;
}

const invite: GuildInvite = {
  code: 'abc123',
  guild_id: '123456789012345678',
  channel_id: '223456789012345678',
  inviter_id: '323456789012345678',
  max_uses: 5,
  uses: 0,
  max_age: 3600,
  created_at: '2026-09-12T12:00:00+00:00',
};

const preview: InvitePreview = {
  code: 'abc123',
  guild: {
    id: '123456789012345678',
    name: 'Server',
    icon_hash: null,
    member_count: 3,
  },

};

const accepted: InviteAcceptResponse = {
  guild: {
    id: '123456789012345678',
    name: 'Server',
    description: null,
    icon_hash: null,
    owner_id: '323456789012345678',
    created_at: '2026-09-12T12:00:00+00:00',
    default_channel_id: '223456789012345678',
    member_count: 4,
  },
};

describe('invite contracts', () => {
  it('accepts the create response with decimal-string ids and null limits', async () => {
    clientWith({ ...invite, inviter_id: null, max_uses: null, max_age: null }, 201);
    const response = await inviteApi.create('223456789012345678');
    expect(response.data.guild_id).toBe('123456789012345678');
    expect(response.data.max_uses).toBeNull();
    expect(response.status).toBe(201);
  });

  it('rejects invites missing uses or with numeric guild_id', async () => {
    const { uses: _uses, ...noUses } = invite;
    clientWith(noUses, 201);
    await expect(inviteApi.create('1')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...invite, guild_id: 123 }, 201);
    await expect(inviteApi.create('1')).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' });
  });

  it('accepts a preview with a null guild and rejects omitted guild key', async () => {
    clientWith({ code: 'abc123', guild: null });
    expect((await inviteApi.get('abc123')).data.guild).toBeNull();

    clientWith({ code: 'abc123' });
    await expect(inviteApi.get('abc123')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...preview, guild: { ...preview.guild!, member_count: '3' } });
    await expect(inviteApi.get('abc123')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('validates the guild invite list', async () => {
    clientWith([invite]);
    const response = await inviteApi.listGuild('123456789012345678');
    expect(response.data).toEqual([invite]);
    expect(response.config.url).toBe('/guilds/123456789012345678/invites');

    const { code: _code, ...noCode } = invite;
    clientWith([noCode]);
    await expect(inviteApi.listGuild('1')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({}); // not an array at all
    await expect(inviteApi.listGuild('1')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('validates the accept response guild card', async () => {
    clientWith(accepted);
    const response = await inviteApi.accept('abc123');
    expect(response.data).toEqual(accepted);

    clientWith({ guild: { ...accepted.guild, owner_id: 7 } });
    await expect(inviteApi.accept('abc123')).rejects.toBeInstanceOf(ApiContractError);

    const { default_channel_id: _dc, ...guildNoDefault } = accepted.guild;
    clientWith({ guild: guildNoDefault });
    await expect(inviteApi.accept('abc123')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({});
    await expect(inviteApi.accept('abc123')).rejects.toBeInstanceOf(ApiContractError);
  });
});
