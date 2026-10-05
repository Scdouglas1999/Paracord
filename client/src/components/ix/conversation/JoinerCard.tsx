import { IxGlyph } from '../glyphs';
import { ServerMark } from '../identity';
import { Control, ToolChip } from '../primitives';
import { ACTION_CARD_COPY } from './ActionCards';
import type { WelcomeAction } from './welcomeModel';

export interface JoinerCardProps {
  guildId: string;
  name: string;
  icon?: string | null;
  hue?: number | null;
  description?: string | null;
  actions: readonly WelcomeAction[];
  onPick: (action: WelcomeAction, element: HTMLElement) => void;
  onDismiss: () => void;
}

/**
 * The joiner welcome on a first visit to a server that already has things said in
 * it (docs/index-spec.md §8.3): the welcome's words and its cards, as one quiet
 * card above the message box, where it is seen however much history there is. The
 * same actions as the empty channel's welcome; "×" (or any action) is being
 * welcomed, and it does not come back.
 */
export function JoinerCard({ guildId, name, icon, hue, description, actions, onPick, onDismiss }: JoinerCardProps) {
  return (
    <section className="ix-joiner" data-testid="ix-joiner" aria-label={`Welcome to ${name}`}>
      <ServerMark guildId={guildId} name={name} icon={icon} hue={hue} size={40} />
      <div className="ix-joiner__text">
        <h2 className="ix-joiner__title">Welcome to {name}</h2>
        <p className="ix-joiner__line">{description?.trim() || 'Say hi when you’re ready.'}</p>
        <div className="ix-joiner__acts">
          {actions.map((action) => (
            <ToolChip
              key={action}
              data-testid="ix-action-card"
              data-action={action}
              onClick={(event) => onPick(action, event.currentTarget)}
            >
              <IxGlyph name={ACTION_CARD_COPY[action].glyph} size={14} />
              {ACTION_CARD_COPY[action].title}
            </ToolChip>
          ))}
        </div>
      </div>
      <Control label="Dismiss the welcome" onClick={onDismiss}>
        <IxGlyph name="x" size={16} />
      </Control>
    </section>
  );
}
