import { describe, expect, it } from 'vitest';
import { WebTransportManager } from './webTransport';

/** Flush pending microtasks + the `void`-spawned per-stream reader tasks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

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
