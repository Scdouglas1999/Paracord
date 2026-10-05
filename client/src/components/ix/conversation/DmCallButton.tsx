import { cn } from '../../../lib/utils';
import { IxGlyph } from '../glyphs';
import { useDmCall } from './useDmCall';

export interface DmCallButtonProps {
  channelId: string;
  /** The person's or group's name, for the sentence that names a failure. */
  title: string;
  /** The conversation's voice decision (`useConversationActions().actions.voice`). */
  allowed: boolean;
  reason: string | null;
}

/**
 * The phone glyph at the toolbar's left of search (docs/index-spec.md §4.9). It
 * starts the call; while the call runs it reads as active (an amber glyph) and
 * opens the call view. Its name says which: "Start a call" / "Open the call".
 * A call that cannot start says why in its title (the server's own words).
 */
export function DmCallButton({ channelId, title, allowed, reason }: DmCallButtonProps) {
  const call = useDmCall(channelId, title, allowed, reason);
  const label = call.inCall ? 'Open the call' : 'Start a call';
  return (
    <button
      type="button"
      className={cn('ix-tool', 'ix-dmcall')}
      data-testid="ix-dm-call"
      data-active={call.inCall ? 'true' : undefined}
      aria-label={label}
      aria-busy={call.joining || undefined}
      title={call.reason ?? label}
      disabled={call.disabled}
      onClick={call.press}
    >
      <IxGlyph name="phone" size={18} />
    </button>
  );
}
