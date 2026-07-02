import { describe, expect, it } from 'vitest';
import { getGuildSettingsErrorMessage } from './GuildSettings';

describe('getGuildSettingsErrorMessage', () => {
  it('prefers structured API response messages', () => {
    const err = {
      response: {
        data: {
          message: 'Webhook execution was rate limited',
        },
      },
    };

    expect(getGuildSettingsErrorMessage(err, 'Failed to execute webhook test message')).toBe(
      'Webhook execution was rate limited',
    );
  });

  it('preserves normal Error messages for clipboard and network failures', () => {
    expect(
      getGuildSettingsErrorMessage(
        new Error('Clipboard permission denied.'),
        'Could not copy webhook URL',
      ),
    ).toBe('Clipboard permission denied.');
  });

  it('falls back when no useful detail is available', () => {
    expect(getGuildSettingsErrorMessage({ response: { data: {} } }, 'Request failed')).toBe(
      'Request failed',
    );
  });
});
