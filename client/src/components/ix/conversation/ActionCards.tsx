import { forwardRef } from 'react';

import { cn } from '../../../lib/utils';
import { IxGlyph, type IxGlyphName } from '../glyphs';
import type { WelcomeAction } from './welcomeModel';

/**
 * The welcome's action cards (docs/index-spec.md §3.1 "Action card", §4.13): a
 * glyph tile in the place's hue, a 15/700 title and a 13 line, on a quiet card
 * that lifts 3px under the pointer (180ms spring). Each is one button.
 *
 * The invite card is the one that talks back: its title crossfades to "Link
 * copied" for two seconds (§5.16, 90ms). Both words stay in the card (one is
 * `aria-hidden`), so the card never changes size, and a polite status line says
 * the same to a screen reader.
 */

export interface ActionCardCopy {
  title: string;
  body: string;
  glyph: IxGlyphName;
}

export const ACTION_CARD_COPY: Record<WelcomeAction, ActionCardCopy> = {
  invite: { title: 'Bring your people', body: 'A link that works for anyone, on any device.', glyph: 'invite' },
  plan: { title: 'Plan a night', body: 'Pick a time; everyone gets a nudge before it starts.', glyph: 'plan' },
  hello: { title: 'Say hello', body: 'The first message sets the tone.', glyph: 'hello' },
  people: { title: 'See who’s here', body: 'Meet the people in this server.', glyph: 'people' },
  roles: { title: 'Pick roles', body: 'Choose the ones that fit you.', glyph: 'check' },
};

export interface ActionCardProps {
  action: WelcomeAction;
  onPick: (action: WelcomeAction, card: HTMLButtonElement) => void;
  /** The invite card after it copied the link: "Link copied". */
  copied?: boolean;
  /** A card that is working (the invite being made): `aria-busy`, and a second press waits. */
  busy?: boolean;
}

export const ActionCard = forwardRef<HTMLButtonElement, ActionCardProps>(function ActionCard(
  { action, onPick, copied = false, busy = false },
  ref,
) {
  const copy = ACTION_CARD_COPY[action];
  const swaps = action === 'invite';
  return (
    <button
      ref={ref}
      type="button"
      className="ix-way"
      data-testid="ix-action-card"
      data-action={action}
      aria-busy={busy || undefined}
      onClick={(event) => onPick(action, event.currentTarget)}
    >
      <span className="ix-way__gl ix-hue-tile" aria-hidden>
        <IxGlyph name={copy.glyph} size={18} />
      </span>
      {swaps ? (
        <b className="ix-way__title ix-way__title--swap" data-copied={copied || undefined}>
          <span className="ix-way__a">{copy.title}</span>
          <span className="ix-way__b" aria-hidden>
            Link copied
          </span>
          <span className="sr-only" role="status">
            {copied ? 'Link copied' : ''}
          </span>
        </b>
      ) : (
        <b className="ix-way__title">{copy.title}</b>
      )}
      <span className="ix-way__body">{copy.body}</span>
    </button>
  );
});

export interface ActionCardsProps {
  actions: readonly WelcomeAction[];
  onPick: ActionCardProps['onPick'];
  /** Which card is copied / busy right now (the invite). */
  copied?: WelcomeAction | null;
  busy?: WelcomeAction | null;
  className?: string;
}

/** The row of cards: three 196px columns centered; a card the person may not use is simply not in `actions`. */
export function ActionCards({ actions, onPick, copied = null, busy = null, className }: ActionCardsProps) {
  if (actions.length === 0) return null;
  return (
    <div className={cn('ix-ways', className)} data-count={actions.length}>
      {actions.map((action) => (
        <ActionCard key={action} action={action} onPick={onPick} copied={copied === action} busy={busy === action} />
      ))}
    </div>
  );
}
