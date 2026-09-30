import { useCurrentChannelStore } from '../../hooks/useChannels';
import { useCurrentUser } from '../../hooks/useCurrentUser';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LogOut, UserMinus, UserPlus } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useCurrentAccountScope } from '../../hooks/useCurrentUser';
import { extractApiError } from '../../api/client';
import { displayName } from '../../lib/displayName';
import { confirm } from '../../stores/confirmStore';
import { toast } from '../../stores/toastStore';
import { statusLine } from '../../lib/activityDisplay';
import { presenceLabel } from '../../lib/presence';
import { usePresenceStore } from '../../stores/presenceStore';
import { GlassButton } from '../glass/primitives';
import { PersonRow } from '../glass/sheets/PersonRow';
import { SheetAlert, SheetKicker } from '../glass/sheets/SheetParts';

interface GroupDmMembersPanelProps {
  channelId: string;
  onClose: () => void;
}

/**
 * Who a group message is addressed to, and the one place that list is editable.
 * It is the group's page inside the people sheet (`glass/sheets/PeopleSheet`,
 * which supplies the frame, the title and the close button): each person with
 * their presence and what they are doing, an Add toggle, a remove control on
 * hover for the owner, and Leave group. Adding and removing a recipient is a
 * thing you do to the conversation, not a way to look at who is around.
 */
export function GroupDmMembersPanel({ channelId, onClose }: GroupDmMembersPanelProps) {
  const navigate = useNavigate();
  const dmChannels = useCurrentChannelStore((s) => s.channelsByGuild['']);
  const scope = useCurrentAccountScope();
  const dmChannel = (dmChannels ?? []).find((c) => c.id === channelId);
  const currentUser = useCurrentUser();
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  // Read through the store's own index; `presences` is subscribed so a change re-renders.
  usePresenceStore((state) => state.presences);
  const getPresence = usePresenceStore.getState().getPresence;
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
      if (!scope) throw new Error('Sign in to this instance before continuing.');
      await useChannelStore.getState().changeDmRecipient(channelId, userId, true, scope);
      setAddingMember(false);
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to add member to this group DM.');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    setMemberActionError(null);
    try {
      if (!scope) throw new Error('Sign in to this instance before continuing.');
      await useChannelStore.getState().changeDmRecipient(channelId, userId, false, scope);
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
      if (!scope) throw new Error('Sign in to this instance before continuing.');
      await useChannelStore.getState().changeDmRecipient(channelId, currentUser.id, false, scope);
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

  const owner = dmChannel?.owner_id === currentUser?.id;

  return (
    <div data-testid="group-dm-people" data-mode="recipients">
      <div className="glass-people__bar">
        <GlassButton
          variant="glass"
          onClick={() => {
            setMemberActionError(null);
            setAddingMember((v) => !v);
          }}
          pressed={addingMember}
        >
          {addingMember ? 'Cancel' : 'Add'}
        </GlassButton>
      </div>

      {memberActionError && <SheetAlert>{memberActionError}</SheetAlert>}

      {addingMember && (
        <section aria-label="Add from friends">
          <SheetKicker>Add from friends</SheetKicker>
          <ul className="glass-sheet-list">
            {eligibleFriends.map((rel) => (
              <li key={rel.id}>
                <button
                  type="button"
                  className="glass-sheet-row glass-focusable"
                  onClick={() => void handleAddMember(rel.user.id)}
                >
                  <span className="glass-sheet-row__lead" aria-hidden>
                    <UserPlus size={16} />
                  </span>
                  <span className="glass-sheet-row__name">{displayName(rel.user)}</span>
                </button>
              </li>
            ))}
          </ul>
          {eligibleFriends.length === 0 && (
            <p className="glass-sheet-line">Everyone on your friends list is already in this conversation.</p>
          )}
        </section>
      )}

      <section aria-label="People">
        <SheetKicker>
          In this message <span className="glass-instrument">{dmChannel?.recipients?.length ?? 0}</span>
        </SheetKicker>
        <ul className="glass-sheet-list">
          {dmChannel?.recipients?.map((recipient) => {
            const presence = getPresence(recipient.id, scope?.serverId);
            const status = presence?.status === 'online' || presence?.status === 'idle' || presence?.status === 'dnd'
              ? presence.status
              : 'offline';
            const line = statusLine(presence);
            const name = displayName(recipient);
            return (
              <PersonRow
                key={recipient.id}
                userId={recipient.id}
                name={name}
                you={recipient.id === currentUser?.id}
                avatar={recipient.avatar_hash ?? null}
                status={status}
                detail={line ? (line.type === 'custom' ? line.text : line.activity.line) : presenceLabel(status)}
                trailing={
                  owner && recipient.id !== currentUser?.id ? (
                    <button
                      type="button"
                      aria-label={`Remove ${recipient.username} from group DM`}
                      className="glass-sheet-row__action glass-focusable"
                      data-tone="danger"
                      onClick={() => void handleRemoveMember(recipient.id)}
                      title="Remove from group"
                    >
                      <UserMinus size={15} aria-hidden />
                    </button>
                  ) : undefined
                }
              />
            );
          })}
        </ul>
      </section>

      {isMember && (
        <div className="glass-people__leave">
          <GlassButton variant="text" onClick={() => void handleLeaveGroup()}>
            <LogOut size={16} aria-hidden />
            Leave group
          </GlassButton>
        </div>
      )}
    </div>
  );
}
