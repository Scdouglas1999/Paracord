/**
 * Custom axios adapter that routes HTTP requests through the Tauri `native_fetch`
 * command (Rust reqwest) instead of WebView2's fetch/XHR. This bypasses WebView2's
 * TLS restrictions so self-hosted servers with self-signed certs work.
 */
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { isTauri } from './tauriEnv';

interface NativeFetchResponse {
  status: number;
  body: unknown;
}

let invokeCache: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (invokeCache) return invokeCache;
  const { invoke } = await import('@tauri-apps/api/core');
  invokeCache = invoke;
  return invoke;
}

/**
 * Axios adapter that uses Tauri's native_fetch command.
 * Falls back to default adapter if not in Tauri or if the command fails.
 */
export async function tauriAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const invoke = await getInvoke();

  const baseURL = config.baseURL ?? '';
  const url = config.url?.startsWith('http')
    ? config.url
    : `${baseURL.replace(/\/+$/, '')}/${(config.url ?? '').replace(/^\/+/, '')}`;

  const headers: Record<string, string> = {};
  if (config.headers) {
    for (const [key, value] of Object.entries(config.headers)) {
      if (value != null && typeof value !== 'boolean') {
        headers[key] = String(value);
      }
    }
  }

  let body: unknown = undefined;
  if (config.data !== undefined && config.data !== null) {
    if (typeof config.data === 'string') {
      try {
        body = JSON.parse(config.data);
      } catch {
        body = config.data;
      }
    } else {
      body = config.data;
    }
  }

  const resp = (await invoke('native_fetch', {
    req: {
      url,
      method: (config.method ?? 'GET').toUpperCase(),
      body: body ?? null,
      headers: Object.keys(headers).length > 0 ? headers : null,
    },
  })) as NativeFetchResponse;

  const response: AxiosResponse = {
    data: resp.body,
    status: resp.status,
    statusText: '',
    headers: {},
    config,
  };

  // Mimic axios behavior: reject on non-2xx unless validateStatus says otherwise
  const validateStatus = config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  if (!validateStatus(resp.status)) {
    const error = new Error(`Request failed with status code ${resp.status}`) as Error & {
      config: InternalAxiosRequestConfig;
      response: AxiosResponse;
      isAxiosError: boolean;
    };
    error.config = config;
    error.response = response;
    error.isAxiosError = true;
    throw error;
  }

  return response;
}

/** Returns the Tauri adapter if running in Tauri, undefined otherwise. */
export function getTauriAdapter(): typeof tauriAdapter | undefined {
  return isTauri() ? tauriAdapter : undefined;
}
