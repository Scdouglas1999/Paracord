export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface ApiErrorPayload {
  error?: string;
  message?: string;
  code?: string;
}

export interface SlashCommandOption {
  type: number;
  name: string;
  description: string;
  required?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  options?: SlashCommandOption[];
  type?: number;
  default_member_permissions?: string;
  dm_permission?: boolean;
  nsfw?: boolean;
}

export interface ApiCommand extends SlashCommand {
  id: string;
  application_id: string;
}

export interface InteractionOption {
  name: string;
  type: number;
  value?: JsonValue;
}

export interface InteractionData {
  id?: string;
  name?: string;
  options?: InteractionOption[];
}

export interface InteractionPayload {
  id: string;
  application_id?: string;
  type: number;
  token: string;
  guild_id?: string | null;
  channel_id?: string | null;
  user?: { id: string; username: string };
  member?: { user?: { id: string; username: string } };
  data?: InteractionData;
}

export interface InteractionCallbackData {
  content?: string;
  embeds?: Array<Record<string, JsonValue>>;
  flags?: number;
}

export interface InteractionResponse {
  type: number;
  data?: InteractionCallbackData;
}

export interface GatewayPayload {
  op: number;
  d?: unknown;
  s?: number | null;
  t?: string;
}

export interface GatewayHelloData {
  heartbeat_interval: number;
}

export interface GatewayReadyData {
  session_id?: string;
  user?: { id: string; username: string };
}

export interface GatewayClientOptions {
  url: string;
  token: string;
  intents?: number;
  wsFactory?: (url: string) => GatewayWebSocketLike;
}

export interface GatewayWebSocketLike {
  readyState: number;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RestClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
  maxRateLimitRetries?: number;
}

export interface BotClientOptions {
  token: string;
  applicationId: string;
  restBaseUrl: string;
  gatewayUrl: string;
  intents?: number;
  fetchImpl?: typeof fetch;
  wsFactory?: (url: string) => GatewayWebSocketLike;
}
