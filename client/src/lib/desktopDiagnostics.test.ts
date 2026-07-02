import { describe, expect, it } from 'vitest';
import { redactDiagnosticValue } from './desktopDiagnostics';

describe('desktop diagnostics redaction', () => {
  it('redacts sensitive object keys and token-like strings', () => {
    const redacted = redactDiagnosticValue({
      token: 'pc-access-token',
      refresh_token: 'pc-refresh-token',
      nested: {
        Authorization: 'Bearer super-secret-token',
        url: 'https://server.example/api/v2/rt/events?token=secret-token&session_id=session-1&cursor=7',
        jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
      },
      message: 'connect failed with Bearer another-secret',
    });

    expect(redacted).toEqual({
      token: '[redacted]',
      refresh_token: '[redacted]',
      nested: {
        Authorization: '[redacted]',
        url: 'https://server.example/api/v2/rt/events?token=[redacted]&session_id=[redacted]&cursor=7',
        jwt: '[redacted]',
      },
      message: 'connect failed with Bearer [redacted]',
    });
  });

  it('serializes errors without carrying raw secret-bearing messages', () => {
    const redacted = redactDiagnosticValue(
      new Error('request failed for https://server.example/upload?media_token=secret'),
    );

    expect(redacted).toEqual({
      name: 'Error',
      message: 'request failed for https://server.example/upload?media_token=[redacted]',
    });
  });
});
