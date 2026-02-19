import { connectionManager, LOCAL_SERVER_ID, type ServerConnection } from '../lib/connectionManager';

export { LOCAL_SERVER_ID, type ServerConnection };

// New canonical gateway manager surface.
export const gateway = connectionManager;

