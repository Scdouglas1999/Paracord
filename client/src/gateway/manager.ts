// Thin re-export of the live gateway. The single realtime implementation lives
// in `lib/connectionManager`; this module exposes it under the `gateway` name
// (and re-exports `LOCAL_SERVER_ID` / `ServerConnection`) so callers can import
// from the gateway module without reaching into `lib/`.
// Keep this a live binding: gateway dispatch imports call state, which can in
// turn import this module. Copying the singleton during module evaluation reads
// it before initialization and prevents even the login screen from mounting.
export { connectionManager as gateway, LOCAL_SERVER_ID, type ServerConnection } from '../lib/connectionManager';
