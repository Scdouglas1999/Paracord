import { useEffect, useId, useRef, useState } from 'react';

interface MediaPreviewProps {
  src: string;
  filename: string;
  kind: 'audio' | 'video';
}

/** User-supplied media can be paired with a local caption file without uploading it. */
export function MediaPreview({ src, filename, kind }: MediaPreviewProps) {
  const inputId = useId();
  const selection = useRef(0);
  const audioCaptionTrack = useRef<HTMLTrackElement>(null);
  const [captions, setCaptions] = useState<{ url: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cueText, setCueText] = useState('');

  useEffect(() => () => { selection.current += 1; }, []);
  useEffect(() => () => {
    if (captions) URL.revokeObjectURL(captions.url);
  }, [captions]);
  useEffect(() => {
    const element = audioCaptionTrack.current;
    if (kind !== 'audio' || !element) return;
    const updateCues = () => {
      const cues = element.track.activeCues;
      setCueText(cues ? Array.from(cues).map((cue) => (cue as VTTCue).text).join('\n') : '');
    };
    element.track.mode = 'hidden';
    element.track.addEventListener('cuechange', updateCues);
    return () => element.track.removeEventListener('cuechange', updateCues);
  }, [captions, kind]);

  const loadCaptions = async (file: File | undefined) => {
    if (!file) return;
    const request = ++selection.current;
    setError(null);
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Caption files must be smaller than 5 MB.');
      const text = await file.text();
      if (request !== selection.current) return;
      if (!/^\uFEFF?WEBVTT(?:[ \t][^\r\n]*)?(?:\r?\n|$)/.test(text)) {
        throw new Error('Choose a WebVTT (.vtt) caption file.');
      }
      setCaptions({ url: URL.createObjectURL(new Blob([text], { type: 'text/vtt' })), name: file.name });
      setCueText('');
    } catch (err) {
      if (request === selection.current) setError(err instanceof Error ? err.message : 'Unable to read captions.');
    }
  };

  return (
    <div className="min-w-0 flex-1">
      {kind === 'video' ? (
        // Caption tracks are attached below when the user supplies a file; this rule cannot inspect conditional children.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <video src={src} controls aria-label={filename} className="max-h-72 w-full rounded-[var(--radius-thumb)] bg-bg-base">
          {captions && <track key={captions.url} kind="captions" label={captions.name} src={captions.url} default />}
        </video>
      ) : (
        // Caption tracks are attached below when the user supplies a file; this rule cannot inspect conditional children.
        // eslint-disable-next-line jsx-a11y/media-has-caption
        <audio src={src} controls aria-label={filename} className="h-9 w-full">
          {captions && <track
            ref={audioCaptionTrack}
            key={captions.url}
            kind="captions"
            label={captions.name}
            src={captions.url}
            default
          />}
        </audio>
      )}
      {kind === 'audio' && captions && <p aria-live="polite" aria-atomic="true" className="mt-2 whitespace-pre-line text-body text-text-body">{cueText}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-meta text-text-faint">
        <label htmlFor={inputId} className="cursor-pointer font-medium text-text-link underline">Load captions (.vtt)</label>
        <input
          id={inputId}
          type="file"
          accept=".vtt,text/vtt"
          className="max-w-full text-meta"
          onChange={(event) => {
            void loadCaptions(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        <span>{captions ? `${captions.name} · local only` : 'No captions supplied.'}</span>
        {captions && <button type="button" className="pc-focusable rounded-[var(--radius-chip)] font-medium text-text-link underline" onClick={() => {
          selection.current += 1;
          setCaptions(null);
          setCueText('');
          setError(null);
        }}>Remove captions</button>}
      </div>
      {error && <p role="alert" className="mt-1 text-meta text-accent-danger">{error}</p>}
    </div>
  );
}
