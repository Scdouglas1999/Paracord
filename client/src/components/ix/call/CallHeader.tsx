import { cn } from '../../../lib/utils';
import type { StageModel } from '../../glass/stage/stageModel';
import { IxGlyph } from '../glyphs';
import { callPlaceLine } from './callModel';

/**
 * The call view's header (docs/index-spec.md §7.2, §3.1): the speaker glyph in
 * amber (a phone for a direct call, the podium for a stage channel), the
 * channel 18/700, the server 13 amber ("Direct call"), then chat (H), theater
 * (T) and **Back to chat** (Esc). The phone has no chat; with a stream in focus
 * it offers Full screen (theater on a phone, IX-16) instead.
 */
export interface CallHeaderProps {
  model: StageModel;
  chat: boolean;
  theater: boolean;
  phone: boolean;
  /** A stream is in focus: on a phone the header offers Full screen (IX-16). */
  stream?: boolean;
  onToggleChat: () => void;
  onToggleTheater: () => void;
  onBack: () => void;
}

export function CallHeader({ model, chat, theater, phone, stream = false, onToggleChat, onToggleTheater, onBack }: CallHeaderProps) {
  const glyph = model.dm ? 'phone' : model.stageChannel ? 'stage' : 'speaker';
  const place = callPlaceLine(model);
  return (
    <header className="ix-call-head">
      <IxGlyph name={glyph} size={18} className="ix-call-head__glyph" />
      <h2 className="ix-call-head__name">{model.channelName}</h2>
      {place && <span className="ix-call-head__place">{place}</span>}
      <span className="ix-call-head__spacer" />
      {!phone && (
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
          <IxGlyph name="theater" size={18} />
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
