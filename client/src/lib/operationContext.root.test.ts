import { describe, expect, it } from 'vitest';
import { resolveCapturedApiRoot } from './operationContext';

describe('captured API root paths', () => {
  it('keeps versioned voice requests on the captured origin', () => {
    expect(resolveCapturedApiRoot('https://a.example/api/v1', '/api/v2/voice/12/join?fallback=livekit'))
      .toBe('https://a.example/api/v2/voice/12/join?fallback=livekit');
  });
  it.each(['//evil.example/api/v2/join', '/\\evil.example/api/v2/join', '/api/v2/../auth',
    '/api/v2/%2e%2e/auth', '/api/v2/%252e%252e/auth', '/api/v2/a%2fb', '/api/v2/a%255cb',
    '/api/v2/a//b', '/api/v2/a#other', 'https://evil.example/api/v2/join'])('rejects normalized path escape %s', path => {
    expect(() => resolveCapturedApiRoot('https://a.example/api/v1', path)).toThrow();
  });
});
