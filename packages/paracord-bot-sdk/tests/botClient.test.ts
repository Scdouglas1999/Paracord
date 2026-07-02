import { describe, expect, it, vi } from 'vitest';
import {
  BotClient,
  InteractionResponseBuilder,
  SlashCommandBuilder,
} from '../src/index';

class FakeWs {
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  sent: string[] = [];

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }

  emitOpen(): void {
    this.onopen?.();
  }

  emitMessage(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe('BotClient', () => {
  it('routes INTERACTION_CREATE to command handler and posts callback', async () => {
    const ws = new FakeWs();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const bot = new BotClient({
      token: 'bot-token',
      applicationId: 'app-1',
      restBaseUrl: 'http://localhost:8080/api/v1',
      gatewayUrl: 'ws://localhost:8080/gateway',
      fetchImpl,
      wsFactory: () => ws,
    });

    bot.command(
      new SlashCommandBuilder().setName('ping').setDescription('ping').build(),
      async (ctx) => {
        await ctx.reply(InteractionResponseBuilder.message('pong'));
      },
    );

    const startPromise = bot.start();
    ws.emitOpen();
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } });
    ws.emitMessage({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } });
    await startPromise;

    ws.emitMessage({
      op: 0,
      t: 'INTERACTION_CREATE',
      s: 2,
      d: {
        id: 'interaction-1',
        type: 2,
        token: 'token-1',
        data: {
          name: 'ping',
        },
      },
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('/interactions/interaction-1/token-1/callback');
    expect((request as RequestInit).method).toBe('POST');
    bot.stop();
  });
});
