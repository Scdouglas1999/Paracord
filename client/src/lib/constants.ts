export const APP_NAME = 'Paracord';
export const API_VERSION = 'v1';
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_GUILD_NAME_LENGTH = 100;
export const MAX_CHANNEL_NAME_LENGTH = 100;
export const MAX_USERNAME_LENGTH = 32;
export const MIN_USERNAME_LENGTH = 2;
export const MIN_PASSWORD_LENGTH = 10;
export const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
export const P2P_THRESHOLD = 1024 * 1024 * 1024; // 1GB
export const DEFAULT_MESSAGE_FETCH_LIMIT = 50;
export const MAX_MESSAGE_FETCH_LIMIT = 100;
export const MESSAGES_PER_PAGE = 50;
// Minimum lead time for a scheduled message's send_at, matching the server
// contract (update/create require send_at >= now + 5s). Used for both the
// datetime-local `min` constraint and client-side validation.
export const SCHEDULED_MESSAGE_MIN_LEAD_MS = 5000;
export const TYPING_TIMEOUT = 10000; // 10 seconds
export const HEARTBEAT_INTERVAL = 41250; // default, overridden by server
