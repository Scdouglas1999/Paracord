import { useLayoutEffect, useRef } from 'react';

import { EventButton, EventCard } from '../../glass/cards/EventCard';
import { flipFromRect } from '../motion';
import { draftMeta, draftTile, type DraftPlan } from './draftEvent';

/** §5.6: the draft grows out of the action card, 195ms on the spring, from half opacity. */
export const DRAFT_MORPH_MS = 195;
export const DRAFT_MORPH_OPACITY = 0.5;

export interface DraftEventCardProps {
  plan: DraftPlan;
  posting: boolean;
  error: string | null;
  onPost: () => void;
  onEdit: () => void;
}

/**
 * The draft event card (docs/index-spec.md §4.13, §5.6): the event card of the
 * timeline, with "Post it" (the cream button) and "Edit" in place of the RSVPs.
 * It sits where a message of yours would, on the right, and on mount it plays out
 * of the action card it replaces (`plan.from`): a translate and a non-uniform
 * scale from that card's rect, opacity .5 to 1, transform and opacity only.
 */
export function DraftEventCard({ plan, posting, error, onPost, onEdit }: DraftEventCardProps) {
  const card = useRef<HTMLDivElement | null>(null);
  const morphed = useRef(false);

  useLayoutEffect(() => {
    if (morphed.current) return;
    morphed.current = true;
    const element = card.current;
    if (!element || !plan.from) return;
    flipFromRect(element, plan.from, {
      duration: DRAFT_MORPH_MS,
      scale: 'xy',
      opacityFrom: DRAFT_MORPH_OPACITY,
      id: 'ix-conversation:draft',
    });
  }, [plan.from]);

  const tile = draftTile(plan);
  return (
    <div className="ix-draft" data-testid="ix-draft-event">
      <div ref={card} className="ix-draft__card">
        <EventCard weekday={tile.weekday} day={tile.day} title={plan.name} meta={draftMeta(plan)} kind="Draft event" label={`Draft event: ${plan.name}`}>
          <EventButton primary disabled={posting} aria-busy={posting || undefined} onClick={onPost}>
            {posting ? 'Posting…' : 'Post it'}
          </EventButton>
          <EventButton disabled={posting} onClick={onEdit}>
            Edit
          </EventButton>
        </EventCard>
      </div>
      {error && (
        <p className="ix-draft__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
