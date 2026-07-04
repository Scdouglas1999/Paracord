import { useState, useCallback, useEffect } from 'react';
import { fileApi } from '../api/files';
import type { Attachment } from '../types';
import { MAX_FILE_SIZE } from '../lib/constants';
import { formatFileSize } from '../lib/formatters';
import { useInstanceStore } from '../stores/instanceStore';

interface UploadState {
  uploading: boolean;
  progress: number;
  error: string | null;
}

export function useFileUpload(channelId: string | null) {
  const [state, setState] = useState<UploadState>({
    uploading: false,
    progress: 0,
    error: null,
  });

  // The admin-configured, server-advertised limit (per active server). Falls
  // back to the client-side ceiling until the instance info loads; the server
  // is always the authoritative enforcer regardless.
  const serverMaxUploadSize = useInstanceStore((s) => s.getActiveMaxUploadSize());
  const fetchInstanceInfo = useInstanceStore((s) => s.fetchInstanceInfo);
  const maxUploadSize = serverMaxUploadSize ?? MAX_FILE_SIZE;

  useEffect(() => {
    void fetchInstanceInfo();
  }, [fetchInstanceInfo, channelId]);

  const upload = useCallback(
    async (file: File): Promise<Attachment> => {
      if (!channelId) {
        throw new Error('No channel selected');
      }
      // Client-side pre-check against the effective limit for fast feedback.
      // The server re-validates on upload, so this is UX-only, never trusted.
      const effectiveMax = useInstanceStore.getState().getActiveMaxUploadSize() ?? MAX_FILE_SIZE;
      if (file.size > effectiveMax) {
        const message = `File is too large. Maximum is ${formatFileSize(effectiveMax)}.`;
        setState({ uploading: false, progress: 0, error: message });
        throw new Error(message);
      }

      setState({ uploading: true, progress: 0, error: null });
      try {
        const result = await fileApi.upload(channelId, file, (percent) => {
          setState((s) => ({ ...s, progress: percent }));
        });
        setState({ uploading: false, progress: 100, error: null });
        return result;
      } catch (err) {
        // Surface the real reason (e.g. the server's rejection message) instead
        // of swallowing it — the caller shows it and the send is aborted rather
        // than silently sending a message without the attachment.
        const message = err instanceof Error ? err.message : 'Upload failed';
        setState({ uploading: false, progress: 0, error: message });
        throw err instanceof Error ? err : new Error(message);
      }
    },
    [channelId]
  );

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return { ...state, upload, clearError, maxUploadSize };
}
