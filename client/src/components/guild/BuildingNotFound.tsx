import { Compass } from 'lucide-react';

import { Button, Plate } from '../ui';

/**
 * A building you cannot open (docs/lantern-stage-spec.md §6.9, §7.3).
 *
 * A stale or not-for-you link is the most ordinary way to arrive at a building
 * that is not yours, and it used to land on an indefinite skeleton behind two
 * toasts reading "Failed to load members: forbidden". This is the same recipe
 * the channel route already uses: a line mark in a tinted well, a Gabarito
 * title, copy that does not leak whether the building exists, and one way back.
 */
export function BuildingNotFound({ onGoHome }: { onGoHome: () => void }) {
  return (
    <div className="h-full bg-bg-base p-[var(--gutter)]">
      <Plate
        as="section"
        aria-label="Server not found"
        className="flex h-full items-center px-6 sm:px-10"
      >
        <div className="w-full max-w-md">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-chip bg-accent-tint text-accent-primary">
            <Compass size={20} strokeWidth={2} aria-hidden />
          </div>
          <h2 className="font-display text-heading text-text-primary">
            This server isn&rsquo;t yours to open
          </h2>
          <p className="mt-2 max-w-prose text-body text-text-secondary">
            It may have closed, or you may not have been let in. Ask whoever sent you the link
            for a fresh invite — or head back to your own street.
          </p>
          <div className="mt-6">
            <Button onClick={onGoHome}>Back to your servers</Button>
          </div>
        </div>
      </Plate>
    </div>
  );
}
