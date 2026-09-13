import * as React from 'react';

import { Plate } from '../../ui';
import { cn } from '../../../lib/utils';

/** The reference strip is 128px tall on the desktop Stage. */
export const SPEAKER_STRIP_HEIGHT = 128;
/** The phone puts the share on top at a fixed height and the speakers under it. */
export const PHONE_DOMINANT_HEIGHT = 186;

export interface StageLayoutProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  header: React.ReactNode;
  /** The screen share or the focused speaker. Absent means speakers only. */
  dominant?: React.ReactNode;
  /** The speaker strip, or the speakers-only grid when there is no dominant tile. */
  speakers?: React.ReactNode;
  /**
   * One true line about the call, under the header — a reconnect, say. It sits
   * above the tiles rather than replacing them, so a live share survives a
   * blip instead of being torn down and rebuilt.
   */
  notice?: React.ReactNode;
  /** Absent while you are not in the room yet — there is nothing to control. */
  controls?: React.ReactNode;
  /** The room's text channel: a 336px plate beside the Stage, a sheet on phone. */
  ribbon?: React.ReactNode;
  /** 390×844 arrangement: share on top, 2×2 speakers, controls, chat sheet. */
  phone?: boolean;
}

/**
 * StageLayout — the in-call surface (docs/lantern-stage-spec.md §7.2).
 *
 * Desktop: a plate holding the header, the dominant tile, the speaker strip and
 * the centred control bar, with the chat ribbon beside it on the 12px gutter.
 * Phone: the share on top, a 2×2 of speakers, the controls, then the chat sheet.
 *
 * Presentational: every region arrives as a node. The Stage decides where things
 * sit, never what they are.
 */
export const StageLayout = React.forwardRef<HTMLDivElement, StageLayoutProps>(
  function StageLayout(
    { header, dominant, speakers, notice, controls, ribbon, phone = false, className, ...props },
    ref,
  ) {
    if (phone) {
      return (
        <div
          ref={ref}
          data-native-underlay-clear=""
          className={cn(
            'flex min-h-0 flex-1 flex-col gap-2.5 overflow-hidden px-3 pt-2',
            className,
          )}
          {...props}
        >
          {header}
          {notice}
          {dominant && (
            <div className="shrink-0" style={{ height: PHONE_DOMINANT_HEIGHT }}>
              {dominant}
            </div>
          )}
          {speakers && <div className={cn(dominant ? 'shrink-0' : 'min-h-0 flex-1')}>{speakers}</div>}
          {controls && <div className="shrink-0 pb-0.5 pt-1.5">{controls}</div>}
          {ribbon}
        </div>
      );
    }

    return (
      <div
        ref={ref}
        data-native-underlay-clear=""
        className={cn('flex min-h-0 flex-1 gap-[var(--gutter)] overflow-hidden', className)}
        {...props}
      >
        <Plate
          as="main"
          bare
          data-native-underlay-clear=""
          className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--gutter)] overflow-hidden px-4 py-3.5"
        >
          {header}
          {notice}
          <div
            className="grid min-h-0 flex-1 gap-[var(--gutter)]"
            style={{
              gridTemplateRows: speakers && dominant
                ? `minmax(0, 1fr) ${SPEAKER_STRIP_HEIGHT}px`
                : 'minmax(0, 1fr)',
            }}
          >
            {dominant ?? speakers}
            {dominant && speakers ? speakers : null}
          </div>
          {controls}
        </Plate>
        {ribbon}
      </div>
    );
  },
);
