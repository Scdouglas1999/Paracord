import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { paletteHue } from '../../../lib/identityHue';
import type { MediaEngine } from '../../../lib/media/mediaEngine';
import type { VideoAnchor } from '../../../lib/media/video/canvasRenderer';
import { cn } from '../../../lib/utils';
import { useNativeUnderlay } from '../../glass/stage/nativeUnderlay';
import { personState, type StagePerson } from '../../glass/stage/stageModel';
import { SoundboardBurst } from '../../voice/SoundboardBurst';
import { Wave } from '../card/Wave';
import { IxGlyph } from '../glyphs';
import { Avatar } from '../identity';

/**
 * One person in the call view (docs/index-spec.md §7.2, §3.1 "Call surface").
 *
 * Camera off: the 88px avatar (52 in the filmstrip) centered on the person-hue
 * gradient. Camera on: their live video fills the tile (`cover`, cropped about
 * a third down so faces stay in frame), name and waveform bottom-left. The
 * talker wears the amber inner edge and glow.
 *
 * The tile hands its `<canvas>` to `engine.subscribeVideo(..., {
 * preferredTrackId: 'camera', fit: 'cover', anchor })`. In the browser that is WebCodecs into the
 * canvas; in the desktop app it is a native surface under the page that
 * mirrors the canvas's box, and the canvas carries the surface's poster while
 * its hole is closed (a move, a dialog over it). The tile is the surface's
 * boundary (`data-native-surface-boundary`), so its own chrome never counts as
 * covering the video, and it is `data-native-underlay-clear`, so its fill goes
 * clear while the hole is open. Unmounting the tile unsubscribes the camera.
 *
 * A camera is drawn from the call this client is in: before you join, a
 * camera tile shows the face where the picture will be.
 */

/**
 * Where a camera's crop falls when its picture is taller than its tile: about a
 * third down, so people's faces stay in frame. A camera is a person sitting
 * back from a screen; their face is in the upper part of the picture, and
 * centering a 4:3 or portrait camera in a wide tile cuts it off at the
 * forehead. The anchor is CSS `object-position`'s: 0.35 crops 35% of what has
 * to go from the top and 65% from the bottom. A picture wider than its tile is
 * cropped at the sides, which stay centered.
 */
const CAMERA_ANCHOR: Readonly<Required<VideoAnchor>> = { x: 0.5, y: 0.35 };

export interface CallTileProps {
  person: StagePerson;
  /** The call's engine when this client is in the call; cameras draw from it. */
  engine: MediaEngine | null;
  /** The voice is heard here (joined or listening): the waveform follows the real level. */
  realVoice: boolean;
  /** `grid`: a tile of the people grid; `strip`: the filmstrip's 112px tile; `focus`: a camera in focus. */
  variant: 'grid' | 'strip' | 'focus';
  /** What a click does, or null for a tile that is not a button. */
  onActivate: (() => void) | null;
  /** The accessible name of the click ("Watch Vincent's screen"). */
  activateLabel?: string;
  /** This tile is what the view focuses (the filmstrip marks it). */
  current?: boolean;
  /** The name the monogram is drawn from: your own name on your tile, where the words say "You". */
  faceName?: string;
  style?: CSSProperties;
}

export function CallTile({ person, engine, realVoice, variant, onActivate, activateLabel, current, faceName, style }: CallTileProps) {
  const tileRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasPicture, setHasPicture] = useState(false);
  const underlayLive = useNativeUnderlay(tileRef, canvasRef);
  const camera = person.camera && engine !== null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!camera || !engine || !canvas) return;
    let sawFrame = false;
    const unsubscribe = engine.subscribeVideo(
      person.userId,
      canvas,
      () => {
        if (sawFrame) return;
        sawFrame = true;
        setHasPicture(true);
      },
      { preferredTrackId: 'camera', fit: 'cover', anchor: CAMERA_ANCHOR },
    );
    return () => {
      unsubscribe();
      setHasPicture(false);
    };
  }, [camera, engine, person.userId]);

  const picture = camera && (hasPicture || underlayLive);
  const avatarSize = variant === 'strip' ? 52 : 88;
  const state = personState(person);
  const sharingMark = person.sharing && !person.listening;

  const body = (
    <>
      {camera && (
        <canvas
          ref={canvasRef}
          className="ix-call-tile__video"
          aria-hidden="true"
          data-self={person.self ? 'true' : undefined}
          style={{
            // The native route: this box IS the hole; the canvas stops painting
            // while the surface below is live and keeps its layout box.
            opacity: hasPicture && !underlayLive ? 1 : 0,
            visibility: underlayLive ? 'hidden' : 'visible',
          }}
        />
      )}
      {!picture && (
        <span className="ix-call-tile__face" aria-hidden="true">
          <Avatar userId={person.userId} name={faceName ?? person.name} avatar={person.avatar} size={avatarSize} />
        </span>
      )}
      {picture && <span className="ix-call-tile__shade" aria-hidden="true" />}
      {/* Who just played a soundboard sound: its emoji, and a ring on the edge. */}
      <SoundboardBurst userId={person.userId} />
      <span className="ix-call-tile__name">
        <span className="ix-call-tile__who">{person.self ? 'You' : person.name}</span>
        <span className="sr-only">, {describe(person, state.text)}</span>
        {person.talking && <Wave userId={person.userId} real={realVoice} className="ix-call-tile__wave" />}
        {sharingMark && !person.talking && <IxGlyph name="screen" size={14} className="ix-call-tile__mark" />}
        {person.muted && !person.talking && !sharingMark && <IxGlyph name="micOff" size={14} className="ix-call-tile__mark" />}
      </span>
    </>
  );

  return (
    <div
      ref={tileRef}
      role="listitem"
      className={cn('ix-call-tile', `ix-call-tile--${variant}`)}
      style={style}
      data-user-id={person.userId}
      data-talking={person.talking ? 'true' : undefined}
      data-camera={camera ? 'true' : undefined}
      data-picture={picture ? 'true' : undefined}
      data-current={current ? 'true' : undefined}
      data-native-surface-boundary=""
      data-native-underlay-clear=""
      data-underlay={underlayLive ? 'live' : undefined}
    >
      <span className="ix-call-tile__ground" aria-hidden="true" style={{ '--ix-h': paletteHue(person.userId) } as CSSProperties} />
      {onActivate ? (
        <button
          type="button"
          className="ix-call-tile__button"
          aria-label={activateLabel}
          title={activateLabel}
          aria-pressed={current ?? undefined}
          onClick={onActivate}
        >
          {body}
        </button>
      ) : (
        <span className="ix-call-tile__button ix-call-tile__button--static">{body}</span>
      )}
    </div>
  );
}

/** What a screen reader hears after the name: "Talking, camera on". */
function describe(person: StagePerson, state: string): string {
  const parts = [state];
  if (person.camera) parts.push('camera on');
  return parts.join(', ');
}
