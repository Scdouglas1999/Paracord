import * as React from 'react';
import { useRef, useState } from 'react';

import { Popover, Well } from '../ui';
import { cn } from '../../lib/utils';
import { HERE_NOW_MAX_FACES, type PersonLight } from '../../lib/attention/light';
import { RollingNumber } from '../../lib/motion';
import type { HereNow } from '../../hooks/useLights';
import { AvatarStack } from './AvatarStack';
import { LitAvatar } from './LitAvatar';

export interface HereNowStripProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  hereNow: HereNow;
  /** What "here" means on this surface — "in Shop floor", "in build-log". */
  context?: string;
  /** Every person in the building, for the sheet. Defaults to the people here. */
  everyone?: readonly PersonLight[];
  /** Face diameter. 24 in a room header (§7.2, §7.4). */
  size?: number;
  /**
   * Override the strip's sentence.
   *
   * The default is "4 here · 20 online" (§7.2). A surface that needs other
   * words supplies them. Whatever is passed is the light's DOM text equivalent
   * (§9), so it still has to say the count in words.
   */
  caption?: React.ReactNode;
  /** The room these faces are in — a motion mark, so a rim knows its window. */
  room?: string | null;
}

/**
 * HereNowStrip — the lit strip that replaces the member list
 * (docs/lantern-stage-spec.md §6.5, §7.2, §7.4, §8).
 *
 * A well, an avatar stack of at most five lit faces, and the sentence
 * "4 here · 20 online". Clicking it opens the people sheet — **the only
 * place in the product where a full list of people lives**. There is no docked
 * member list anywhere.
 */
export const HereNowStrip = React.forwardRef<HTMLDivElement, HereNowStripProps>(
  function HereNowStrip(
    { hereNow, context, everyone, size = 24, caption, room = null, className, ...props },
    ref,
  ) {
    const anchor = useRef<HTMLButtonElement>(null);
    const [open, setOpen] = useState(false);
    const people = everyone && everyone.length > 0 ? everyone : hereNow.people;

    return (
      <div ref={ref} className={cn('min-w-0', className)} {...props}>
        {/* No radius here: §3 gives a well 10px and the recipe supplies it.
            This asked for --radius-card, which nothing listened to until D2
            made call-site radii bind — and then the strip and the Around-now
            well rounded to 12 while the search well, every form field and the
            DM filter beside them stayed at 10. Two radii for one object. */}
        <Well
          bare
          as="div"
          className="flex min-w-0 items-center py-[5px] pl-[7px] pr-3"
        >
          <button
            ref={anchor}
            type="button"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-haspopup="dialog"
            className="pc-focusable flex min-w-0 items-center gap-2.5 rounded-[var(--radius-control)]"
          >
            <AvatarStack
              people={hereNow.people}
              size={size}
              max={HERE_NOW_MAX_FACES}
              context={context}
              room={room}
            />
            <span className="min-w-0 truncate text-label text-text-body">
              {caption ?? (
                // §5.1 "numbers re-roll": both counts change when somebody
                // walks into the room or comes online, so both flip.
                <>
                  <RollingNumber
                    className="font-semibold text-text-primary"
                    value={hereNow.here}
                    format={(count) => `${count} here`}
                  />
                  {' · '}
                  <RollingNumber
                    value={hereNow.lightsOn}
                    format={(count) => `${count} online`}
                    announce={false}
                  />
                </>
              )}
            </span>
          </button>
        </Well>
        <Popover
          anchor={anchor}
          open={open}
          onClose={() => setOpen(false)}
          side="bottom"
          align="start"
          label="People here now"
          className="max-h-[22rem] w-[18rem] overflow-y-auto p-1.5"
        >
          <ul className="flex flex-col gap-0.5">
            {people.map((person) => (
              <li
                key={person.userId}
                className="flex min-w-0 items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5"
              >
                <LitAvatar person={person} size={24} hideLabel />
                <span className="min-w-0 flex-1 truncate text-label text-text-primary">
                  {person.name}
                </span>
                <span className="shrink-0 text-meta text-text-faint">{person.label}</span>
              </li>
            ))}
            {people.length === 0 && (
              <li className="px-2 py-1.5 text-meta text-text-faint">
                Nobody is here yet.
              </li>
            )}
          </ul>
        </Popover>
      </div>
    );
  },
);
