import * as React from 'react';

import { Well } from '../../ui';
import { AvatarStack } from '../../light';
import {
  HERE_NOW_MAX_FACES,
  lightsOnOverflowCaption,
  type PersonLight,
} from '../../../lib/attention/light';
import { cn } from '../../../lib/utils';

export interface AroundNowWellProps {
  /** The people in this building whose lights are on. */
  people: readonly PersonLight[];
  /** WP1's one-sentence summary of who is where. */
  sentence: string;
  /** How many people in the building have their lights on, in total. */
  lightsOn: number;
  /** How many faces to show before the count takes over. */
  max?: number;
}

/**
 * The "Around now" well (docs/lantern-stage-spec.md §7.3).
 *
 * A stack of lit faces, one sentence naming who is where, and the count of
 * everybody else whose lights are on. The sentence comes from WP1
 * (`aroundNowSentence`) — this surface does not re-derive a light, and with
 * nobody around it says "Nobody's lights are on right now", never "No data"
 * (§6.9).
 */
export const AroundNowWell = React.forwardRef<HTMLElement, AroundNowWellProps>(
  function AroundNowWell({ people, sentence, lightsOn, max = HERE_NOW_MAX_FACES }, ref) {
    const shown = people.slice(0, max);
    const litShown = shown.filter((person) => person.lit).length;
    const overflow = Math.max(0, lightsOn - litShown);

    return (
      <Well
        ref={ref}
        as="section"
        aria-label="Around now"
        bare
        className={cn(
          'flex flex-col gap-2 px-3.5 py-2.5',
          // On a phone the sentence gets the full width; squeezed into a row it
          // wraps one word per line.
          'sm:flex-row sm:items-center sm:gap-3.5',
        )}
      >
        <span className="flex shrink-0 items-center gap-3">
          <span className="whitespace-nowrap text-meta text-text-faint">Around now</span>
          {shown.length > 0 && (
            <AvatarStack people={shown} size={28} max={max} overlap={6} context="around now" />
          )}
        </span>
        {/* The sentence and the count are one statement about the same people,
            so they travel together. Pushed apart by a `flex-1` the count sat
            ~800px away at the far edge of the well, reading as an unrelated
            chip (§8: "avatar stack + 'N here · M lights on'"). */}
        <span className="min-w-0 truncate text-ribbon text-text-body">{sentence}</span>
        {overflow > 0 && (
          <span className="shrink-0 whitespace-nowrap text-meta text-text-faint">
            {lightsOnOverflowCaption(overflow)}
          </span>
        )}
      </Well>
    );
  },
);
