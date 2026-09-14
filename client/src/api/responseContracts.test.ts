import { describe, expect, it } from 'vitest';
import { AxiosHeaders, type AxiosResponse } from 'axios';
import { ApiContractError, responseContract } from './responseContracts';
import { isCreateGuildRequest, isGuildDetail, isGuildSummaryList } from './generated/validators';

// The public wire shape uses nullable keys, decimal string IDs and an actual
// member count. This fixture intentionally includes extension settings and an
// unknown server field, which a newer compatible server is allowed to add.
const guild = {
  id: '123456789012345678', name: 'Server', owner_id: '987654321098765432',
  member_count: 2, description: null, icon_hash: null,
  created_at: '2026-09-12T12:00:00+00:00', visibility: 'private',
  allowed_roles: [], discovery_tags: [],
  hub_settings: { welcome_text: 'Hello', future_setting: { nested: true } },
  bot_settings: { welcome: { enabled: true, custom_message: 'Hello' } },
  banner_hash: null, system_channel_id: null, vanity_url_code: null, feature_flags: 0,
  future_field: 'preserved',
};
function response(data: unknown): AxiosResponse<unknown> {
  return { data, status: 200, statusText: 'OK', headers: new AxiosHeaders({ 'x-request-id': 'request' }), config: { headers: new AxiosHeaders() } };
}

describe('Rust-derived wire validation', () => {
  it('accepts the response without coercion, dropping fields or replacing transport metadata', async () => {
    const incoming = response(guild);
    const accepted = await responseContract(Promise.resolve(incoming), isGuildDetail, 'GuildDetail');
    expect(accepted.data).toBe(guild);
    expect(accepted.headers).toBe(incoming.headers);
    expect(accepted.status).toBe(200);
    expect(accepted.data.id).toBe('123456789012345678');
    expect(accepted.data.future_field).toBe('preserved');
  });

  it.each([
    { ...guild, member_count: undefined },
    { ...guild, member_count: '2' },
    { ...guild, member_count: -1 },
    { ...guild, member_count: 1.5 },
    { ...guild, member_count: 4294967296 },
    { ...guild, feature_flags: 2147483648 },
    { ...guild, description: undefined },
    { ...guild, hub_settings: { welcome_text: 42 } },
    { ...guild, visibility: 'unknown' },
    { ...guild, owner_id: 123 },
  ])('rejects incompatible data without exposing it in diagnostics', async invalid => {
    const data = { ...invalid, private_fixture_marker: 'DO_NOT_LOG_USER_CONTENT' };
    const failure = await responseContract(Promise.resolve(response(data)), isGuildDetail, 'GuildDetail').catch(error => error);
    expect(failure).toBeInstanceOf(ApiContractError);
    expect(failure.message).not.toContain('DO_NOT_LOG_USER_CONTENT');
    expect(JSON.stringify(failure)).not.toContain('DO_NOT_LOG_USER_CONTENT');
    expect(data).toEqual({ ...invalid, private_fixture_marker: 'DO_NOT_LOG_USER_CONTENT' });
  });

  it('distinguishes summary lists, full detail and optional request fields', () => {
    const { banner_hash: _banner, system_channel_id: _system, vanity_url_code: _vanity, feature_flags: _flags, ...summary } = guild;
    expect(isGuildSummaryList([summary])).toBe(true);
    expect(isGuildDetail(summary)).toBe(false);
    expect(isCreateGuildRequest({ name: 'Server' })).toBe(true);
    expect(isCreateGuildRequest({ name: 3 })).toBe(false);
  });

  it('preserves upstream authentication, ownership and transport failures', async () => {
    const failure = new Error('request ownership expired');
    await expect(responseContract(Promise.reject(failure), isGuildDetail, 'GuildDetail')).rejects.toBe(failure);
  });
});
