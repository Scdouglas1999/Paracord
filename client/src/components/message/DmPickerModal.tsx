import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check, UserPlus } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { dmApi } from '../../api/dms';
import { extractApiError } from '../../api/client';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { Modal, ModalTitle } from '../ui/Modal';
import type { Channel } from '../../types/index';

const EMPTY_CHANNELS: Channel[] = [];

export interface DmPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Fired with the created/opened channel after a DM or group DM is started. */
  onCreated?: (channel: Channel) => void;
}

/**
 * Standalone DM-picker dialog lifted out of the former Home DM list. Lists the
 * viewer's friends, and on selection opens (or creates) a DM via `dmApi.create`,
 * updates `channelStore`, navigates to `/app/dms/:id`, fires `onCreated`, then
 * closes. A group-DM sub-mode is preserved from the original picker.
 *
 * Reuses the design-spec §7 Modal recipe (`ui/Modal`: bg --bg-accent, --radius-lg,
 * --border-strong, --shadow-xl, 240ms enter + focus trap), Button and EmptyState.
 * Consumed by HomePage and the sidebar search "new DM" affordance.
 */
export function DmPickerModal({ open, onClose, onCreated }: DmPickerModalProps) {
  const navigate = useNavigate();
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);

  const [groupMode, setGroupMode] = useState(false);
  const [groupSelected, setGroupSelected] = useState<string[]>([]);
  const [groupName, setGroupName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Each open starts fresh and refreshes the friend list.
  useEffect(() => {
    if (!open) return;
    setGroupMode(false);
    setGroupSelected([]);
    setGroupName('');
    setError(null);
    setSubmitting(false);
    void fetchRelationships();
  }, [open, fetchRelationships]);

  const friends = relationships.filter((r) => r.type === 1);

  const commitChannel = (channel: Channel) => {
    const next = dmChannels.some((c) => c.id === channel.id)
      ? dmChannels
      : [...dmChannels, channel];
    setDmChannels(next);
    selectChannel(channel.id);
    onCreated?.(channel);
    onClose();
    navigate(`/app/dms/${channel.id}`);
  };

  const startDm = async (userId: string) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await dmApi.create(userId);
      commitChannel(data);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to start this direct message.');
    } finally {
      setSubmitting(false);
    }
  };

  const createGroup = async () => {
    if (submitting || groupSelected.length === 0) return;
    setError(null);
    setSubmitting(true);
    try {
      const { data } = await dmApi.createGroup(groupSelected, groupName || undefined);
      commitChannel(data);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to create this group DM.');
    } finally {
      setSubmitting(false);
    }
  };

  const toggleGroupMember = (userId: string) => {
    setGroupSelected((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="dm-picker-title"
      size="sm"
      placement="center"
      panelClassName="flex max-h-[70vh] flex-col"
    >
      <div className="panel-divider flex items-center justify-between border-b px-5 py-4">
        <ModalTitle id="dm-picker-title">
          {groupMode ? 'Create Group DM' : 'Start Direct Message'}
        </ModalTitle>
        <button
          type="button"
          className="rounded-sm px-1 text-meta font-semibold text-accent-primary outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => {
            setGroupMode((m) => !m);
            setGroupSelected([]);
            setGroupName('');
            setError(null);
          }}
        >
          {groupMode ? 'Single DM' : 'Group DM'}
        </button>
      </div>

      {groupMode && (
        <div className="border-b border-border-subtle px-5 py-3">
          <input
            type="text"
            placeholder="Group name (optional)"
            className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] placeholder:text-text-muted focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
            value={groupName}
            onChange={(e) => setGroupName(e.target.value)}
          />
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {friends.length === 0 ? (
          <EmptyState
            className="px-2"
            icon={<UserPlus size={20} />}
            title="No friends to message yet"
            description="Add a friend first — you can only DM people you're friends with."
          />
        ) : (
          friends.map((rel) => {
            const selected = groupSelected.includes(rel.user.id);
            return (
              <button
                key={rel.id}
                type="button"
                className={cn(
                  'w-full rounded-sm px-3 py-2 text-left text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]',
                  groupMode && selected && 'bg-accent-tint text-accent-primary',
                )}
                onClick={() => {
                  if (groupMode) {
                    toggleGroupMember(rel.user.id);
                  } else {
                    void startDm(rel.user.id);
                  }
                }}
              >
                <div className="flex items-center gap-2">
                  {groupMode && (
                    <div
                      className={cn(
                        'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border',
                        selected
                          ? 'border-accent-primary bg-accent-primary text-text-on-accent'
                          : 'border-border-subtle',
                      )}
                    >
                      {selected && <Check size={12} strokeWidth={3} aria-hidden />}
                    </div>
                  )}
                  <span className="text-label text-text-primary">{rel.user.username}</span>
                </div>
              </button>
            );
          })
        )}
      </div>

      {error && (
        <div
          role="alert"
          className="mx-3 mb-3 rounded-sm border border-accent-danger/40 bg-danger-tint px-3 py-2 text-label font-medium text-accent-danger"
        >
          {error}
        </div>
      )}

      {groupMode && groupSelected.length > 0 && (
        <div className="border-t border-border-subtle p-3">
          <Button className="w-full" loading={submitting} onClick={() => void createGroup()}>
            Create Group DM ({groupSelected.length + 1} members)
          </Button>
        </div>
      )}
    </Modal>
  );
}
