import { describe, expect, it } from 'vitest';

import { encryptionCaption, subtitleFor, type SubtitleFacts } from './subtitle';
import type { ConversationSubject } from './types';

const CHANNEL: ConversationSubject = { kind: 'channel', guildId: 'g1', channelId: 'c1', channelName: 'general' };
const facts = (over: Partial<SubtitleFacts> = {}): SubtitleFacts => ({
  serverName: 'Fuel',
  isLanding: false,
  known: true,
  encrypted: false,
  encryption: 'ready',
  ...over,
});

describe('the line under the large title (§4.11)', () => {
  it('is the topic', () => {
    expect(subtitleFor({ ...CHANNEL, topic: ' Haz 5 runs ' }, facts())).toEqual({ text: 'Haz 5 runs', lock: null });
  });

  it('says whose it is in the server’s first channel when it has no topic (the prototype’s line)', () => {
    expect(subtitleFor(CHANNEL, facts({ isLanding: true })).text).toBe('Fuel’s main channel');
    expect(subtitleFor(CHANNEL, facts()).text).toBeNull();
    expect(subtitleFor({ ...CHANNEL, topic: 'Plans' }, facts({ isLanding: true })).text).toBe('Plans');
  });

  it('a thread says where it lives, in the page’s words', () => {
    expect(subtitleFor({ ...CHANNEL, subtitle: 'Thread in general · started by Mara', topic: 'x' }, facts()).text).toBe(
      'Thread in general · started by Mara',
    );
  });

  it('a direct message, and a group with how many', () => {
    expect(subtitleFor({ kind: 'dm', channelId: 'd', title: 'Jeremy', isGroup: false }, facts()).text).toBe('Direct message');
    expect(subtitleFor({ kind: 'dm', channelId: 'd', title: 'Crew', isGroup: true, participants: 4 }, facts()).text).toBe('Group · 4 people');
    expect(subtitleFor({ kind: 'dm', channelId: 'd', title: 'Crew', isGroup: true }, facts()).text).toBe('Group message');
  });

  it('an encrypted conversation adds the lock line after it, once the server has said so', () => {
    const dm: ConversationSubject = { kind: 'dm', channelId: 'd', title: 'Jeremy', isGroup: false };
    expect(subtitleFor(dm, facts({ encrypted: true }))).toEqual({ text: 'Direct message', lock: 'End-to-end encrypted' });
    // Still asking: say nothing rather than guess.
    expect(subtitleFor(dm, facts({ encrypted: true, known: false })).lock).toBeNull();
    // Not encrypted is not announced.
    expect(subtitleFor(dm, facts({ encrypted: false })).lock).toBeNull();
  });

  it('keeps the old words for a vault that is locked, mismatched or not set up', () => {
    expect(encryptionCaption('unlock')).toBe('Encryption locked on this device');
    expect(encryptionCaption('identity_mismatch')).toBe('Encryption keys do not match');
    expect(encryptionCaption('setup')).toBe('Encryption needs setup');
  });
});
