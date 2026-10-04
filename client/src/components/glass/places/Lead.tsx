import { useEffect, useState, type CSSProperties } from 'react';
import { Gamepad2, Grid3x3, Megaphone, MessagesSquare, Radio, Trophy, Volume2 } from 'lucide-react';

import { fileApi } from '../../../api/files';
import { cn } from '../../../lib/utils';
import { useServerListStore } from '../../../stores/serverListStore';
import { Avatar } from '../../ix/identity';
import type { ChannelGlyph, FaceModel } from './model';

/**
 * What leads a row: a face, two faces overlapped, a picture, or a glyph tile
 * (docs/glass-spec.md §3.1). Faces and pictures are content, so they are solid
 * and carry no outline of their own; the ring around an overlapped face is the
 * color of the row behind it, so the front face bites the back one.
 *
 * Since Index (docs/index-spec.md §2.3) a face is drawn by the Index `Avatar`:
 * a flat tonal circle in the person's hue with one letter. `Face` keeps its
 * name, its props and its `.glass-face` class, so every place that draws a face
 * (and every sheet that rings or dims one) changes at once.
 */

/**
 * Two letters at most, never an emoji.
 *
 * @deprecated A face has one letter now (`monogramOf` in components/ix/identity).
 * Kept only for the timeline's own avatar until the timeline is rebuilt.
 */
export function initialsOf(name: string): string {
  const words = name
    .split(/[\s._-]+/)
    .map((word) => word.trim())
    .filter(Boolean);
  if (words.length === 0) return '?';
  return words
    .slice(0, 2)
    .map((word) => [...word][0] ?? '')
    .join('')
    .toUpperCase() || '?';
}

export interface FaceProps {
  face: FaceModel;
  size: number;
  className?: string;
  style?: CSSProperties;
}

/** A person's picture, or their monogram on their hue: the Index `Avatar`, decorative. */
export function Face({ face, size, className, style }: FaceProps) {
  return (
    <Avatar
      userId={face.userId}
      name={face.name}
      avatar={face.avatar}
      size={size}
      className={cn('glass-face', className)}
      style={style}
    />
  );
}

export interface FaceStackProps {
  faces: readonly FaceModel[];
  /** Diameter of each face. */
  size: number;
  /** How far each face after the first is pulled back over the one before it. */
  overlap?: number;
  className?: string;
}

/** Faces in a row, each overlapping the last: the occupants of a live channel. */
export function FaceStack({ faces, size, overlap = 7, className }: FaceStackProps) {
  return (
    <span className={cn('glass-face-stack', className)} aria-hidden="true">
      {faces.map((face, index) => (
        <Face
          key={face.userId}
          face={face}
          size={size}
          style={index === 0 ? undefined : { marginInlineStart: -overlap }}
        />
      ))}
    </span>
  );
}

/**
 * The last speakers of a channel, or one person. Two faces sit diagonally in the
 * 44px slot (the earlier one behind, top left; the latest in front, bottom right);
 * one face is centered.
 */
export function LeadFaces({
  faces,
  variant,
  online = false,
}: {
  faces: readonly FaceModel[];
  variant: 'authors' | 'person';
  /** The person is here now: a small light dot on their face (a direct message). */
  online?: boolean;
}) {
  if (faces.length <= 1) {
    const only = faces[0];
    if (!only) return null;
    return (
      <span className="glass-lead glass-lead--faces" data-count="1">
        <Face face={only} size={variant === 'person' ? 44 : 36} />
        {online && <span className="glass-lead__presence" aria-hidden="true" />}
      </span>
    );
  }
  const [behind, front] = faces;
  return (
    <span className="glass-lead glass-lead--faces" data-count="2">
      <Face face={behind} size={30} className="glass-lead__behind" />
      <Face face={front} size={30} className="glass-lead__front" />
    </span>
  );
}

/* ---- Glyphs ----------------------------------------------------------------- */

export type PlaceGlyphName = ChannelGlyph | 'people' | 'tray' | 'plus' | 'chevron' | 'trophy' | 'word' | 'games' | 'calendar';

interface PlaceGlyphProps {
  name: PlaceGlyphName;
  size?: number;
  strokeWidth?: number;
}

/**
 * The prototype's own line glyphs (chat, person, document, tray, plus, chevron),
 * drawn 1.7 thick on a 24 grid; the rest are the app's stock icons at the same
 * weight.
 */
