import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileTransportManager } from './fileTransportManager';

function frame(message: object): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(4 + json.length);
  new DataView(bytes.buffer).setUint32(0, json.length, false);
  bytes.set(json, 4);
  return bytes;
}

function peer(chunks: Uint8Array[]) {
  const close = vi.fn();
  const writes: Uint8Array[] = [];
  const instance = {
    ready: Promise.resolve(),
    closed: new Promise<void>(() => {}),
    close,
    createBidirectionalStream: async () => ({
      writable: new WritableStream<Uint8Array>({ write: (value) => { writes.push(value); } }),
      readable: new ReadableStream<Uint8Array>({ start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      } }),
    }),
  };
  return { instance, close, writes };
}

const pin = btoa(String.fromCharCode(...new Uint8Array(32)));
afterEach(() => vi.unstubAllGlobals());

describe('FileTransportManager authentication', () => {
  it('accepts a fragmented pong and sends the exact transfer capability', async () => {
    const pong = frame({ type: 'pong' });
    const server = peer([pong.slice(0, 2), pong.slice(2, 7), pong.slice(7)]);
    vi.stubGlobal('WebTransport', class { constructor() { return server.instance; } });
    const manager = new FileTransportManager();
    const connection = await manager.getOrConnect('https://test/files', 'file-token', pin);
    const sent = server.writes[0];
    expect(JSON.parse(new TextDecoder().decode(sent.slice(4)))).toEqual({ type: 'auth', token: 'file-token' });
    manager.release(connection);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it.each([
    ['EOF', []],
    ['wrong acknowledgement', [frame({ type: 'session_state' })]],
    ['oversized prefix', [new Uint8Array([0xff, 0xff, 0xff, 0xff])]],
  ])('rejects %s without retaining the connection', async (_name, chunks) => {
    const server = peer(chunks as Uint8Array[]);
    vi.stubGlobal('WebTransport', class { constructor() { return server.instance; } });
    const manager = new FileTransportManager();
    await expect(manager.getOrConnect('https://test/files', 'token', pin)).rejects.toThrow();
    expect(server.close).toHaveBeenCalledOnce();
    manager.disconnect();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('keeps concurrent upload credentials and cleanup separate', async () => {
    const first = peer([frame({ type: 'pong' })]);
    const second = peer([frame({ type: 'pong' })]);
    const peers = [first, second];
    vi.stubGlobal('WebTransport', class { constructor() { return peers.shift()!.instance; } });
    const manager = new FileTransportManager();
    const [a, b] = await Promise.all([
      manager.getOrConnect('https://test/files', 'first-token', pin),
      manager.getOrConnect('https://test/files', 'second-token', pin),
    ]);
    expect(a).not.toBe(b);
    manager.release(a);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
    manager.release(b);
  });
});
