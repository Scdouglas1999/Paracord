import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { Play } from 'lucide-react';
import { parseClipFilename } from '../../lib/media/clips/clipFilename';
import '../../lib/media/clips/clips.css';

interface MediaPreviewProps {
  src: string;
  filename: string;
  kind: 'audio' | 'video';
  /** Starts playing once loaded (the lightbox opens a video to watch it). */
  autoPlay?: boolean;
  /** Replaces the inline size of a video, for a surface that is not a message row. */
  videoStyle?: CSSProperties;
}

/** User-supplied media can be paired with a local caption file without uploading it. */
export function MediaPreview({ src, filename, kind, autoPlay, videoStyle }: MediaPreviewProps) {
  // A stream clip in a message (docs/glass-spec.md §6.4): a 16:9 media bubble
  // with a play button and "0:30 from Vincent's screen". The lightbox, which
  // opens a video to watch it, keeps the ordinary player.
  const clip = kind === 'video' && !autoPlay && !videoStyle ? parseClipFilename(filename) : null;
  if (clip) return <ClipPlayer src={src} label={clip.label} />;
  return <MediaPlayer src={src} filename={filename} kind={kind} autoPlay={autoPlay} videoStyle={videoStyle} />;
}

/** A posted clip: its first picture, a play button and its label, until it plays. */
function ClipPlayer({ src, label }: { src: string; label: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const play = () => {
    setPlaying(true);
    void video.current?.play().catch(() => setPlaying(false));
  };
  return (
    <div className="glass-clip" data-playing={playing ? 'true' : undefined}>
      {/* A clip is a moment of someone's stream; there is no caption file to pair with it. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video
        ref={video}
        src={src}
        preload="metadata"
        controls={playing}
        playsInline
        aria-label={label}
        className="glass-clip__video"
        onEnded={() => setPlaying(false)}
      />
      {!playing && (
        <>
          <button type="button" className="glass-clip__play glass-focusable" aria-label={`Play clip, ${label}`} onClick={play}>
            <span className="glass-clip__play-circle">
              <Play size={18} fill="currentColor" strokeWidth={1.8} aria-hidden="true" />
            </span>
          </button>
          <span className="glass-clip__label" aria-hidden="true">{label}</span>
        </>
      )}
    </div>
  );
}

function MediaPlayer({ src, filename, kind, autoPlay, videoStyle }: MediaPreviewProps) {
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
        <video
          src={src}
          controls
          autoPlay={autoPlay}
          aria-label={filename}
          className={videoStyle ? 'glass-media-video' : 'glass-media-video glass-media-video--inline'}
          style={videoStyle}
        >
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
      {/* Captions stay on this device: a quiet line under the player, the file
          picker behind the label so it reads as a text button (Glass). */}
      <div className="glass-media-captions">
        <label htmlFor={inputId} className="glass-media-captions__load">Load captions (.vtt)</label>
        <input
          id={inputId}
          type="file"
          accept=".vtt,text/vtt"
          className="glass-media-captions__input"
          onChange={(event) => {
            void loadCaptions(event.currentTarget.files?.[0]);
            event.currentTarget.value = '';
          }}
        />
        {captions && <span>{captions.name} · local only</span>}
        {captions && <button type="button" className="glass-media-captions__remove glass-focusable" onClick={() => {
          selection.current += 1;
          setCaptions(null);
          setCueText('');
          setError(null);
        }}>Remove captions</button>}
      </div>
      {error && <p role="alert" className="glass-media-captions__error">{error}</p>}
    </div>
  );
}
