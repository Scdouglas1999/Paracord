import type { ApiErrorPayload } from './types.js';

export class ParacordApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly payload: ApiErrorPayload | null;

  constructor(status: number, payload: ApiErrorPayload | null) {
    super(payload?.message || payload?.error || `Paracord API request failed (${status})`);
    this.name = 'ParacordApiError';
    this.status = status;
    this.code = payload?.code;
    this.payload = payload;
  }
}

export class ParacordGatewayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParacordGatewayError';
  }
}
