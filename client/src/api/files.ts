import { getApi } from './activeClient';
import { getAccessToken, getCsrfToken } from '../lib/authToken';
import type { Attachment } from '../types';
import {
  QUICFileUploader,
  type UploadTokenResponse,
  type ProgressCallback,
} from '../lib/media/transport/fileTransfer';
import {
  FileTransportManager,
  hasQuicTransport,
} from '../lib/media/transport/fileTransportManager';
import { isTauri } from '../lib/tauriEnv';
import { resolveApiOrigin, resolveResourceUrl } from '../lib/config/apiBaseUrl';
import { ensureDownloadTicket, getDownloadTicket } from '../lib/downloadTicket';
import { useServerListStore } from '../stores/serverListStore';

/**
 * Encode raw bytes as a base64 string. Chunked to stay well under the argument
 * limit of `String.fromCharCode` for large files. Used to pass upload payloads
 * across the Tauri IPC as a string, since nested typed arrays do not survive
 * the JSON IPC boundary intact.
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

/**
 * Build an absolute `/api/v2` URL whose origin matches the axios instance that
 * `getApi()` resolves to (the active server's per-server client under
 * multi-server, or the LOCAL fallback singleton during bootstrap). Deriving the
 * origin from the active client — rather than the globally stored server —
 * ensures uploads/attachments target the same origin as the REST request that
 * authorized them. Falls back to the current window origin when the active
 * client's baseURL is relative (e.g. the Vite dev proxy).
 *
 * The URL is only half of the pairing: whatever addresses this origin must also
 * carry that origin's own credential — see {@link resolveTokenForOrigin}.
 */
export function resolveActiveApiOrigin(): string {
  const base = getApi().defaults.baseURL ?? '';
  let origin = '';
  if (base.startsWith('http')) {
    try {
      origin = new URL(base).origin;
    } catch {
      origin = '';
    }
  }
  if (!origin) {
    origin = typeof window !== 'undefined' ? window.location.origin : '';
  }
  return origin;
}

function resolveActiveV1ApiUrl(path: string): string {
  return `${resolveActiveApiOrigin()}/api/v1${path}`;
}

function resolveActiveV2ApiUrl(path: string): string {
  return `${resolveActiveApiOrigin()}/api/v2${path}`;
}

interface NativeFetchResponse {
  status: number;
  body: unknown;
}

interface NativeDownloadFileResponse {
  status: number;
  content_type: string | null;
  data_base64: string;
}

/** Decode a base64 string into raw bytes (fast native `atob` + single copy). */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const len = binary.length;
  const buffer = new ArrayBuffer(len);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** http(s) origin of `url`, or null when it has neither. */
function httpOriginOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : null;
  } catch {
    return null;
  }
}

/**
 * The bearer token this client holds *for* `targetOrigin`, or null when it
 * holds none.
 *
 * A credential may only ever be presented to the server that issued it.
 * `getAccessToken()` returns the process-global token, which belongs to the
 * home/LOCAL server alone (see the invariant documented in ./client.ts), while
 * the URLs on these paths come from the ACTIVE server — and, for attachments
 * and avatars, are ultimately chosen by whoever authored the message. Pairing
 * the two handed the home token to any origin a hostile server cared to name.
 */
function resolveTokenForOrigin(targetOrigin: string): string | null {
  for (const server of useServerListStore.getState().servers) {
    if (server.token && httpOriginOf(server.url) === targetOrigin) {
      return server.token;
    }
  }
  if (resolveApiOrigin() === targetOrigin) {
    return getAccessToken();
  }
  return null;
}

/**
 * Auth headers for a request to `targetUrl`.
 *
 * Authorization is resolved from the target's own origin, so an origin we hold
 * no credential for gets an unauthenticated request rather than someone else's
 * token. The CSRF double-submit value only means anything alongside the session
 * it protects, so it travels with that credential and never on its own.
 */
