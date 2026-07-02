// Canonical gateway envelope. There is exactly one source of truth for the
// wire format — `GatewayPayload` / `GatewayOpcode` in `../types/gateway.types`
// — which the live path (`lib/connectionManager`) and `dispatch` both consume.
// This module re-exports it so gateway consumers can import from a single
// gateway-scoped location without duplicating the shape.
export { GatewayOpcode } from '../types/gateway.types';
export type { GatewayPayload } from '../types/gateway.types';