export function PlaceGlyph({ name, size = 19, strokeWidth = 1.7 }: PlaceGlyphProps) {
  switch (name) {
    case 'voice':
      return <Volume2 size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'stage':
      return <Radio size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'announcement':
      return <Megaphone size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'forum':
      return <MessagesSquare size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'trophy':
      return <Trophy size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'word':
      return <Grid3x3 size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    case 'games':
      return <Gamepad2 size={size} strokeWidth={strokeWidth} aria-hidden="true" />;
    default:
      break;
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0 }}
    >
      {name === 'chat' && <path d="M4 5h16v11H9l-5 4z" />}
      {name === 'people' && (
        <>
          <circle cx="9" cy="8" r="3.5" />
          <path d="M2.5 20c.6-3.8 3.3-6 6.5-6s5.9 2.2 6.5 6" />
        </>
      )}
      {name === 'doc' && (
        <>
          <path d="M7 3h7l5 5v13H7z" />
          <path d="M14 3v5h5M10 13h6M10 17h6" />
        </>
      )}
      {name === 'tray' && (
        <>
          <path d="M3 13h5l1.5 3h5L16 13h5" />
          <path d="M5 6h14l2 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z" />
        </>
      )}
      {name === 'plus' && <path d="M12 5v14M5 12h14" />}
      {name === 'chevron' && <path d="m6 9 6 6 6-6" />}
      {name === 'calendar' && (
        <>
          <rect x="3.5" y="5" width="17" height="15" rx="3" />
          <path d="M8 3v4M16 3v4M3.5 10h17" />
        </>
      )}
    </svg>
  );
}

/** A 44px tile with a glyph in it: a channel with no face or picture to lead with. */
export function GlyphTile({ glyph }: { glyph: PlaceGlyphName }) {
  return (
    <span className="glass-lead glass-lead--tile" aria-hidden="true">
      <PlaceGlyph name={glyph} />
    </span>
  );
}

/* ---- Pictures --------------------------------------------------------------- */

const MAX_CACHED_THUMBS = 48;
const REVOKE_GRACE_MS = 10_000;
const thumbs = new Map<string, Promise<string>>();

function thumbnail(serverKey: string, attachmentId: string): Promise<string> {
  const key = `${serverKey}\u0000${attachmentId}`;
  const hit = thumbs.get(key);
  if (hit) {
    // Most recently used goes to the back of the map.
    thumbs.delete(key);
    thumbs.set(key, hit);
    return hit;
  }
  const request = fileApi.resolveAttachmentObjectUrl(`/api/v1/attachments/${encodeURIComponent(attachmentId)}`);
  // A failure must not be remembered: the next render asks again.
  request.catch(() => {
    if (thumbs.get(key) === request) thumbs.delete(key);
  });
  thumbs.set(key, request);
  while (thumbs.size > MAX_CACHED_THUMBS) {
    const oldest = thumbs.entries().next();
    if (oldest.done) break;
    const [oldKey, oldRequest] = oldest.value;
    thumbs.delete(oldKey);
    void oldRequest.then(
      (url) => {
        // An <img> may still be pointing at it; give the swap a moment.
        if (url.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(url), REVOKE_GRACE_MS);
      },
      () => {},
    );
  }
  return request;
}

/**
 * A channel's latest picture as an object URL, or null until it arrives (and if
 * it never does). The whole file is fetched: the server makes no thumbnails yet,
 * so a follow-up there would let this ask for a 44px version instead.
 */
export function useAttachmentThumb(attachmentId: string | null): string | null {
  const serverKey = useServerListStore((state) => state.activeServerId ?? 'local');
  const [resolved, setResolved] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (!attachmentId) return;
    let canceled = false;
    void thumbnail(serverKey, attachmentId).then(
      (url) => {
        if (!canceled) setResolved({ id: attachmentId, url });
      },
      () => {
        if (!canceled) setResolved(null);
      },
    );
    return () => {
      canceled = true;
    };
  }, [serverKey, attachmentId]);
  return attachmentId && resolved?.id === attachmentId ? resolved.url : null;
}

/**
 * The latest picture of a channel, 44px, radius 12, with a hairline edge. It is
 * decorative: the row's line already says what was shared.
 */
export function MediaLead({ attachmentId }: { attachmentId: string }) {
  const src = useAttachmentThumb(attachmentId);
  return (
    <span className="glass-lead glass-lead--media" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : null}
    </span>
  );
}
