import { describe, expect, it, vi } from 'vitest';

import { VideoSendQueue } from './videoSendQueue';

/** A send whose resolution the test controls. */
function deferred() {
  let resolve!: () => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('VideoSendQueue', () => {
  it('sends one frame at a time, in order', async () => {
    const order: number[] = [];
    let inFlight = 0;
    const queue = new VideoSendQueue<number>(async (frame) => {
      inFlight += 1;
      expect(inFlight).toBe(1);
      await Promise.resolve();
      order.push(frame);
      inFlight -= 1;
    });

    queue.enqueue(1, true);
    queue.enqueue(2, false);
    await queue.idle();

    expect(order).toEqual([1, 2]);
  });

  it('never lets a failed send escape as an unhandled rejection', async () => {
    const onError = vi.fn();
    const queue = new VideoSendQueue<number>(
      async () => {
        throw new Error('Failed to create send stream.');
      },
      { onError },
    );

    // The whole point: this call returns undefined and throws nothing.
    expect(queue.enqueue(1, true)).toBeUndefined();
    await queue.idle();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(queue.stats.failed).toBe(1);
    // A later keyframe still goes out — one refusal does not stop publishing.
    queue.enqueue(2, true);
    await queue.idle();
    expect(queue.stats.failed).toBe(2);
    // …and it is not reported again inside the same run of failures.
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('drops delta frames rather than growing without bound', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const queue = new VideoSendQueue<number>(
      async (frame) => {
        sent.push(frame);
        await gate.promise;
      },
      { depth: 2 },
    );

    queue.enqueue(1, true); // in flight
    queue.enqueue(2, false); // queued
    queue.enqueue(3, false); // queued — depth reached
    queue.enqueue(4, false); // dropped
    queue.enqueue(5, false); // dropped

    expect(queue.depthNow).toBe(2);
    expect(queue.stats.dropped).toBe(2);

    gate.resolve();
    await queue.idle();
    expect(sent).toEqual([1, 2, 3]);
  });

  it('lets a keyframe clear the deltas waiting behind it', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const queue = new VideoSendQueue<number>(
      async (frame) => {
        sent.push(frame);
        await gate.promise;
      },
      { depth: 2 },
    );

    queue.enqueue(1, true); // in flight
    queue.enqueue(2, false);
    queue.enqueue(3, false); // depth reached
    queue.enqueue(4, true); // keyframe: 2 and 3 are undecodable without it

    expect(queue.depthNow).toBe(1);
    expect(queue.stats.dropped).toBe(2);

    gate.resolve();
    await queue.idle();
    expect(sent).toEqual([1, 4]);
  });

  it('withholds every delta after a dropped one until a keyframe, and asks for it once', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const onChainBroken = vi.fn();
    const queue = new VideoSendQueue<number>(
      async (frame) => {
        sent.push(frame);
        await gate.promise;
      },
      { depth: 2, onChainBroken },
    );

    queue.enqueue(1, true); // in flight
    queue.enqueue(2, false);
    queue.enqueue(3, false); // depth reached
    queue.enqueue(4, false); // dropped: the chain breaks here
    gate.resolve();
    await queue.idle();
    // 5 and 6 predict from 4, which never left: sending them would hand the
    // viewer deltas that do not follow from anything it has.
    queue.enqueue(5, false);
    queue.enqueue(6, false);
    await queue.idle();
    expect(sent).toEqual([1, 2, 3]);
    expect(onChainBroken).toHaveBeenCalledTimes(1);

    queue.enqueue(7, true);
    queue.enqueue(8, false);
    await queue.idle();
    expect(sent).toEqual([1, 2, 3, 7, 8]);
    expect(queue.stats).toMatchObject({ dropped: 3, chainBreaks: 1 });
  });

  it('drops the deltas queued behind a refused send, but not a keyframe waiting there', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const onChainBroken = vi.fn();
    const queue = new VideoSendQueue<number>(
      async (frame) => {
        if (frame === 2) {
          await gate.promise;
          throw new Error('Failed to create send stream.');
        }
        sent.push(frame);
      },
      { depth: 3, onChainBroken },
    );

    queue.enqueue(2, true); // in flight, will be refused
    queue.enqueue(3, false); // orphaned by the refusal
    queue.enqueue(4, true); // restarts the chain
    queue.enqueue(5, false);
    gate.resolve();
    await queue.idle();

    expect(sent).toEqual([4, 5]);
    // The keyframe was already waiting, so there was nothing to ask for.
    expect(onChainBroken).not.toHaveBeenCalled();
  });

  it('goes quiet when the session ends rather than reporting every frame', async () => {
    const onError = vi.fn();
    const queue = new VideoSendQueue<number>(
      async () => {
        throw new DOMException('The media session has ended.', 'AbortError');
      },
      { onError },
    );

    queue.enqueue(1, true);
    await queue.idle();
    queue.enqueue(2, true);
    await queue.idle();

    expect(onError).not.toHaveBeenCalled();
    expect(queue.stats.failed).toBe(1);
  });

  it('accepts frames enqueued while a send is in flight', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const queue = new VideoSendQueue<number>(async (frame) => {
      sent.push(frame);
      if (frame === 1) await gate.promise;
    });

    queue.enqueue(1, true);
    queue.enqueue(2, false);
    gate.resolve();
    await queue.idle();

    expect(sent).toEqual([1, 2]);
  });

  it('stop() forgets the backlog and refuses anything further', async () => {
    const gate = deferred();
    const sent: number[] = [];
    const queue = new VideoSendQueue<number>(async (frame) => {
      sent.push(frame);
      await gate.promise;
    });

    queue.enqueue(1, true);
    queue.enqueue(2, false);
    queue.stop();
    queue.enqueue(3, true);
    gate.resolve();
    await queue.idle();

    expect(sent).toEqual([1]);
    expect(queue.depthNow).toBe(0);
  });
});
