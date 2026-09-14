import axios, { AxiosHeaders, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { describe, expect, it, vi } from 'vitest';
import { createGuildApi } from './guilds';
import { ApiContractError } from './responseContracts';
import { guildDetailFixture, guildSummaryFixture } from '../test/guildContractFixtures';

function clientWith(data: unknown, status = 200) {
  const adapter = vi.fn(async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => ({
    data, status, statusText: status === 201 ? 'Created' : 'OK',
    headers: new AxiosHeaders({ 'x-request-id': 'contract-test' }), config,
  }));
  const client = axios.create({ adapter });
  return { api: createGuildApi(() => client), adapter };
}

describe('production guild HTTP contracts', () => {
  it('accepts the smaller list summary without inventing detail settings', async () => {
    const data = [guildSummaryFixture({ member_count: 4 }), guildSummaryFixture({ id: '1002', member_count: 2 })];
    const { api, adapter } = clientWith(data);
    const response = await api.getAll();
    expect(response.data).toBe(data);
    expect(response.data.map(guild => guild.member_count)).toEqual([4, 2]);
    expect(response.data[0]).not.toHaveProperty('banner_hash');
    expect(adapter.mock.calls[0][0]).toMatchObject({ method: 'get', url: '/users/@me/guilds' });
  });

  it('accepts actual detail for reads and mutations and retains transport metadata', async () => {
    const detail = guildDetailFixture();
    const { api, adapter } = clientWith(detail, 201);
    const created = await api.create({ name: 'Test Server', icon: null });
    expect(created.data).toBe(detail);
    expect(created.status).toBe(201);
    expect(created.headers['x-request-id']).toBe('contract-test');
    expect(adapter.mock.calls[0][0]).toMatchObject({
      method: 'post', url: '/guilds', data: JSON.stringify({ name: 'Test Server', icon: null }),
    });
    expect((await api.get('1001')).data).toBe(detail);
    expect((await api.update('1001', { description: 'Updated' })).data).toBe(detail);
    expect((await api.joinPublic('1001')).data).toBe(detail);
  });

  it('rejects summary-shaped responses on all full-detail routes', async () => {
    const { api } = clientWith(guildSummaryFixture());
    for (const request of [
      () => api.get('1001'), () => api.create({ name: 'Test Server' }),
      () => api.update('1001', { name: 'Renamed' }), () => api.joinPublic('1001'),
    ]) {
      await expect(request()).rejects.toBeInstanceOf(ApiContractError);
    }
  });

  it('validates ownership-transfer replies without pretending they are guild details', async () => {
    const { api } = clientWith({ id: '1001', owner_id: '77' });
    expect((await api.transferOwnership('1001', '77')).data).toEqual({ id: '1001', owner_id: '77' });
    const invalid = clientWith({ id: '1001', owner_id: 77 });
    await expect(invalid.api.transferOwnership('1001', '77')).rejects.toBeInstanceOf(ApiContractError);
  });

  it('preserves transport failure and asynchronous unavailable-context behavior', async () => {
    const error = new Error('The account operation expired');
    const failed = axios.create({ adapter: async () => { throw error; } });
    await expect(createGuildApi(() => failed).getAll()).rejects.toBe(error);
    const absent = createGuildApi(() => { throw error; });
    const request = absent.create({ name: 'Never submitted' });
    await expect(request).rejects.toBe(error);
  });
});
