import type { ReactNode } from 'react';

import { cn } from '../../../lib/utils';
import { ActionCards, type ActionCardsProps } from './ActionCards';
import type { WelcomeModel } from './welcomeModel';

export interface WelcomeProps extends Pick<ActionCardsProps, 'onPick' | 'copied' | 'busy'> {
  model: WelcomeModel;
  /** The 76px mark: the server's, a person's face, a group's tile. */
  mark: ReactNode;
  className?: string;
}

/**
 * The welcome (docs/index-spec.md §3.1 "Welcome", §4.13): a 76px mark, a 24/600
 * title 20px under it, a 15 ink-3 line, and the cards that fit, centered in what
 * is left of the conversation. The same layout for a new server, any empty
 * channel, a joiner and a new message; `model` (welcomeModel.ts) says the words.
 *
 * `data-testid="ix-welcome"` is the harness's hook; `data-variant` says which.
 */
export function Welcome({ model, mark, onPick, copied, busy, className }: WelcomeProps) {
  return (
    <section
      className={cn('ix-welcome', className)}
      data-testid="ix-welcome"
      data-variant={model.variant}
      aria-labelledby="ix-welcome-title"
    >
      {mark}
      <h2 className="ix-welcome__title" id="ix-welcome-title">
        {model.title}
      </h2>
      <p className="ix-welcome__line">{model.line}</p>
      <ActionCards actions={model.actions} onPick={onPick} copied={copied} busy={busy} />
    </section>
  );
}
