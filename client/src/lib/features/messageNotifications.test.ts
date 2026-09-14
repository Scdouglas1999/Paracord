import { describe, expect, it } from 'vitest';

import {
  effectiveNotificationLevel,
  messageAddressesReader,
  shouldNotifyForMessage,
} from './messageNotifications';
import type { NotificationSetting } from '../../api/notificationSettings';

function setting(over: Partial<NotificationSetting> = {}): NotificationSetting {
  return { level: 0, muted: false, muted_until: null, muted_now: false, suppress_everyone: false, ...over };
}

describe('effectiveNotificationLevel', () => {
  it('uses the room’s own level when it has one', () => {
    expect(effectiveNotificationLevel(setting({ level: 1 }), setting({ level: 0 }))).toBe(1);
    expect(effectiveNotificationLevel(setting({ level: 2 }), undefined)).toBe(2);
  });

  it('treats a mute that is in force now as "nothing", whichever side sets it', () => {
    expect(effectiveNotificationLevel(setting({ level: 0, muted_now: true }), undefined)).toBe(2);
    expect(effectiveNotificationLevel(undefined, setting({ level: 0, muted_now: true }))).toBe(2);
  });

  it('follows the server when the room holds no opinion', () => {
    expect(effectiveNotificationLevel(undefined, setting({ level: 1 }))).toBe(1);
    expect(effectiveNotificationLevel(undefined, undefined)).toBe(0);
  });

  it('lets a lapsed mute stop silencing the room', () => {
    // The server resolves `muted_now`; a mute that has expired is not in force.
    expect(effectiveNotificationLevel(setting({ muted: true, muted_now: false }), undefined)).toBe(0);
  });
});

describe('messageAddressesReader', () => {
  it('recognises a direct mention in either wire form', () => {
    expect(messageAddressesReader({ content: 'hello <@42> there' }, '42')).toBe(true);
    expect(messageAddressesReader({ content: 'hello <@!42>' }, '42')).toBe(true);
  });

  it('does not mistake somebody else’s mention for yours', () => {
    expect(messageAddressesReader({ content: 'hello <@43>' }, '42')).toBe(false);
  });

  it('counts @everyone unless the reader suppressed it', () => {
    expect(messageAddressesReader({ content: 'ping @everyone' }, '42')).toBe(true);
    expect(messageAddressesReader({ content: 'ping @everyone' }, '42', true)).toBe(false);
  });

  it('is false for an empty or absent message', () => {
    expect(messageAddressesReader({ content: '' }, '42')).toBe(false);
    expect(messageAddressesReader(null, '42')).toBe(false);
  });
});

describe('shouldNotifyForMessage', () => {
  it('says nothing at all for a muted room', () => {
    expect(shouldNotifyForMessage(2, true)).toBe(false);
    expect(shouldNotifyForMessage(2, false)).toBe(false);
  });

  it('speaks only for a mention at "only when you’re mentioned"', () => {
    expect(shouldNotifyForMessage(1, true)).toBe(true);
    expect(shouldNotifyForMessage(1, false)).toBe(false);
  });

  it('speaks for everything at "every message"', () => {
    expect(shouldNotifyForMessage(0, false)).toBe(true);
  });
});
