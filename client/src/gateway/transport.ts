import type { TransportState } from './types';

export type TransportHandlers = {
  onOpen?: () => void;
  onMessage?: (data: string) => void;
  onError?: () => void;
  onClose?: () => void;
  onStateChange?: (state: TransportState) => void;
};

export class EventSourceTransport {
  private source: EventSource | null = null;
  private state: TransportState = 'idle';
  private handlers: TransportHandlers = {};

  setHandlers(handlers: TransportHandlers): void {
    this.handlers = handlers;
  }

  getState(): TransportState {
    return this.state;
  }

  connect(url: string): void {
    if (this.source) return;
    this.setState('connecting');
    const source = new EventSource(url, { withCredentials: true });
    this.source = source;

    source.onopen = () => {
      this.setState('open');
      this.handlers.onOpen?.();
    };
    source.onmessage = (evt) => {
      this.handlers.onMessage?.(evt.data);
    };
    source.addEventListener('gateway', (evt) => {
      const msg = evt as MessageEvent<string>;
      this.handlers.onMessage?.(msg.data);
    });
    source.onerror = () => {
      this.handlers.onError?.();
      this.close();
      this.handlers.onClose?.();
    };
  }

  close(): void {
    if (!this.source) return;
    this.setState('closing');
    this.source.close();
    this.source = null;
    this.setState('closed');
  }

  private setState(next: TransportState): void {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onStateChange?.(next);
  }
}

