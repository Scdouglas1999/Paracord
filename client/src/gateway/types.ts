export type TransportState = 'idle' | 'connecting' | 'open' | 'closing' | 'closed' | 'backoff';

export type ProtocolState =
  | 'disconnected'
  | 'connecting'
  | 'hello_wait'
  | 'identifying'
  | 'resuming'
  | 'connected'
  | 'reconnecting';

export interface GatewayDispatchPayload<T = unknown> {
  op: 0;
  t: string;
  s: number;
  d: T;
}

export interface RealtimeEventEnvelope {
  event_id?: number;
  op: number;
  t?: string;
  s?: number;
  d?: unknown;
}

export interface CommandEnvelope<T = Record<string, unknown>> {
  command_id: string;
  type: string;
  payload: T;
}

