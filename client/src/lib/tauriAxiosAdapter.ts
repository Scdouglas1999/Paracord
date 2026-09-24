/**
 * Custom axios adapter that routes HTTP requests through the Tauri native HTTP
 * commands (Rust reqwest) instead of WebView2's fetch/XHR. This bypasses
 * WebView2's TLS restrictions so self-hosted servers with self-signed certs
 * work.
 *
 * Everything this file does is *parity work*. The desktop shell is the only
 * place this adapter runs, headless-Chromium E2E never touches it, and every
 * gap between what axios promises a caller and what this hands back has shipped
 * as a release blocker: response headers dropped (errors on every screen),
 * `config.params` dropped (no room could load), `FormData` serialized to `{}`
 * (no upload worked). The rule here is: whatever the browser adapter does with
 * a given `config`, this must do. `tauriAxiosAdapter.test.ts` holds that line.
 */
import axios, { AxiosError, AxiosHeaders } from 'axios';
import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { isTauri } from './tauriEnv';

interface NativeFetchResponse {
  status: number;
  body: unknown;
  /** Lowercased response headers. Absent from shells older than this field. */
  headers?: Record<string, string>;
  /** Base64 body, present only when the request asked for a binary response. */
  body_base64?: string;
}

interface NativeMultipartPart {
  name: string;
  value?: string;
  filename?: string;
  content_type?: string;
  data_base64?: string;
}

let invokeCache: ((cmd: string, args: Record<string, unknown>) => Promise<unknown>) | null = null;

async function getInvoke() {
  if (invokeCache) return invokeCache;
  const { invoke } = await import('@tauri-apps/api/core');
  invokeCache = invoke;
  return invoke;
}

/** Chunked so `String.fromCharCode` stays under its argument limit. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function isFormDataBody(data: unknown): data is FormData {
  return typeof FormData !== 'undefined' && data instanceof FormData;
}

function isBinaryBody(data: unknown): data is Blob | ArrayBuffer | ArrayBufferView {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return true;
  return data instanceof ArrayBuffer || ArrayBuffer.isView(data);
}

async function binaryBodyToBase64(data: Blob | ArrayBuffer | ArrayBufferView): Promise<string> {
  if (data instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) {
    return bytesToBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  return bytesToBase64(new Uint8Array(await data.arrayBuffer()));
}

/**
 * Flatten a `FormData` into parts the Rust side can rebuild.
 *
 * This is the whole of bug #5: a `FormData` has no enumerable own properties,
 * so handing one to `invoke()` serializes it as `{}` — the server saw an empty
 * JSON object and answered 400 "Missing …". Encrypted DM attachments, custom
 * emoji, stickers and avatars were all dead on the desktop for that reason,
 * and all of them pass in a browser, where axios hands the FormData to XHR and
 * the platform builds the body.
 */
async function formDataToParts(form: FormData): Promise<NativeMultipartPart[]> {
  const parts: NativeMultipartPart[] = [];
  for (const [name, value] of form.entries()) {
    if (typeof value === 'string') {
      parts.push({ name, value });
      continue;
    }
    const file = value as File;
    parts.push({
      name,
      // A browser names an unnamed Blob part "blob"; keep that, because the
      // attachment routes store the filename they are given.
      filename: file.name || 'blob',
      content_type: file.type || 'application/octet-stream',
      data_base64: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
    });
  }
  return parts;
}

function headersFromConfig(config: InternalAxiosRequestConfig): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!config.headers) return headers;
  for (const [key, value] of Object.entries(config.headers)) {
    if (value != null && typeof value !== 'boolean') headers[key] = String(value);
  }
  return headers;
}

/** The reason phrase browsers report for the statuses this API answers with. */
const STATUS_TEXT: Record<number, string> = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found',
  405: 'Method Not Allowed', 409: 'Conflict', 410: 'Gone', 413: 'Payload Too Large',
  415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/**
 * Decode the native body into what `response.data` holds in a browser for the
 * declared `responseType`.
 */
function decodeBody(resp: NativeFetchResponse, config: InternalAxiosRequestConfig): unknown {
  const responseType = config.responseType;
  if (responseType === 'blob' || responseType === 'arraybuffer') {
    const bytes = base64ToBytes(resp.body_base64 ?? '');
    const contentType = resp.headers?.['content-type'] ?? 'application/octet-stream';
    if (responseType === 'arraybuffer') return bytes.buffer;
    return new Blob([bytes], { type: contentType });
  }
  if (responseType === 'text') {
    // Rust already parsed a JSON body; re-serialize so a text caller sees text.
    return typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body ?? '');
  }
  return resp.body;
}

/**
 * The `AxiosError` a caller is entitled to.
 *
 * A bare `Error` used to come out of here for transport failures, so
 * `axios.isAxiosError(error)` was false and every `error.response?.status`
 * check read `undefined` — a refused connection and a 403 were indistinguishable
 * to the callers that branch on them.
 */
function axiosError(
  message: string,
  code: string,
  config: InternalAxiosRequestConfig,
  response?: AxiosResponse,
): AxiosError {
  return new AxiosError(message, code, config, null, response);
}

