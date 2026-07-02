// Thin re-export of the live gateway. The single realtime implementation lives
// in `lib/connectionManager`; this module exposes it under the `gateway` name
// (and re-exports `LOCAL_SERVER_ID` / `ServerConnection`) so callers can import
// from the gateway module without reaching into `lib/`.
import { connectionManager, LOCAL_SERVER_ID, type ServerConnection } from '../lib/connectionManager';

export { LOCAL_SERVER_ID, type ServerConnection };

export const gateway = connectionManager;
