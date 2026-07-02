import { apiClient } from './client';
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
import { resolveV2ApiUrl } from '../lib/apiBaseUrl';

/** Check if we're running in Tauri (native desktop). */
function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI__' in window;
}

/**
 * Request an upload token from the server (always over HTTP).
 * This validates permissions and returns a JWT for the QUIC transfer.
 */
async function getUploadToken(
  channelId: string,
  file: File,
): Promise<UploadTokenResponse> {
  const resp = await apiClient.post<UploadTokenResponse>(
    resolveV2ApiUrl(`/channels/${channelId}/upload-token`),
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
 * Upload a file over HTTP multipart (existing fallback path).
 */
async function httpUpload(
  channelId: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<Attachment> {
  const formData = new FormData();
  formData.append('file', file);
  const resp = await apiClient.post<Attachment>(
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

    // HTTP fallback (original path)
    return httpUpload(channelId, file, onProgress);
  },

  /**
   * Download an attachment. Uses QUIC when available, falls back to HTTP.
   */
  download: async (
    id: string,
    onProgress?: (percent: number) => void,
  ): Promise<{ data: Blob }> => {
    return apiClient.get(`/attachments/${id}`, {
      responseType: 'blob',
      onDownloadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded * 100) / e.total));
        }
      },
    });
  },

  /** Delete an attachment. */
  delete: (id: string) => apiClient.delete(`/attachments/${id}`),
};
