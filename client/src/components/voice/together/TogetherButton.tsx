import { useRef, useState, type RefObject } from 'react';
import { Clapperboard } from 'lucide-react';

import { IconButton, Tooltip } from '../../ui';
import { TogetherSheet } from './TogetherSheet';
import { useTogether } from './useTogether';

/**
 * The call's Together button: opens the sheet to start watching or listening
 * together, or to add to the queue of the session already playing.
 */
export function TogetherButton() {
  const together = useTogether();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!together) return null;
  const { session } = together;
  const label = session ? 'Add to what is playing together' : 'Watch or listen together';
  return (
    <>
      <Tooltip content={label} side="top">
        <IconButton
          ref={anchor}
          label={label}
          size="stage"
          tone="raised"
          active={open}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          data-testid="together-button"
        >
          <Clapperboard size={20} />
        </IconButton>
      </Tooltip>
      <TogetherSheet
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        guildId={together.guildId}
        channelId={together.channelId}
        api={together.api}
        session={session}
        selfUserId={together.selfUserId}
      />
    </>
  );
}

/**
 * The same sheet opened from somewhere else (the phone Stage keeps it in the
 * header's menu, because its control bar has no room for another button).
 */
export function TogetherSheetFor({
  anchor,
  open,
  onClose,
}: {
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  const together = useTogether();
  if (!together) return null;
  return (
    <TogetherSheet
      anchor={anchor}
      open={open}
      onClose={onClose}
      guildId={together.guildId}
      channelId={together.channelId}
      api={together.api}
      session={together.session}
      selfUserId={together.selfUserId}
      side="bottom"
    />
  );
}
