import { ParacordGatewayError } from './errors.js';
import type {
  GatewayClientOptions,
  GatewayHelloData,
  GatewayPayload,
  GatewayReadyData,
  GatewayWebSocketLike,
} from './types.js';

type Listener<T = unknown> = (payload: T) => void;

export class ParacordGatewayClient {
  private readonly options: GatewayClientOptions;
  private ws: GatewayWebSocketLike | null = null;
  private sequence: number | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private heartbeatIntervalMs = 0;
  private sessionId: string | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private readyResolver: (() => void) | null = null;
  private readyRejecter: ((error: unknown) => void) | null = null;
  private destroyed = false;

  constructor(options: GatewayClientOptions) {
    this.options = options;
  }

  on<T = unknown>(event: string, listener: Listener<T>): () => void {
    const key = event.toUpperCase();
    const set = this.listeners.get(key) ?? new Set();
    set.add(listener as Listener);
    this.listeners.set(key, set);
    return () => this.off(key, listener as Listener);
  }

  off(event: string, listener: Listener): void {
    const key = event.toUpperCase();
    const set = this.listeners.get(key);
    if (!set) return;
    set.delete(listener);
    if (set.size === 0) {
      this.listeners.delete(key);
    }
  }

  async connect(): Promise<void> {
    if (this.ws) return;
    if (this.destroyed) {
      throw new ParacordGatewayError('Gateway client is closed');
    }
    const wsFactory = this.options.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as GatewayWebSocketLike);
    const ws = wsFactory(this.options.url);
    this.ws = ws;

    const readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolver = resolve;
      this.readyRejecter = reject;
    });

    ws.onopen = () => {
      this.emit('OPEN', undefined);
    };

    ws.onmessage = (event) => {
      this.handleMessage(event.data);
    };

    ws.onerror = () => {
      this.emit('ERROR', undefined);
    };

    ws.onclose = () => {
      this.stopHeartbeat();
      this.ws = null;
      if (!this.destroyed && this.readyRejecter) {
        this.readyRejecter(new ParacordGatewayError('Gateway closed before READY'));
      }
      this.emit('CLOSE', undefined);
    };

    return readyPromise;
  }

  close(code?: number, reason?: string): void {
    this.destroyed = true;
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close(code, reason);
      this.ws = null;
    }
  }

  send(payload: GatewayPayload): void {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new ParacordGatewayError('Gateway is not connected');
    }
    this.ws.send(JSON.stringify(payload));
  }

  private emit(event: string, payload: unknown): void {
    const set = this.listeners.get(event.toUpperCase());
    if (!set) return;
    for (const listener of set) {
      listener(payload);
    }
  }

  private handleMessage(raw: string): void {
    const payload = JSON.parse(raw) as GatewayPayload;
    if (typeof payload.s === 'number') {
      this.sequence = payload.s;
    }

    switch (payload.op) {
      case 10:
        this.handleHello(payload.d as GatewayHelloData);
        break;
      case 11:
        this.emit('HEARTBEAT_ACK', undefined);
        break;
      case 0:
        this.handleDispatch(payload.t || '', payload.d);
        break;
      case 7:
        this.emit('RECONNECT', undefined);
        this.reconnect();
        break;
      case 9:
        this.sessionId = null;
        this.emit('INVALID_SESSION', payload.d);
        this.identify();
        break;
      default:
        this.emit('RAW', payload);
        break;
    }
  }

  private handleHello(data: GatewayHelloData): void {
    this.heartbeatIntervalMs = data.heartbeat_interval;
    this.startHeartbeat();
    this.identify();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: 1, d: this.sequence });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private identify(): void {
    if (this.sessionId && this.sequence !== null) {
      this.send({
        op: 6,
        d: {
          token: this.options.token,
          session_id: this.sessionId,
          seq: this.sequence,
        },
      });
      return;
    }

    this.send({
      op: 2,
      d: {
        token: this.options.token,
        intents: this.options.intents ?? 0,
      },
    });
  }

  private handleDispatch(event: string, data: unknown): void {
    if (event === 'READY') {
      this.sessionId = (data as GatewayReadyData | undefined)?.session_id ?? null;
      if (this.readyResolver) {
        this.readyResolver();
        this.readyResolver = null;
        this.readyRejecter = null;
      }
    }
    this.emit('DISPATCH', { event, data });
    this.emit(event, data);
  }

  private reconnect(): void {
    if (!this.ws) return;
    const previous = this.ws;
    previous.close(4000, 'Reconnecting');
  }
}
