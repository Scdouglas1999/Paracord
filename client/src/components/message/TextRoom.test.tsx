import { describe, expect, it } from 'vitest';

import { composerPlaceholder } from './MessageInput';

/**
 * The composer says where the message goes: "Message general"
 * (docs/server-home-spec.md, "Plain words"). The timeline's small shapes moved
 * to `TimelineParts.test.tsx` (IX-11).
 */

describe('the composer says where the message goes (plain words)', () => {
  it('names the channel, the group or the person', () => {
    expect(composerPlaceholder('general')).toBe('Message general');
    expect(composerPlaceholder('Ade, Jonas', 'group')).toBe('Message Ade, Jonas');
    expect(composerPlaceholder('Mara', 'person')).toBe('Message Mara');
  });

  it('has a phone form that drops a name too long to fit', () => {
    expect(composerPlaceholder('build-log', 'channel', true)).toBe('Message build-log');
    // A channel name can be any length, so past what fits the name is dropped.
    expect(composerPlaceholder('a-very-long-channel-name-indeed', 'channel', true)).toBe('Write a message');
    for (const name of ['general', 'build-log', 'a-very-long-channel-name-indeed']) {
      expect(composerPlaceholder(name, 'channel', true).length).toBeLessThanOrEqual(26);
    }
  });

  it('asks for a message when it has no name to give', () => {
    expect(composerPlaceholder()).toBe('Write a message');
    expect(composerPlaceholder(null, 'person')).toBe('Write a message');
  });

  it('never counts who is reading', () => {
    for (const copy of [composerPlaceholder('build-log'), composerPlaceholder('Mara', 'person'), composerPlaceholder()]) {
      expect(copy).not.toMatch(/reading|people|person/);
    }
  });
});
