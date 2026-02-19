import type { ProtocolState, RealtimeEventEnvelope } from './types';

export type ProtocolHandlers = {
  onDispatch?: (event: string, data: unknown) => void;
  onReconnect?: () => void;
  onInvalidSession?: () => void;
  onStateChange?: (state: ProtocolState) => void;
};

export class GatewayProtocol {
  private state: ProtocolState = 'disconnected';
  private handlers: ProtocolHandlers = {};

  setHandlers(handlers: ProtocolHandlers): void {
    this.handlers = handlers;
  }

  getState(): ProtocolState {
    return this.state;
  }

  setConnected(): void {
    this.setState('connected');
  }

  setReconnecting(): void {
    this.setState('reconnecting');
  }

  handleFrame(raw: string): void {
    let payload: RealtimeEventEnvelope;
    try {
      payload = JSON.parse(raw) as RealtimeEventEnvelope;
    } catch {
      return;
    }
    if (payload.op === 0 && typeof payload.t === 'string') {
      this.handlers.onDispatch?.(payload.t, payload.d);
      return;
    }
    if (payload.op === 7) {
      this.handlers.onReconnect?.();
      return;
    }
    if (payload.op === 9) {
      this.handlers.onInvalidSession?.();
    }
  }

  private setState(next: ProtocolState): void {
    if (this.state === next) return;
    this.state = next;
    this.handlers.onStateChange?.(next);
  }
}