export async function tauriAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const invoke = await getInvoke();

  const signal = config.signal as AbortSignal | undefined;
  // A request the caller has already given up on must not be sent at all — an
  // account-session lease aborts its signal when the unlocked account changes,
  // and the browser adapter rejects here rather than issuing the call.
  if (signal?.aborted) {
    throw axiosError('canceled', AxiosError.ERR_CANCELED, config);
  }

  const baseURL = config.baseURL ?? '';
  const path = config.url?.startsWith('http')
    ? config.url
    : `${baseURL.replace(/\/+$/, '')}/${(config.url ?? '').replace(/^\/+/, '')}`;
  // `params` are part of the request, not decoration. This adapter built the
  // URL from baseURL + url alone and dropped the query string, so on the
  // desktop every parameterised call arrived bare: message history lost
  // `limit`/`before`, and `GET /channels/{id}/messages/recovery` arrived with
  // no `after` at all — a 400 that left the account stuck at "wait for this
  // account's authenticated message recovery" and made the channel unusable.
  // Serialize through axios itself so arrays, a custom `paramsSerializer` and
  // an existing query string in `url` behave exactly as they do in the browser.
  const url = axios.getUri({ ...config, url: path, baseURL: undefined });

  const headers = headersFromConfig(config);
  const method = (config.method ?? 'GET').toUpperCase();
  // `timeout: 0` is axios' "no deadline"; anything else is the caller's.
  const timeoutMs = typeof config.timeout === 'number' ? config.timeout : undefined;
  const responseType = config.responseType;
  const wantsBinary = responseType === 'blob' || responseType === 'arraybuffer';

  let command = 'native_fetch';
  let req: Record<string, unknown>;

  if (isFormDataBody(config.data)) {
    // reqwest generates the boundary, so the caller's boundary-less
    // `multipart/form-data` header must not travel; the Rust side drops it.
    req = {
      url,
      method,
      parts: await formDataToParts(config.data),
      headers: Object.keys(headers).length > 0 ? headers : null,
      timeout_ms: timeoutMs ?? null,
    };
    command = 'native_multipart';
  } else {
    let body: unknown = null;
    let bodyBase64: string | null = null;
    const data = config.data;
    if (data !== undefined && data !== null) {
      if (isBinaryBody(data)) {
        bodyBase64 = await binaryBodyToBase64(data);
      } else if (typeof data === 'string') {
        const declared = headers['Content-Type'] ?? headers['content-type'] ?? '';
        if (/json/i.test(declared)) {
          // axios has already stringified a JSON body; hand Rust the value so
          // it is re-serialized once, not double-encoded.
          try {
            body = JSON.parse(data);
          } catch {
            bodyBase64 = bytesToBase64(new TextEncoder().encode(data));
          }
        } else {
          // A form-encoded or plain-text body must go on the wire verbatim.
          // Wrapping it in a JSON string put quotes around it and relabeled it
          // `application/json`.
          bodyBase64 = bytesToBase64(new TextEncoder().encode(data));
        }
      } else {
        body = data;
      }
    }
    req = {
      url,
      method,
      body,
      body_base64: bodyBase64,
      headers: Object.keys(headers).length > 0 ? headers : null,
      timeout_ms: timeoutMs ?? null,
      response_type: wantsBinary ? 'binary' : null,
    };
  }

  let resp: NativeFetchResponse;
  try {
    // `invoke` has no cancellation, so an abort cannot stop the request in
    // flight — but it must still reject the caller's promise the moment the
    // signal fires, which is the contract the browser adapter honors and
    // every `assertCurrent()`/lease teardown in this app depends on.
    resp = (await raceAbort(
      invoke(command, { req }) as Promise<NativeFetchResponse>,
      signal,
      config,
    )) as NativeFetchResponse;
  } catch (error) {
    if (error instanceof AxiosError) throw error;
    const message = typeof error === 'string' ? error : (error as Error)?.message ?? 'Network Error';
    // The Rust side reports a deadline as "Connection timed out."; axios
    // callers branch on ECONNABORTED for that and ERR_NETWORK for the rest.
    const code = /timed out/i.test(message) ? AxiosError.ECONNABORTED : AxiosError.ERR_NETWORK;
    throw axiosError(message, code, config);
  }

  // Response headers are part of the API contract, not decoration: the
  // operation context reads `X-Paracord-History-Epoch` off every response and
  // treats a mismatch as the account's database history having changed. An
  // empty header bag is a mismatch, so reporting `{}` here — which this adapter
  // did — made every desktop request look like a history change, expiring the
  // operation and tearing down the realtime stream behind it.
  const response: AxiosResponse = {
    data: decodeBody(resp, config),
    status: resp.status,
    statusText: STATUS_TEXT[resp.status] ?? '',
    headers: AxiosHeaders.from(resp.headers ?? {}),
    config,
    request: undefined,
  };

  const validateStatus = config.validateStatus ?? ((s: number) => s >= 200 && s < 300);
  if (!validateStatus(resp.status)) {
    throw axiosError(
      `Request failed with status code ${resp.status}`,
      resp.status >= 500 ? AxiosError.ERR_BAD_RESPONSE : AxiosError.ERR_BAD_REQUEST,
      config,
      response,
    );
  }

  return response;
}

/** Reject as soon as `signal` aborts, however long the native call runs. */
function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
  config: InternalAxiosRequestConfig,
): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(axiosError('canceled', AxiosError.ERR_CANCELED, config));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Returns the Tauri adapter if running in Tauri, undefined otherwise. */
export function getTauriAdapter(): typeof tauriAdapter | undefined {
  return isTauri() ? tauriAdapter : undefined;
}
