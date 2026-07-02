import { useState, useCallback } from 'react';
import { fileApi } from '../api/files';
import type { Attachment } from '../types';
import { MAX_FILE_SIZE } from '../lib/constants';

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

  const upload = useCallback(
    async (file: File): Promise<Attachment | null> => {
      if (!channelId) return null;
      if (file.size > MAX_FILE_SIZE) {
        setState({ uploading: false, progress: 0, error: 'File too large' });
        return null;
      }

      setState({ uploading: true, progress: 0, error: null });
      try {
        const result = await fileApi.upload(channelId, file, (percent) => {
          setState((s) => ({ ...s, progress: percent }));
        });
        setState({ uploading: false, progress: 100, error: null });
        return result;
      } catch {
        setState({ uploading: false, progress: 0, error: 'Upload failed' });
        return null;
      }
    },
    [channelId]
  );

  const clearError = useCallback(() => {
    setState((s) => ({ ...s, error: null }));
  }, []);

  return { ...state, upload, clearError };
}
