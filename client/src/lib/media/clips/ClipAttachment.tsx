import { useEffect, useState } from 'react';
import { fileApi } from '../../../api/files';
import { MediaPreview } from '../../../components/file/MediaPreview';
import { safeClientResourceUrl } from '../../security';
import { parseClipFilename } from './clipFilename';
import './clips.css';

/**
 * A clip attachment in a message row (docs/glass-spec.md §6.4): fetches the
 * attachment the way every attachment is fetched (an authenticated object
 * URL) and shows it as a clip bubble. An end-to-end encrypted clip does not
 * come through here: `EncryptedAttachment` decrypts it and hands it to the
 * same `MediaPreview`.
 *
 * For the timeline (`MessageList`): render this instead of the file row when
 * `isClipAttachment(att.filename)`.
 */
export function isClipAttachment(filename: string): boolean {
  return parseClipFilename(filename) !== null;
}

export function ClipAttachment({ url, filename }: { url: string; filename: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const label = parseClipFilename(filename)?.label ?? filename;
  const safe = safeClientResourceUrl(url);

  useEffect(() => {
    if (!safe) return;
    let canceled = false;
    let objectUrl: string | null = null;
    fileApi.resolveAttachmentObjectUrl(safe).then(
      (resolved) => {
        if (resolved.startsWith('blob:')) objectUrl = resolved;
        if (canceled) {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
          return;
        }
        setSrc(resolved);
      },
      (failure: unknown) => {
        if (!canceled) setError(failure instanceof Error ? failure.message : 'The clip could not be opened.');
      },
    );
    return () => {
      canceled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [safe]);

  if (!safe || error) {
    return (
      <p role="alert" className="glass-clip-toast__error">
        {label}: {error ?? 'The clip link was blocked.'}
      </p>
    );
  }
  if (!src) {
    return (
      <div className="glass-clip" aria-busy="true" aria-label={`Loading clip, ${label}`}>
        <span className="glass-clip__label">{label}</span>
      </div>
    );
  }
  return <MediaPreview key={src} src={src} filename={filename} kind="video" />;
}
