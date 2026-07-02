import { describe, it, expect } from 'vitest';
import {
  APP_NAME,
  API_VERSION,
  MAX_MESSAGE_LENGTH,
  MAX_GUILD_NAME_LENGTH,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_USERNAME_LENGTH,
  MIN_USERNAME_LENGTH,
  MIN_PASSWORD_LENGTH,
  MAX_FILE_SIZE,
  DEFAULT_MESSAGE_FETCH_LIMIT,
  MAX_MESSAGE_FETCH_LIMIT,
  MESSAGES_PER_PAGE,
  TYPING_TIMEOUT,
  HEARTBEAT_INTERVAL,
} from './constants';

describe('constants', () => {
  it('has correct app name', () => {
    expect(APP_NAME).toBe('Paracord');
  });

  it('has correct API version', () => {
    expect(API_VERSION).toBe('v1');
  });

  it('has sensible message length limit', () => {
    expect(MAX_MESSAGE_LENGTH).toBe(2000);
    expect(MAX_MESSAGE_LENGTH).toBeGreaterThan(0);
  });

  it('has sensible name length limits', () => {
    expect(MAX_GUILD_NAME_LENGTH).toBe(100);
    expect(MAX_CHANNEL_NAME_LENGTH).toBe(100);
    expect(MAX_USERNAME_LENGTH).toBe(32);
    expect(MIN_USERNAME_LENGTH).toBe(2);
    expect(MIN_USERNAME_LENGTH).toBeLessThan(MAX_USERNAME_LENGTH);
  });

  it('has sensible password length requirement', () => {
    expect(MIN_PASSWORD_LENGTH).toBe(10);
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('has 1GB file size limit', () => {
    expect(MAX_FILE_SIZE).toBe(1024 * 1024 * 1024);
  });

  it('has correct pagination defaults', () => {
    expect(DEFAULT_MESSAGE_FETCH_LIMIT).toBe(50);
    expect(MAX_MESSAGE_FETCH_LIMIT).toBe(100);
    expect(MESSAGES_PER_PAGE).toBe(50);
    expect(DEFAULT_MESSAGE_FETCH_LIMIT).toBeLessThanOrEqual(MAX_MESSAGE_FETCH_LIMIT);
  });

  it('has correct timing values', () => {
    expect(TYPING_TIMEOUT).toBe(10000);
    expect(HEARTBEAT_INTERVAL).toBe(41250);
    expect(TYPING_TIMEOUT).toBeGreaterThan(0);
    expect(HEARTBEAT_INTERVAL).toBeGreaterThan(0);
  });
});
