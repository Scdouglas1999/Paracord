import { describe, expect, it } from 'vitest';
import { isReadyGuildCore } from './generated/validators';

// READY projects each joined space to persisted metadata only. Per-dispatch
// gateway fields (channels, voice state, presences, lazy markers) ride along as
// extensions and are intentionally outside this contract.
const readyGuild = {
  id: '123456789012345678',
  owner_id: '987654321098765432',
  name: 'Space',
  icon_hash: 'a1b2c3d4',
  created_at: '2026-09-12T12:00:00+00:00',
  member_count: 2,
};

type CoreField = keyof typeof readyGuild;

function without(field: CoreField) {
  const { [field]: _omitted, ...rest } = readyGuild;
  return rest;
}

describe('gateway READY guild core contract', () => {
  it('accepts the six-field payload with per-dispatch gateway extensions', () => {
    const payload = {
      ...readyGuild,
      channels: [{ id: '7001', name: 'general' }],
      voice_states: [{ user_id: readyGuild.owner_id }],
      presences: [],
      lazy: true,
    };
    expect(isReadyGuildCore(payload)).toBe(true);
    expect(isReadyGuildCore(readyGuild)).toBe(true);
  });

  it.each(['id', 'owner_id', 'name', 'icon_hash', 'created_at', 'member_count'] as const)(
    'rejects a guild missing required field %s',
    field => {
      expect(isReadyGuildCore(without(field))).toBe(false);
    },
  );

  it('accepts a present null icon but rejects wrongly typed icons', () => {
    expect(isReadyGuildCore({ ...readyGuild, icon_hash: null })).toBe(true);
    expect(isReadyGuildCore({ ...readyGuild, icon_hash: 42 })).toBe(false);
    expect(isReadyGuildCore({ ...readyGuild, icon_hash: undefined })).toBe(false);
  });

  it.each([null, '2', -1, 1.5, 4294967296])('rejects member_count %s', member_count => {
    expect(isReadyGuildCore({ ...readyGuild, member_count })).toBe(false);
  });

  it.each([0, 4294967295])('accepts member_count %s at the u32 boundary', member_count => {
    expect(isReadyGuildCore({ ...readyGuild, member_count })).toBe(true);
  });

  it.each(['id', 'owner_id', 'name'] as const)(
    'rejects empty and whitespace-only %s',
    field => {
      for (const value of ['', '   ', '\t\n']) {
        expect(isReadyGuildCore({ ...readyGuild, [field]: value })).toBe(false);
      }
    },
  );

  it('requires created_at to be a nonempty string without claiming date semantics', () => {
    expect(isReadyGuildCore({ ...readyGuild, created_at: '' })).toBe(false);
    expect(isReadyGuildCore({ ...readyGuild, created_at: 0 })).toBe(false);
    // The schema constrains wire shape only; semantic date validation is applied
    // at integration, so arbitrary nonempty text still passes the guard.
    expect(isReadyGuildCore({ ...readyGuild, created_at: 'not-a-date' })).toBe(true);
  });

  it('does not require the REST settings surface on a valid core', () => {
    for (const field of [
      'description', 'visibility', 'allowed_roles', 'discovery_tags',
      'hub_settings', 'bot_settings', 'banner_hash', 'system_channel_id',
      'vanity_url_code', 'feature_flags',
    ]) {
      expect(readyGuild).not.toHaveProperty(field);
    }
    expect(isReadyGuildCore(readyGuild)).toBe(true);
  });
});
