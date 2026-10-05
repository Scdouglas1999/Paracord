import type { ReactNode, RefObject } from 'react';

import { cn } from '../../../lib/utils';
import type { StageModel } from '../../glass/stage/stageModel';
import { IxGlyph } from '../glyphs';
import { callPlaceLine } from './callModel';

/**
 * The call view's header (docs/index-spec.md §7.2, §3.1): the speaker glyph in
 * amber (a phone for a direct call, the podium for a stage channel), the
 * channel 18/700, the server 13 amber ("Direct call"), then chat (H), theater
 * (T), full screen (F, with a stream in focus) and **Back to chat** (Esc). The
 * phone has no chat; with a stream in focus it offers Full screen (theater on
 * a phone, IX-16) instead.
 *
 * Over a stream that fills the window (theater or full screen, §7.7) the
 * header is the top of the chrome: it leads with whose stream it is (`lead`)
 * and carries the stream's own tools (`streamTools`: sound and quality, Show
 * everyone); full screen has no chat column and no theater to offer.
 */
export interface CallHeaderProps {
  model: StageModel;
  chat: boolean;
  theater: boolean;
  phone: boolean;
  /** A stream is in focus: full screen is offered (on a phone, the sheet's own). */
  stream?: boolean;
  /** The stream is full screen (§7.7). */
  fullscreen?: boolean;
  /** A stream fills the window (theater or full screen): the header is chrome over it. */
  immersive?: boolean;
  /** What leads an immersive header instead of the channel: whose stream it is. */
  lead?: ReactNode;
  /** The stream's own tools, in an immersive header. */
  streamTools?: ReactNode;
  /** Where "Stream volume and quality" in More finds the sound button in an immersive header. */
  toolsRef?: RefObject<HTMLDivElement | null>;
  onToggleChat: () => void;
  onToggleTheater: () => void;
  onToggleFullscreen?: () => void;
  onBack: () => void;
}

export function CallHeader({
  model,
  chat,
  theater,
  phone,
  stream = false,
  fullscreen = false,
  immersive = false,
  lead,
  streamTools,
  toolsRef,
  onToggleChat,
  onToggleTheater,
  onToggleFullscreen,
  onBack,
}: CallHeaderProps) {
  const glyph = model.dm ? 'phone' : model.stageChannel ? 'stage' : 'speaker';
  const place = callPlaceLine(model);
  return (
    <header className="ix-call-head" data-immersive={immersive ? 'true' : undefined}>
      {immersive && lead ? (
        lead
      ) : (
        <>
          <IxGlyph name={glyph} size={18} className="ix-call-head__glyph" />
          <h2 className="ix-call-head__name">{model.channelName}</h2>
          {place && <span className="ix-call-head__place">{place}</span>}
        </>
      )}
      <span className="ix-call-head__spacer" />
      {immersive && streamTools && (
        <div ref={toolsRef} className="ix-call-head__stream-tools">
          {streamTools}
        </div>
      )}
      {!phone && !fullscreen && (
        <>
          <button
            type="button"
            className={cn('ix-call-head__tool', chat && 'is-on')}
            aria-label={chat ? 'Hide chat' : 'Show chat'}
            aria-pressed={chat}
            aria-keyshortcuts="H"
            title={chat ? 'Hide chat (H)' : 'Show chat (H)'}
            data-testid="ix-call-chat"
            onClick={onToggleChat}
          >
            <IxGlyph name="hello" size={18} />
          </button>
          <button
            type="button"
            className={cn('ix-call-head__tool', theater && 'is-on')}
            aria-label={theater ? 'Leave theater' : 'Theater'}
            aria-pressed={theater}
            aria-keyshortcuts="T"
            title={theater ? 'Leave theater (T)' : 'Theater (T)'}
            data-testid="ix-call-theater"
            onClick={onToggleTheater}
          >
            <IxGlyph name="theater" size={18} />
          </button>
        </>
      )}
      {!phone && stream && onToggleFullscreen && (
        <button
          type="button"
          className={cn('ix-call-head__tool', fullscreen && 'is-on')}
          aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
          aria-pressed={fullscreen}
          aria-keyshortcuts="F"
          title={fullscreen ? 'Exit full screen (F or Esc)' : 'Full screen (F)'}
          data-testid="ix-call-fullscreen"
          onClick={onToggleFullscreen}
        >
          <IxGlyph name={fullscreen ? 'fullScreenExit' : 'fullScreen'} size={18} />
        </button>
      )}
      {phone && stream && (
        <button
          type="button"
          className={cn('ix-call-head__tool', theater && 'is-on')}
          aria-label={theater ? 'Exit full screen' : 'Full screen'}
          aria-pressed={theater}
          title={theater ? 'Exit full screen' : 'Full screen'}
          data-testid="ix-call-fullscreen"
          onClick={onToggleTheater}
        >
          <IxGlyph name={theater ? 'fullScreenExit' : 'fullScreen'} size={18} />
        </button>
      )}
      <button
        type="button"
        className="ix-call-head__back"
        data-testid="ix-call-back"
        aria-keyshortcuts="Escape"
        title="Back to chat (Esc). You stay in the call."
        onClick={onBack}
      >
        Back to chat
      </button>
    </header>
  );
}
