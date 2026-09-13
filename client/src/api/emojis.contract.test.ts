import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { GuildEmoji } from './generated/GuildEmoji';
import { ApiContractError } from './responseContracts';

const mocks = vi.hoisted(() => ({ client: undefined as AxiosInstance | undefined }));
vi.mock('./activeClient', () => ({
  getApi: () => mocks.client,
  getServerApi: () => mocks.client,
}));
import { emojiApi } from './emojis';

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

const emoji: GuildEmoji = {
  id: '423456789012345678',
  guild_id: '123456789012345678',
  name: 'partyparrot',
  animated: false,
  creator_id: '323456789012345678',
  created_at: '2026-09-12T12:00:00+00:00',
};

const pngFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'e.png', { type: 'image/png' });

describe('emoji contracts', () => {
  it('accepts the list shape including a null creator', async () => {
    clientWith([emoji, { ...emoji, id: '5', name: 'gone', creator_id: null, animated: true }]);
    const response = await emojiApi.listGuild('123456789012345678');
    expect(response.data).toHaveLength(2);
    expect(response.data[1].creator_id).toBeNull();
  });

  it('rejects entries missing required fields or with wrongly typed ids', async () => {
    const { animated: _a, ...noAnimated } = emoji;
    clientWith([noAnimated]);
    await expect(emojiApi.listGuild('1')).rejects.toBeInstanceOf(ApiContractError);

    clientWith([{ ...emoji, id: 42 }]);
    await expect(emojiApi.listGuild('1')).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' });
  });

  it('rejects omitted creator_id (nullable, not optional)', async () => {
    const { creator_id: _c, ...noCreator } = emoji;
    clientWith([noCreator]);
    await expect(emojiApi.listGuild('1')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('validates create and update responses', async () => {
    clientWith(emoji, 201);
    const created = await emojiApi.create('123456789012345678', { name: 'partyparrot', file: pngFile });
    expect(created.data).toEqual(emoji);
    expect(created.status).toBe(201);

    clientWith({ ...emoji, name: 'renamed' });
    expect((await emojiApi.update('1', '2', 'renamed')).data.name).toBe('renamed');

    clientWith({ ...emoji, name: 7 });
    await expect(emojiApi.update('1', '2', 'renamed')).rejects.toBeInstanceOf(ApiContractError);

    clientWith({ ...emoji, guild_id: undefined });
    await expect(
      emojiApi.create('1', { name: 'partyparrot', file: pngFile }),
    ).rejects.toBeInstanceOf(ApiContractError);
  });
});