function authHeaders(targetUrl: string): Record<string, string> {
  const headers: Record<string, string> = {};
  const origin = httpOriginOf(targetUrl);
  const token = origin ? resolveTokenForOrigin(origin) : null;
  if (token && token !== 'null' && token !== 'undefined') {
    headers.Authorization = `Bearer ${token}`;
    const csrf = getCsrfToken();
    if (csrf) {
      headers['X-Paracord-CSRF'] = csrf;
    }
  }
  return headers;
}

function attachmentIdFromUrl(url: string): string | null {
  const match = url.match(/\/attachments\/([^/?#]+)/);
  return match?.[1] ?? null;
}

function toAbsoluteAttachmentUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  const origin = resolveActiveApiOrigin();
  return url.startsWith('/') ? `${origin}${url}` : `${origin}/${url}`;
}

/**
 * Request an upload token from the server (always over HTTP).
 * This validates permissions and returns a JWT for the QUIC transfer.
 */
async function getUploadToken(
  channelId: string,
  file: File,
): Promise<UploadTokenResponse> {
  const resp = await getApi().post<UploadTokenResponse>(
    resolveActiveV2ApiUrl(`/channels/${channelId}/upload-token`),
    {
      filename: file.name,
      size: file.size,
      content_type: file.type || 'application/octet-stream',
    },
  );
  return resp.data;
}

/**
 * Upload a file over QUIC WebTransport.
 */
async function quicUpload(
  token: UploadTokenResponse,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Attachment> {
  const manager = FileTransportManager.getInstance();
  const transport = await manager.getOrConnect(
    token.quic_endpoint,
    token.upload_token,
    token.cert_hash,
  );

  const uploader = new QUICFileUploader();
  const progressCb: ProgressCallback | undefined = onProgress
    ? (bytes, total) => onProgress(Math.round((bytes * 100) / total))
    : undefined;

  const result = await uploader.upload(transport, token, file, progressCb);

  return {
    id: result.id,
    filename: result.filename,
    size: result.size,
    content_type: result.content_type,
    url: result.url,
  } as Attachment;
}

/**
 * Upload a file via the Tauri native multipart command (bypasses axios/FormData IPC).
 */
async function tauriUpload(
  channelId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Attachment> {
  const { invoke } = await import('@tauri-apps/api/core');
  const url = resolveActiveV1ApiUrl(`/channels/${channelId}/attachments`);

  const headers = authHeaders(url);

  onProgress?.(0);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dataBase64 = bytesToBase64(bytes);
  onProgress?.(50);

  const resp = (await invoke('native_upload_file', {
    req: {
      url,
      filename: file.name,
      content_type: file.type || 'application/octet-stream',
      data_base64: dataBase64,
      headers: Object.keys(headers).length > 0 ? headers : null,
    },
  })) as NativeFetchResponse;

  onProgress?.(100);

  if (resp.status < 200 || resp.status >= 300) {
    const body = resp.body as { error?: string } | null;
    const message =
      body && typeof body === 'object' && typeof body.error === 'string'
        ? body.error
        : `Request failed with status code ${resp.status}`;
    throw new Error(message);
  }

  const attachment = resp.body as Attachment;
  return {
    id: attachment.id,
    filename: attachment.filename,
    size: attachment.size,
    content_type: attachment.content_type,
    url: attachment.url,
  };
}

async function tauriDownload(
  id: string,
  onProgress?: (percent: number) => void,
): Promise<{ data: Blob }> {
  const { invoke } = await import('@tauri-apps/api/core');
  const url = resolveActiveV1ApiUrl(`/attachments/${id}`);

  onProgress?.(0);
  const resp = (await invoke('native_download_file', {
    req: {
      url,
      headers: (() => {
        const headers = authHeaders(url);
        return Object.keys(headers).length > 0 ? headers : null;
      })(),
    },
  })) as NativeDownloadFileResponse;

  onProgress?.(100);

  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(`Request failed with status code ${resp.status}`);
  }

  const bytes = base64ToBytes(resp.data_base64);
  const contentType = resp.content_type || 'application/octet-stream';
  return { data: new Blob([bytes], { type: contentType }) };
}

/**
 * Upload a file over HTTP multipart (existing fallback path).
 */
async function httpUpload(
  channelId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Attachment> {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await getApi().post<Attachment>(
    `/channels/${channelId}/attachments`,
    formData,
    {
      headers: { 'Content-Type': 'multipart/form-data' },
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      },
    },
  );
  return resp.data;
}

export const fileApi = {
  /**
   * Upload a file to a channel. Uses QUIC when available, falls back to HTTP.
   */
  upload: async (
    channelId: string,
    file: File,
    onProgress?: (percent: number) => void,
  ): Promise<Attachment> => {
    // Try QUIC-first path
    if (hasQuicTransport() && !isTauri()) {
      try {
        const token = await getUploadToken(channelId, file);
        if (token.quic_available) {
          try {
            return await quicUpload(token, file, onProgress);
          } catch (quicErr) {
            console.warn('QUIC upload failed, falling back to HTTP:', quicErr);
          }
        }
      } catch {
        // upload-token endpoint not available (older server), fall through to HTTP
      }
    }

    if (isTauri()) {
      return tauriUpload(channelId, file, onProgress);
    }

    return httpUpload(channelId, file, onProgress);
  },

  /**
   * Download an attachment. Uses QUIC when available, falls back to HTTP.
   */
  download: async (
    id: string,
    onProgress?: (percent: number) => void,
  ): Promise<{ data: Blob }> => {
    if (isTauri()) {
      return tauriDownload(id, onProgress);
    }
    return getApi().get(`/attachments/${id}`, {
      responseType: 'blob',
      onDownloadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      },
    });
  },

  /**
   * Resolve an attachment URL into a value suitable for `<img src>`, `<video src>`,
   * or download links. Always returns an authenticated blob object URL so
   * cross-origin / cookie-less browser loads work (tickets or Authorization).
   */
  resolveAttachmentObjectUrl: async (url: string): Promise<string> => {
    if (isTauri()) {
      const id = attachmentIdFromUrl(url);
      if (id) {
        const { data } = await tauriDownload(id);
        return URL.createObjectURL(data);
      }
      const { invoke } = await import('@tauri-apps/api/core');
      const absoluteUrl = toAbsoluteAttachmentUrl(url);
      const headers = authHeaders(absoluteUrl);
      const resp = (await invoke('native_download_file', {
        req: {
          url: absoluteUrl,
          headers: Object.keys(headers).length > 0 ? headers : null,
        },
      })) as NativeDownloadFileResponse;
      if (resp.status < 200 || resp.status >= 300) {
        throw new Error(`Request failed with status code ${resp.status}`);
      }
      const bytes = base64ToBytes(resp.data_base64);
      const contentType = resp.content_type || 'application/octet-stream';
      return URL.createObjectURL(new Blob([bytes], { type: contentType }));
    }

    // Browser: prefer authenticated axios blob fetch (cookies / Bearer).
    const id = attachmentIdFromUrl(url);
    if (id) {
      try {
        const { data } = await getApi().get(`/attachments/${id}`, {
          responseType: 'blob',
        });
        return URL.createObjectURL(data);
      } catch {
        // Fall through to ticketed absolute URL fetch (cross-origin img path).
      }
    }

    await ensureDownloadTicket();
    const ticketed = resolveResourceUrl(toAbsoluteAttachmentUrl(url), getDownloadTicket());
    const resp = await fetch(ticketed, {
      credentials: 'include',
      headers: authHeaders(ticketed),
    });
    if (!resp.ok) {
      throw new Error(`Request failed with status code ${resp.status}`);
    }
    const blob = await resp.blob();
    return URL.createObjectURL(blob);
  },

  /** Delete an attachment. */
  delete: (id: string) => getApi().delete(`/attachments/${id}`),
};
