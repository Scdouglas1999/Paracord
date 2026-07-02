import { describe, expect, it, vi } from 'vitest';
import { ParacordApiError, ParacordRestClient } from '../src/index';

describe('ParacordRestClient', () => {
  it('retries once when rate limited and then succeeds', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ retry_after: 0.001 }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ id: '1', name: 'ping', description: 'Ping' }]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    const client = new ParacordRestClient({
      baseUrl: 'http://localhost:8080/api/v1',
      token: 'bot-token',
      fetchImpl,
      maxRateLimitRetries: 2,
    });

    const commands = await client.listGlobalCommands('app-1');
    expect(commands).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws typed API errors', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: 'forbidden', code: 'forbidden' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new ParacordRestClient({
      baseUrl: 'http://localhost:8080/api/v1',
      token: 'bot-token',
      fetchImpl,
    });

    await expect(client.listGlobalCommands('app-1')).rejects.toBeInstanceOf(ParacordApiError);
  });
});
