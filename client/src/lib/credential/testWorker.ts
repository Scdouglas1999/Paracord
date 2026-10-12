import { handleKdfRequest } from './kdfCore';
import type { KdfWorkerLike } from './derive';

/**
 * Test-only stand-in for `kdf.worker.ts`: the same request handler, driven
 * through the same message protocol, with every worker it creates recorded so
 * tests can assert each one was terminated.
 */
export class InlineKdfWorker implements KdfWorkerLike {
  static created: InlineKdfWorker[] = [];
  terminated = false;
  posted = 0;
  transferred: Transferable[] = [];
  private readonly listeners: { message: ((event: MessageEvent) => void)[]; error: ((event: ErrorEvent) => void)[] } = { message: [], error: [] };

  constructor(private readonly behavior: 'run' | 'error' | ((data: unknown) => unknown) = 'run') {
    InlineKdfWorker.created.push(this);
  }

  addEventListener(type: 'message' | 'error', listener: ((event: MessageEvent) => void) | ((event: ErrorEvent) => void)): void {
    if (type === 'message') this.listeners.message.push(listener as (event: MessageEvent) => void);
    else this.listeners.error.push(listener as (event: ErrorEvent) => void);
  }

  postMessage(message: unknown, transfer: Transferable[] = []): void {
    this.posted += 1;
    this.transferred = transfer;
    // Cross the same structured-clone boundary a real worker does (and detach the sender's buffers).
    message = structuredClone(message, { transfer });
    if (this.terminated) throw new Error('posted to a terminated worker');
    const behavior = this.behavior;
    if (behavior === 'error') {
      queueMicrotask(() => this.listeners.error.forEach((listener) => listener({ message: 'boom' } as ErrorEvent)));
      return;
    }
    const answer = behavior === 'run'
      ? handleKdfRequest(message).then(({ response }) => response)
      : Promise.resolve(behavior(message));
    void answer.then((data) => {
      if (!this.terminated) this.listeners.message.forEach((listener) => listener({ data } as MessageEvent));
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

/** A minimal exclusive `navigator.locks` for jsdom. */
export function installTestLocks(): void {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request(name: string, _options: unknown, run: () => Promise<unknown>) {
      const previous = tails.get(name) ?? Promise.resolve();
      const result = previous.then(run, run);
      tails.set(name, result.catch(() => undefined));
      return result;
    },
  };
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true });
}
