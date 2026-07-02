import { describe, expect, it } from 'vitest';
import { redactApiLogUrl } from './client';

describe('API client log redaction', () => {
  it('redacts webhook token path segments without redacting webhook IDs', () => {
    expect(redactApiLogUrl('/webhooks/123456')).toBe('/webhooks/123456');
    expect(redactApiLogUrl('/webhooks/123456/secret-token')).toBe(
      '/webhooks/123456/[redacted]',
    );
    expect(redactApiLogUrl('/webhooks/123456/secret-token?wait=false')).toBe(
      '/webhooks/123456/[redacted]?wait=false',
    );
    expect(redactApiLogUrl('/webhooks/123456/secret-token/messages/987')).toBe(
      '/webhooks/123456/[redacted]/messages/987',
    );
  });

  it('redacts interaction token path segments and sensitive query parameters', () => {
    expect(
      redactApiLogUrl(
        'https://server.example/api/v1/interactions/app-1/interaction-token/messages/@original?session_id=sid&cursor=10',
      ),
    ).toBe(
      'https://server.example/api/v1/interactions/app-1/[redacted]/messages/@original?session_id=[redacted]&cursor=10',
    );
    expect(redactApiLogUrl('/interactions/interaction-1/callback-token/callback')).toBe(
      '/interactions/interaction-1/[redacted]/callback',
    );
    expect(redactApiLogUrl('/channels/123/messages?before=456')).toBe(
      '/channels/123/messages?before=456',
    );
  });
});
