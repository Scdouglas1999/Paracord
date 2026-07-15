import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LogOut, UserMinus, UserPlus, Users, X } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useAuthStore } from '../../stores/authStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { dmApi } from '../../api/dms';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';
import { confirm } from '../../stores/confirmStore';
import { toast } from '../../stores/toastStore';

interface GroupDmMembersPanelProps {
  channelId: string;
  onClose: () => void;
}

/**
 * Group-DM recipient surface for the ContextPanel `members` mode (layout-spec §2:
 * the bespoke DMPage member <aside> is retired; recipients stay reachable and
 * manageable through the shared right panel). Self-chromed like the other
 * overlay-style ContextPanel surfaces (its own header + Add toggle + close).
 */
export function GroupDmMembersPanel({ channelId, onClose }: GroupDmMembersPanelProps) {
  const navigate = useNavigate();
  const dmChannels = useChannelStore((s) => s.channelsByGuild['']);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const dmChannel = (dmChannels ?? []).find((c) => c.id === channelId);
  const currentUser = useAuthStore((s) => s.user);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const [addingMember, setAddingMember] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);

  useEffect(() => {
    setAddingMember(false);
    setMemberActionError(null);
  }, [channelId]);

  useEffect(() => {
    if (addingMember) {
      void fetchRelationships();
    }
  }, [addingMember, fetchRelationships]);

  const handleAddMember = async (userId: string) => {
    setMemberActionError(null);
    try {
      await dmApi.addRecipient(channelId, userId);
      const { data: recipients } = await dmApi.listRecipients(channelId);
      const updated = (dmChannels ?? []).map((c) =>
        c.id === channelId ? { ...c, recipients } : c,
      );
      setDmChannels(updated);
      setAddingMember(false);
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to add member to this group DM.');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setMemberActionError(null);
    try {
      await dmApi.removeRecipient(channelId, userId);
      const { data: recipients } = await dmApi.listRecipients(channelId);
      const updated = (dmChannels ?? []).map((c) =>
        c.id === channelId ? { ...c, recipients } : c,
      );
      setDmChannels(updated);
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to remove member from this group DM.');
    }
  };

  const handleLeaveGroup = async () => {
    if (!currentUser?.id) return;
    const ok = await confirm({
      title: 'Leave group DM?',
      description: 'You will no longer see this conversation unless someone adds you back.',
      confirmLabel: 'Leave group',
      variant: 'danger',
    });
    if (!ok) return;
    setMemberActionError(null);
    try {
      await dmApi.removeRecipient(channelId, currentUser.id);
      const remaining = (dmChannels ?? []).filter((c) => c.id !== channelId);
      setDmChannels(remaining);
      onClose();
      toast.success('Left the group DM.');
      navigate('/app/dms');
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to leave this group DM.');
    }
  };

  const eligibleFriends = relationships.filter(
    (r) => r.type === 1 && !dmChannel?.recipients?.some((rec) => rec.id === r.user.id),
  );
  const isMember = Boolean(
    currentUser?.id && dmChannel?.recipients?.some((r) => r.id === currentUser.id),
  );

  return (
    <aside
      role="complementary"
      aria-label="Members"
      className="flex h-full shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-bg-secondary shadow-sm"
      style={{ width: 'var(--member-list-width)' }}
      data-testid="context-panel"
      data-mode="members"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-3">
        <Users size={18} className="shrink-0 text-text-secondary" aria-hidden />
        <h2 className="min-w-0 flex-1 truncate text-subhead text-text-primary">Members</h2>
        <button
          type="button"
          className="rounded-sm px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => {
            setMemberActionError(null);
            setAddingMember((v) => !v);
          }}
        >
          {addingMember ? 'Cancel' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
          aria-label="Close Members panel"
        >
          <X size={18} aria-hidden />
        </button>
      </header>

      {memberActionError && (
        <div
          role="alert"
          className="mx-4 mt-3 rounded-md border border-accent-danger/35 bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger"
        >
          {memberActionError}
        </div>
      )}

      {addingMember && (
        <div className="border-b border-border-subtle p-2">
          <div className="px-2 pb-1.5 text-section uppercase text-text-muted">Add from friends</div>
          {eligibleFriends.map((rel) => (
            <button
              key={rel.id}
              type="button"
              className="flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]"
              onClick={() => void handleAddMember(rel.user.id)}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-bg-mod-subtle text-text-secondary">
                <UserPlus size={13} />
              </span>
              <span className="min-w-0 flex-1 truncate text-label text-text-secondary">{displayName(rel.user)}</span>
            </button>
          ))}
          {eligibleFriends.length === 0 && (
            <div className="px-2 py-3 text-meta leading-relaxed text-text-muted">
              Everyone on your friends list is already in this conversation.
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        {dmChannel?.recipients?.map((recipient) => (
          <div
            key={recipient.id}
            className="group flex items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-bg-mod-subtle"
          >
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-tint text-meta font-semibold text-accent-primary">
              {recipient.username.charAt(0).toUpperCase()}
            </div>
            <span className="min-w-0 flex-1 truncate text-label text-text-secondary">{recipient.username}</span>
            {dmChannel.owner_id === currentUser?.id && recipient.id !== currentUser?.id && (
              <button
                type="button"
                aria-label={`Remove ${recipient.username} from group DM`}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-100 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-accent-danger focus-visible:shadow-[var(--focus-ring)] sm:opacity-0 sm:focus-visible:opacity-100 sm:group-hover:opacity-100"
                onClick={() => void handleRemoveMember(recipient.id)}
                title="Remove from group"
              >
                <UserMinus size={14} />
              </button>
            )}
          </div>
        ))}
      </div>

      {isMember && (
        <div className="shrink-0 border-t border-border-subtle p-3">
          <button
            type="button"
            onClick={() => void handleLeaveGroup()}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-sm border border-accent-danger/30 text-label font-medium text-accent-danger outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)]"
          >
            <LogOut size={16} />
            Leave group
          </button>
        </div>
      )}
    </aside>
  );
}
