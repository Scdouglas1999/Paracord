import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { Search, User, UserPlus, Users } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { activateChannel } from '../../lib/channelNavigation';
import type { ScopedChannel } from '../../lib/channelScope';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { extractApiError } from '../../api/client';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { Modal, ModalTitle } from '../ui/Modal';
import { Input } from '../ui/Input';
import type { Channel } from '../../types/index';
import { displayName } from '../../lib/displayName';
import { GROUP_DM_LIMITATION } from '../../lib/messages/messagingReadiness';


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
 * Reuses the lantern-stage-spec §8 dialog recipe (`ui/Modal`: bg --bg-accent, --radius-plate,
 * --border-strong, --shadow-plate, 240ms enter + focus trap), Button and EmptyState.
 * Consumed by HomePage and the sidebar search "new DM" affordance.
 */
export function DmPickerModal({ open, onClose, onCreated }: DmPickerModalProps) {
  const navigate = useNavigate();
  const scope = useCurrentAccountScope();
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);

  const [groupMode, setGroupMode] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Each open starts fresh and refreshes the friend list.
  useEffect(() => {
    if (!open) return;
    setGroupMode(false);
    setQuery('');
    setError(null);
    setSubmitting(false);
    void fetchRelationships();
  }, [open, fetchRelationships]);

  const friends = relationships.filter((r) => r.type === 1);
  const filteredFriends = friends.filter((relationship) => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return true;
    return displayName(relationship.user).toLocaleLowerCase().includes(normalized)
      || relationship.user.username.toLocaleLowerCase().includes(normalized);
  });

  const commitChannel = (channel: ScopedChannel) => {
    activateChannel(channel);
    onCreated?.(channel);
    onClose();
    navigate(`/app/dms/${channel.id}`);
  };

  const startDm = async (userId: string) => {
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      if (!scope) throw new Error('Sign in to this server before messaging.');
      const data = await useChannelStore.getState().createDm(userId, scope);
      commitChannel(data);
    } catch (err) {
      setError(extractApiError(err) || 'Failed to start this direct message.');
    } finally {
      setSubmitting(false);
    }
  };

  // Group creation used to live here. It is gone rather than disabled: a group
  // this release can create but never send in is a dead end, and the tab now
  // says so before anything exists. `channelStore.createGroupDm` stays for the
  // day the group encryption migration ships.

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy="dm-picker-title"
      size="sm"
      placement="center"
      panelClassName="flex max-h-[70vh] flex-col"
    >
      <div className="panel-divider border-b px-5 py-4">
        <ModalTitle id="dm-picker-title">New message</ModalTitle>
        <p className="mt-1 text-meta text-text-secondary">
          {groupMode ? 'Not in this release — here is why.' : 'Choose a friend to start or reopen a conversation.'}
        </p>
        <div role="tablist" aria-label="Message type" className="pc-well mt-3 grid grid-cols-2 gap-1 p-1">
          <button
            type="button"
            role="tab"
            aria-selected={!groupMode}
            className={cn(
              'pc-focusable flex h-[var(--h-control)] items-center justify-center gap-1.5 rounded-[var(--radius-chip)] text-label transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
              !groupMode
                ? 'bg-bg-raised font-semibold text-text-primary shadow-[var(--shadow-raised)]'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
            )}
            onClick={() => {
              setGroupMode(false);
              setError(null);
            }}
          >
            <User size={14} /> Direct
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={groupMode}
            className={cn(
              'pc-focusable flex h-[var(--h-control)] items-center justify-center gap-1.5 rounded-[var(--radius-chip)] text-label transition-[background-color,color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)]',
              groupMode
                ? 'bg-bg-raised font-semibold text-text-primary shadow-[var(--shadow-raised)]'
                : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary',
            )}
            onClick={() => {
              setGroupMode(true);
              setError(null);
            }}
          >
            <Users size={14} /> Group
          </button>
        </div>
      </div>

      {/* The limitation belongs BEFORE the group exists, not in the composer of
          the dead conversation it would have created. */}
      {groupMode ? (
        <div className="p-5">
          <div className="rounded-[var(--radius-well)] bg-bg-well px-3.5 py-3 shadow-[var(--shadow-well)]">
            <p className="pc-display text-name text-text-primary">Group conversations aren’t ready yet</p>
            <p className="mt-1 break-words text-body text-text-body">{GROUP_DM_LIMITATION}</p>
            <p className="mt-2 break-words text-meta text-text-faint">
              Start a direct message instead, or open a room in a building for more than two people.
            </p>
          </div>
        </div>
      ) : (<>
      <div className="border-b border-border-subtle px-5 py-3">
        <div className="relative">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <Input
            type="search"
            aria-label="Search friends"
            placeholder="Search friends"
            className="pl-9"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 scrollbar-thin">
        {friends.length === 0 ? (
          <EmptyState
            className="px-2"
            icon={<UserPlus size={20} />}
            title="No friends to message yet"
            description="Add a friend first — you can only DM people you're friends with."
          />
        ) : filteredFriends.length === 0 ? (
          <EmptyState
            className="px-2"
            icon={<Search size={20} />}
            title="No friends found"
            description={`No friends match “${query.trim()}”.`}
          />
        ) : (
          filteredFriends.map((rel) => (
            <button
              key={rel.id}
              type="button"
              className="pc-focusable group w-full rounded-[var(--radius-control)] px-3 py-2 text-left text-label font-medium transition-[background-color,box-shadow] duration-[var(--duration-fast)] ease-[var(--ease-out)] hover:bg-bg-mod-subtle"
              onClick={() => void startDm(rel.user.id)}
            >
              <div className="flex items-center gap-2.5">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-meta font-semibold text-text-secondary">
                  {displayName(rel.user).charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-label text-text-primary">{displayName(rel.user)}</span>
                  <span className="block truncate text-meta font-normal text-text-muted">@{rel.user.username}</span>
                </span>
                <span className="text-meta font-medium text-accent-primary opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">Message</span>
              </div>
            </button>
          ))
        )}
      </div>
      </>)}

      {error && (
        <div
          role="alert"
          className="mx-3 mb-3 rounded-[var(--radius-well)] bg-danger-well px-3.5 py-2.5 text-label font-medium leading-relaxed text-accent-danger shadow-[var(--shadow-well)]"
        >
          {error}
        </div>
      )}

      {groupMode && (
        <div className="border-t border-border-subtle p-3">
          <Button className="w-full" variant="ghost" onClick={() => { setGroupMode(false); setError(null); }}>
            Start a direct message instead
          </Button>
        </div>
      )}
    </Modal>
  );
}
