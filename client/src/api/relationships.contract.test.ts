import axios, { AxiosHeaders, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import type { RelationshipList } from './generated/RelationshipList';
import { ApiContractError } from './responseContracts';
import { useRelationshipStore } from '../stores/relationshipStore';

const mocks = vi.hoisted(() => ({ client: undefined as AxiosInstance | undefined }));
vi.mock('./activeClient', () => ({
  getApi: () => mocks.client,
  getServerApi: () => mocks.client,
}));
import { relationshipApi } from './relationships';

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

const list: RelationshipList = [
  {
    id: '111:222',
    user_id: '111',
    target_id: '222',
    type: 1,
    rel_type: 1,
    created_at: '2026-09-12T12:00:00+00:00',
    user: {
      id: '222',
      username: 'friend',
      discriminator: 9,
      display_name: null,
      avatar_hash: null,
    },
  },
  {
    id: '111:333',
    user_id: '111',
    target_id: '333',
    type: 2,
    rel_type: 2,
    created_at: '2026-09-12T12:00:00+00:00',
    user: {
      id: '333',
      username: 'blocked',
      discriminator: 4,
      display_name: 'Blocked User',
      avatar_hash: 'deadbeef',
    },
  },
];

describe('relationship list contract', () => {
  it('accepts the wire list and projects it to the app shape', async () => {
    clientWith(list);
    const response = await relationshipApi.list();
    expect(response.data).toEqual([
      { id: '111:222', type: 1, user: list[0].user },
      { id: '111:333', type: 2, user: list[1].user },
    ]);
  });

  it('rejects a missing nested user and non-string ids', async () => {
    const { user: _user, ...noUser } = list[0];
    clientWith([noUser]);
    await expect(relationshipApi.list()).rejects.toBeInstanceOf(ApiContractError);

    clientWith([{ ...list[0], target_id: 222 }]);
    await expect(relationshipApi.list()).rejects.toMatchObject({ code: 'INVALID_SERVER_RESPONSE' });
  });

  it('rejects entries missing either type field or created_at', async () => {
    const { rel_type: _rt, ...noRelType } = list[0];
    clientWith([noRelType]);
    await expect(relationshipApi.list()).rejects.toBeInstanceOf(ApiContractError);

    const { type: _t, ...noType } = list[0];
    clientWith([noType]);
    await expect(relationshipApi.list()).rejects.toBeInstanceOf(ApiContractError);

    const { created_at: _ca, ...noCreated } = list[0];
    clientWith([noCreated]);
    await expect(relationshipApi.list()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('rejects omitted nested nullable fields (display_name must be present)', async () => {
    const { display_name: _dn, ...userNoDn } = list[0].user;
    clientWith([{ ...list[0], user: userNoDn }]);
    await expect(relationshipApi.list()).rejects.toBeInstanceOf(ApiContractError);
  });

  it('keeps cached store data when the server returns a malformed list', async () => {
    const cached = [{ id: '111:222', type: 1, user: list[0].user }];
    useRelationshipStore.setState({ relationships: cached, isLoading: false });

    clientWith([{ ...list[0], user: { ...list[0].user, discriminator: 'nine' } }]);
    await useRelationshipStore.getState().fetchRelationships();

    const state = useRelationshipStore.getState();
    expect(state.relationships).toBe(cached);
    expect(state.isLoading).toBe(false);
  });
});
