import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebTransportManager } from './webTransport';

/** Flush pending microtasks + the `void`-spawned per-stream reader tasks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe('WebTransport deferred acquisition ownership', () => {
  it('closes a transport whose ready result arrives after disposal without authenticating', async () => {
    const ready = deferred<void>();
    const close = vi.fn(); const authenticate = vi.fn();
    vi.stubGlobal('WebTransport', class { ready = ready.promise; close = close; createBidirectionalStream = authenticate; });
    const manager = new WebTransportManager();
    const connect = manager.connect('https://media.example', 'old-token').catch(error => error);
    await manager.disconnect(); ready.resolve();
    expect((await connect).name).toBe('AbortError');
    expect(close).toHaveBeenCalled(); expect(authenticate).not.toHaveBeenCalled();
    expect(manager.isConnected).toBe(false);
  });

  it('aborts a unidirectional stream acquired after disposal rather than writing a late frame', async () => {
    const stream = deferred<WritableStream<Uint8Array>>();
    const abort = vi.fn(async () => {}); const write = vi.fn(); const releaseLock = vi.fn();
    const manager = new WebTransportManager();
    (manager as unknown as { transport: unknown }).transport = { createUnidirectionalStream: () => stream.promise, close: vi.fn() };
    const send = manager.sendUniStream(new Uint8Array([1, 2]));
    await manager.disconnect();
    stream.resolve({ getWriter: () => ({ abort, write, releaseLock }) } as unknown as WritableStream<Uint8Array>);
    await send;
    expect(abort).toHaveBeenCalledTimes(1); expect(write).not.toHaveBeenCalled(); expect(releaseLock).toHaveBeenCalled();
  });
});

describe('WebTransportManager datagram writer reuse', () => {
  it('sendDatagram reuses one writer and does not call getWriter per send', () => {
    let getWriterCalls = 0;
    const written: Uint8Array[] = [];
    const fakeWriter = {
      write: async (chunk: Uint8Array) => {
        written.push(chunk);
      },
      releaseLock: () => {},
    };
    const fakeWritable = {
      getWriter() {
        getWriterCalls += 1;
        return fakeWriter;
      },
    };
    const mgr = new WebTransportManager();
    (mgr as unknown as { transport: unknown; datagramWriter: unknown }).transport = {
      datagrams: { writable: fakeWritable },
    };
    (mgr as unknown as { datagramWriter: unknown }).datagramWriter = fakeWritable.getWriter();

    mgr.sendDatagram(new Uint8Array([1]));
    mgr.sendDatagram(new Uint8Array([2, 3]));

    expect(getWriterCalls).toBe(1);
    expect(written).toHaveLength(2);
    expect(Array.from(written[0])).toEqual([1]);
    expect(Array.from(written[1])).toEqual([2, 3]);
  });

  it('sendDatagram is a no-op without a writer', () => {
    const mgr = new WebTransportManager();
    expect(() => mgr.sendDatagram(new Uint8Array([1]))).not.toThrow();
  });
});

describe('WebTransportManager unidirectional streams', () => {
  it('sendUniStream writes the whole message and finishes the stream', async () => {
    const written: Uint8Array[] = [];
    let closed = false;
    const fakeWritable = {
      getWriter() {
        return {
          write: async (chunk: Uint8Array) => {
            written.push(chunk);
          },
          close: async () => {
            closed = true;
          },
          releaseLock: () => {},
        };
      },
    };
    const mgr = new WebTransportManager();
    // Inject a minimal fake transport (the real one requires a live WebTransport).
    (mgr as unknown as { transport: unknown }).transport = {
      createUnidirectionalStream: async () => fakeWritable,
    };

    await mgr.sendUniStream(new Uint8Array([1, 2, 3, 4]));

    expect(written).toHaveLength(1);
    expect(Array.from(written[0])).toEqual([1, 2, 3, 4]);
    expect(closed).toBe(true);
  });

  it('readIncomingUniStreams drains each uni stream to its FIN and delivers the whole message', async () => {
    // One incoming uni stream that arrives in two chunks (the reader must
    // concatenate them into the single whole-frame message the relay sent).
    const receiveStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4, 5]));
        controller.close();
      },
    });
    const incoming = new ReadableStream({
      start(controller) {
        controller.enqueue(receiveStream);
        controller.close();
      },
    });

    const mgr = new WebTransportManager();
    const received: Uint8Array[] = [];
    mgr.onUniStream((data) => received.push(data));
    (mgr as unknown as { transport: unknown }).transport = {
      incomingUnidirectionalStreams: incoming,
    };

    await (
      mgr as unknown as { readIncomingUniStreams: () => Promise<void> }
    ).readIncomingUniStreams();
    await flush();

    expect(received).toHaveLength(1);
    expect(Array.from(received[0])).toEqual([1, 2, 3, 4, 5]);
  });

  it('sendUniStream is a no-op when there is no transport', async () => {
    const mgr = new WebTransportManager();
    await expect(mgr.sendUniStream(new Uint8Array([1]))).resolves.toBeUndefined();
  });
});
