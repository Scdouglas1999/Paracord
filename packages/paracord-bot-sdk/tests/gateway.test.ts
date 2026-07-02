import { describe, expect, it } from 'vitest';
import { ParacordGatewayClient } from '../src/index';

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

describe('ParacordGatewayClient', () => {
  it('identifies and resolves on READY', async () => {
    const ws = new FakeWs();
    const client = new ParacordGatewayClient({
      url: 'ws://localhost:8080/gateway',
      token: 'bot-token',
      intents: 513,
      wsFactory: () => ws,
    });

    const connectPromise = client.connect();
    ws.emitOpen();
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } });
    ws.emitMessage({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } });

    await connectPromise;

    const identifyPayload = ws.sent.map((item) => JSON.parse(item)).find((item) => item.op === 2);
    expect(identifyPayload).toBeTruthy();
    expect(identifyPayload.d.token).toBe('bot-token');
    expect(identifyPayload.d.intents).toBe(513);

    client.close();
  });

  it('emits dispatch events', async () => {
    const ws = new FakeWs();
    const client = new ParacordGatewayClient({
      url: 'ws://localhost:8080/gateway',
      token: 'bot-token',
      wsFactory: () => ws,
    });

    const events: string[] = [];
    client.on<{ event: string }>('DISPATCH', ({ event }) => events.push(event));

    const connectPromise = client.connect();
    ws.emitOpen();
    ws.emitMessage({ op: 10, d: { heartbeat_interval: 60_000 } });
    ws.emitMessage({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess-1' } });
    await connectPromise;

    ws.emitMessage({ op: 0, t: 'INTERACTION_CREATE', s: 2, d: { id: 'i-1', type: 2 } });
    expect(events).toContain('INTERACTION_CREATE');

    client.close();
  });
});
