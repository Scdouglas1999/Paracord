import { ParacordApiError } from './errors.js';
import type {
  ApiCommand,
  ApiErrorPayload,
  InteractionCallbackData,
  InteractionResponse,
  RestClientOptions,
  SlashCommand,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(response: Response, body: unknown): number {
  const retryAfterHeader = response.headers.get('retry-after');
  if (retryAfterHeader) {
    const parsedSeconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(parsedSeconds) && parsedSeconds > 0) {
      return Math.ceil(parsedSeconds * 1000);
    }
  }
  if (body && typeof body === 'object' && 'retry_after' in body) {
    const parsed = Number((body as { retry_after?: unknown }).retry_after);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.ceil(parsed * 1000);
    }
  }
  return 1_000;
}

function bucketKey(method: string, path: string): string {
  return `${method.toUpperCase()}:${path}`;
}

export class ParacordRestClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly userAgent: string;
  private readonly maxRateLimitRetries: number;
  private readonly bucketLocks = new Map<string, number>();
  private readonly bucketChains = new Map<string, Promise<void>>();

  constructor(options: RestClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.userAgent = options.userAgent ?? '@paracord/bot-sdk';
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? 3;
  }

  async request<TResponse>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<TResponse> {
    const key = bucketKey(method, path);
    const previous = this.bucketChains.get(key) ?? Promise.resolve();
    let releaseChain!: () => void;
    const next = new Promise<void>((resolve) => {
      releaseChain = resolve;
    });
    this.bucketChains.set(key, previous.then(() => next));

    await previous;

    try {
      const lockedUntil = this.bucketLocks.get(key) ?? 0;
      const waitMs = lockedUntil - Date.now();
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      for (let attempt = 0; attempt <= this.maxRateLimitRetries; attempt += 1) {
        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bot ${this.token}`,
            'Content-Type': 'application/json',
            'User-Agent': this.userAgent,
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });

        const hasJsonBody = (response.headers.get('content-type') || '').includes('application/json');
        const responseBody = hasJsonBody ? await response.json() : null;

        if (response.status === 429) {
          if (attempt === this.maxRateLimitRetries) {
            throw new ParacordApiError(429, responseBody as ApiErrorPayload | null);
          }
          const retryAfterMs = parseRetryAfterMs(response, responseBody);
          this.bucketLocks.set(key, Date.now() + retryAfterMs);
          await sleep(retryAfterMs);
          continue;
        }

        const remaining = Number(response.headers.get('x-ratelimit-remaining'));
        const resetAfter = Number(response.headers.get('x-ratelimit-reset-after'));
        if (Number.isFinite(remaining) && remaining <= 0 && Number.isFinite(resetAfter) && resetAfter > 0) {
          this.bucketLocks.set(key, Date.now() + Math.ceil(resetAfter * 1000));
        }

        if (!response.ok) {
          throw new ParacordApiError(response.status, responseBody as ApiErrorPayload | null);
        }

        return (responseBody ?? (null as unknown)) as TResponse;
      }

      throw new ParacordApiError(429, { message: 'Rate limit retries exhausted' });
    } finally {
      releaseChain();
      if (this.bucketChains.get(key) === next) {
        this.bucketChains.delete(key);
      }
    }
  }

  listGlobalCommands(applicationId: string): Promise<ApiCommand[]> {
    return this.request<ApiCommand[]>('GET', `/applications/${applicationId}/commands`);
  }

  bulkOverwriteGlobalCommands(applicationId: string, commands: SlashCommand[]): Promise<ApiCommand[]> {
    return this.request<ApiCommand[]>('PUT', `/applications/${applicationId}/commands`, commands);
  }

  listGuildCommands(applicationId: string, guildId: string): Promise<ApiCommand[]> {
    return this.request<ApiCommand[]>(
      'GET',
      `/applications/${applicationId}/guilds/${guildId}/commands`,
    );
  }

  bulkOverwriteGuildCommands(
    applicationId: string,
    guildId: string,
    commands: SlashCommand[],
  ): Promise<ApiCommand[]> {
    return this.request<ApiCommand[]>(
      'PUT',
      `/applications/${applicationId}/guilds/${guildId}/commands`,
      commands,
    );
  }

  respondToInteraction(
    interactionId: string,
    token: string,
    response: InteractionResponse,
  ): Promise<void> {
    return this.request<void>(
      'POST',
      `/interactions/${interactionId}/${token}/callback`,
      response,
    );
  }

  editOriginalInteractionResponse(
    applicationId: string,
    token: string,
    data: InteractionCallbackData,
  ): Promise<void> {
    return this.request<void>(
      'PATCH',
      `/interactions/${applicationId}/${token}/messages/@original`,
      data,
    );
  }

  deleteOriginalInteractionResponse(applicationId: string, token: string): Promise<void> {
    return this.request<void>(
      'DELETE',
      `/interactions/${applicationId}/${token}/messages/@original`,
    );
  }

  createFollowupMessage(
    applicationId: string,
    token: string,
    data: InteractionCallbackData,
  ): Promise<void> {
    return this.request<void>(
      'POST',
      `/interactions/${applicationId}/${token}/followup`,
      data,
    );
  }
}
