import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('customEmoji', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    localStorage.clear();
    sessionStorage.clear();
  });

  it('formats safe custom emoji tokens and falls back for invalid ids', async () => {
    const { formatCustomEmojiToken, parseCustomEmojiToken } = await import('./customEmoji');

    expect(formatCustomEmojiToken('party blob!', '123', true)).toBe('<a:party_blob_:123>');
    expect(formatCustomEmojiToken('party', 'not-an-id')).toBe(':party:');
    expect(parseCustomEmojiToken('<:party:123>')).toEqual({
      raw: '<:party:123>',
      animated: false,
      name: 'party',
      id: '123',
    });
  });

  it('appends the access token for cross-origin emoji image resources', async () => {
    vi.stubEnv('VITE_API_URL', 'https://api.example.com/api/v1');
    const { setAccessToken } = await import('./authToken');
    setAccessToken('emoji-token');
    const { buildGuildEmojiImageUrl } = await import('./customEmoji');

    expect(buildGuildEmojiImageUrl('guild 1', 'emoji/2')).toBe(
      'https://api.example.com/api/v1/guilds/guild%201/emojis/emoji%2F2/image?token=emoji-token',
    );
  });
});
