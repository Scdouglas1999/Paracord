import { useCallback } from 'react';
import { Clock } from 'lucide-react';
import { useNavigate } from 'react-router';
import type { ReminderItem } from '../../../api/reminders';
import { RemindersPane } from '../../layout/overlays/RemindersPane';
import { SheetFrame } from './SheetFrame';
import { SheetEmpty } from './SheetParts';

/**
 * Reminders (the account menu's row): due first (Done, Snooze 1 h), then
 * upcoming (Change, Cancel). Opening one goes to its message.
 */
export function RemindersSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const openReminder = useCallback(
    (item: ReminderItem) => {
      const query = `?message=${encodeURIComponent(item.message.id)}`;
      onClose();
      navigate(
        item.channel.guild_id
          ? `/app/guilds/${item.channel.guild_id}/channels/${item.channel.id}${query}`
          : `/app/dms/${item.channel.id}${query}`,
      );
    },
    [navigate, onClose],
  );

  return (
    <SheetFrame
      open={open}
      onClose={onClose}
      kind="reminders"
      label="Reminders"
      title="Reminders"
      subtitle="Messages you asked to be reminded of"
      closeLabel="Close reminders"
    >
      <RemindersPane
        onOpen={openReminder}
        empty={
          <SheetEmpty icon={<Clock size={20} />} title="No reminders">
            Choose Remind me on a message and it will come back here when it is due.
          </SheetEmpty>
        }
      />
    </SheetFrame>
  );
}
