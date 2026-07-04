import { describe, it, expect } from 'vitest';
import {
  EPOCH_MS,
  snowflakeToMs,
  conversationKey,
  type ConversationEntry,
  type ConversationKind,
} from './conversationModel';

/** Build a snowflake for a given epoch-ms with zeroed worker/sequence bits. */
function snowflakeForMs(ms: number): string {
  return String((BigInt(ms) - BigInt(EPOCH_MS)) << 22n);
}

describe('snowflakeToMs', () => {
  it('decodes the custom epoch: id 0 → EPOCH_MS', () => {
    expect(snowflakeToMs('0')).toBe(EPOCH_MS);
  });

  it('round-trips an arbitrary timestamp', () => {
    const ms = 1_720_000_000_000; // some time in 2024
    const id = snowflakeForMs(ms);
    expect(snowflakeToMs(id)).toBe(ms);
  });

  it('ignores the low 22 worker/sequence bits', () => {
    const ms = 1_710_000_000_000;
    const base = (BigInt(ms) - BigInt(EPOCH_MS)) << 22n;
    // Same timestamp, different worker/sequence → same decoded ms.
    const withJunk = String(base | 0b1010101010101010101010n);
    expect(snowflakeToMs(withJunk)).toBe(ms);
  });

  it('is monotonic: a later id decodes to a larger ms', () => {
    const a = snowflakeForMs(1_705_000_000_000);
    const b = snowflakeForMs(1_706_000_000_000);
    expect(snowflakeToMs(b)).toBeGreaterThan(snowflakeToMs(a));
  });
});

describe('conversationKey', () => {
  it('composes serverId:channelId', () => {
    expect(conversationKey('srv1', '12345')).toBe('srv1:12345');
  });

  it('disambiguates the same channelId across servers', () => {
    expect(conversationKey('a', '99')).not.toBe(conversationKey('b', '99'));
  });
});

describe('ConversationEntry type surface', () => {
  it('accepts a fully-populated entry of every kind', () => {
    const kinds: ConversationKind[] = [
      'dm',
      'group_dm',
      'guild_text',
      'thread',
      'voice',
      'guild_home',
    ];
    for (const kind of kinds) {
      const entry: ConversationEntry = {
        key: conversationKey('s', 'c'),
        serverId: 's',
        channelId: 'c',
        guildId: kind === 'dm' || kind === 'group_dm' ? null : 'g',
        kind,
        title: 't',
        contextLabel: null,
        lastActivityId: null,
        unread: false,
        mentionCount: 0,
        isDMUnread: false,
        isThreadReply: false,
        hasVoiceActivity: false,
        pinned: false,
      };
      expect(entry.kind).toBe(kind);
      expect(entry.key).toBe('s:c');
    }
  });
});
