import type { GuildDetail } from '../api/generated/GuildDetail';
import type { GuildSummary } from '../api/generated/GuildSummary';

/** Complete HTTP fixtures; partial gateway projections need not use these. */
export function guildDetailFixture(overrides: Partial<GuildDetail> = {}): GuildDetail {
  return {
    id: '1001', name: 'Test Space', owner_id: '42', member_count: 1,
    description: null, icon_hash: null, created_at: '2026-09-12T12:00:00+00:00',
    visibility: 'private', allowed_roles: [], discovery_tags: [],
    hub_settings: null, bot_settings: null, banner_hash: null,
    system_channel_id: null, vanity_url_code: null, feature_flags: 0,
    ...overrides,
  };
}

export function guildSummaryFixture(overrides: Partial<GuildSummary> = {}): GuildSummary {
  const { banner_hash: _banner, system_channel_id: _system, vanity_url_code: _vanity,
    feature_flags: _flags, ...summary } = guildDetailFixture();
  return { ...summary, ...overrides };
}
