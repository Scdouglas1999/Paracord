import { describe, it, expect } from 'vitest';
import { scoreEntry } from './scoreConversation';
import {
  EPOCH_MS,
  conversationKey,
  type ConversationEntry,
} from './conversationModel';

const NOW = 1_720_000_000_000;

function snowflakeForMs(ms: number): string {
  return String((BigInt(ms) - BigInt(EPOCH_MS)) << 22n);
}

function entry(over: Partial<ConversationEntry> = {}): ConversationEntry {
  return {
    key: conversationKey('s', 'c'),
    serverId: 's',
    channelId: 'c',
    guildId: 'g',
    kind: 'guild_text',
    title: 't',
    contextLabel: null,
    lastActivityId: null,
    unread: false,
    mentionCount: 0,
    isDMUnread: false,
    isThreadReply: false,
    hasVoiceActivity: false,
    pinned: false,
    ...over,
  };
}

describe('scoreEntry — tier weights', () => {
  it('scores each signal at its exact base weight (no recency)', () => {
    expect(scoreEntry(entry({ mentionCount: 1 }), NOW)).toBe(1000);
    expect(scoreEntry(entry({ isDMUnread: true }), NOW)).toBe(400);
    expect(scoreEntry(entry({ isThreadReply: true }), NOW)).toBe(120);
    expect(scoreEntry(entry({ unread: true }), NOW)).toBe(40);
    expect(scoreEntry(entry({ hasVoiceActivity: true }), NOW)).toBe(30);
    expect(scoreEntry(entry(), NOW)).toBe(0);
  });

  it('ranks tiers in the §3.3 realized order', () => {
    const mention = scoreEntry(entry({ mentionCount: 1 }), NOW);
    const dm = scoreEntry(entry({ isDMUnread: true }), NOW);
    const thread = scoreEntry(entry({ isThreadReply: true }), NOW);
    const plain = scoreEntry(entry({ unread: true }), NOW);
    const voice = scoreEntry(entry({ hasVoiceActivity: true }), NOW);
    expect(mention).toBeGreaterThan(dm);
    expect(dm).toBeGreaterThan(thread);
    expect(thread).toBeGreaterThan(plain);
    expect(plain).toBeGreaterThan(voice);
    expect(voice).toBeGreaterThan(0);
  });
});

describe('scoreEntry — mention clamp', () => {
  it('clamps mentionCount at 9', () => {
    expect(scoreEntry(entry({ mentionCount: 9 }), NOW)).toBe(9000);
    expect(scoreEntry(entry({ mentionCount: 10 }), NOW)).toBe(9000);
    expect(scoreEntry(entry({ mentionCount: 999 }), NOW)).toBe(9000);
  });

  it('scales linearly below the clamp', () => {
    expect(scoreEntry(entry({ mentionCount: 3 }), NOW)).toBe(3000);
  });
});

describe('scoreEntry — recency boost', () => {
  it('adds a positive boost for a recent activity id', () => {
    const recent = entry({ lastActivityId: snowflakeForMs(NOW) });
    // Base 0 signals; boost ~= 8 at age 0 (sub-gap tie-shaper ceiling).
    const s = scoreEntry(recent, NOW);
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(8);
    expect(s).toBeCloseTo(8, 5);
  });

  it('decays with age', () => {
    const fresh = scoreEntry(entry({ lastActivityId: snowflakeForMs(NOW) }), NOW);
    const old = scoreEntry(
      entry({ lastActivityId: snowflakeForMs(NOW - 24 * 3_600_000) }),
      NOW
    );
    expect(fresh).toBeGreaterThan(old);
    expect(old).toBeGreaterThan(0);
  });

  it('adds no boost when lastActivityId is null', () => {
    expect(scoreEntry(entry({ unread: true, lastActivityId: null }), NOW)).toBe(40);
  });

  it('adds no boost for a future-dated id (negative age)', () => {
    const future = snowflakeForMs(NOW + 60 * 3_600_000);
    expect(scoreEntry(entry({ unread: true, lastActivityId: future }), NOW)).toBe(40);
  });

  it('is a tie-shaper: never lifts a lower tier above a higher tier', () => {
    // Worst case: a lower-tier entry as fresh as possible (max boost 8) must
    // still lose to a higher-tier entry as stale as possible (boost → 0). With
    // the sub-gap ceiling this holds STRICTLY, per-pair — a freshly-occupied
    // voice-only room can no longer evict a real plain-unread channel.
    const freshLower = entry({
      hasVoiceActivity: true, // 30
      lastActivityId: snowflakeForMs(NOW), // + ~8
    });
    const staleHigher = entry({
      unread: true, // 40, the very next tier up
      lastActivityId: snowflakeForMs(NOW - 1000 * 3_600_000), // boost ≈ 0
    });
    expect(scoreEntry(freshLower, NOW)).toBeLessThan(scoreEntry(staleHigher, NOW));

    // Within a tier, recency still breaks the tie (fresher ranks higher).
    const a = entry({ unread: true, lastActivityId: snowflakeForMs(NOW) });
    const b = entry({ unread: true, lastActivityId: snowflakeForMs(NOW - 6 * 3_600_000) });
    expect(scoreEntry(a, NOW)).toBeGreaterThan(scoreEntry(b, NOW));

    // And a strictly higher signal at equal recency always wins.
    const dm = entry({ isDMUnread: true, lastActivityId: snowflakeForMs(NOW - 6 * 3_600_000) });
    const plain = entry({ unread: true, lastActivityId: snowflakeForMs(NOW - 6 * 3_600_000) });
    expect(scoreEntry(dm, NOW)).toBeGreaterThan(scoreEntry(plain, NOW));

    // Guard the constructed worst-case values too.
    expect(scoreEntry(freshLower, NOW)).toBeLessThan(40);
    expect(scoreEntry(staleHigher, NOW)).toBeCloseTo(40, 1);
  });
});
