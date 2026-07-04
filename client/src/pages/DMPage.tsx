import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageCircleMore, Users, UserMinus, UserPlus } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { useChannelStore } from '../stores/channelStore';
import { useAuthStore } from '../stores/authStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
import { EmptyState } from '../components/ui/Feedback';
import { Button } from '../components/ui/Button';
import type { Channel, Message } from '../types';

const EMPTY_CHANNELS: Channel[] = [];

export function DMPage() {
  const { channelId } = useParams();
  const navigate = useNavigate();
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const dmChannel = dmChannels.find((c) => c.id === channelId);
  const currentUser = useAuthStore((s) => s.user);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; content: string } | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [addingMember, setAddingMember] = useState(false);
  const [memberActionError, setMemberActionError] = useState<string | null>(null);

  const isGroupDM = dmChannel?.channel_type === 3 || dmChannel?.type === 3;
  const recipientName = isGroupDM
    ? (dmChannel?.name || dmChannel?.recipients?.map((r) => r.username).join(', ') || 'Group DM')
    : (dmChannel?.recipient?.username || 'Direct Message');

  useEffect(() => {
    setReplyingTo(null);
    setShowMembers(false);
    setMemberActionError(null);
  }, [channelId]);

  useEffect(() => {
    if (showMembers && addingMember) {
      void fetchRelationships();
    }
  }, [showMembers, addingMember, fetchRelationships]);

  const handleAddMember = async (userId: string) => {
    if (!channelId) return;
    setMemberActionError(null);
    try {
      await dmApi.addRecipient(channelId, userId);
      // Refresh recipients by fetching from the API
      const { data: recipients } = await dmApi.listRecipients(channelId);
      const updated = dmChannels.map((c) =>
        c.id === channelId ? { ...c, recipients } : c
      );
      setDmChannels(updated);
      setAddingMember(false);
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to add member to this group DM.');
    }
  };

  const handleRemoveMember = async (userId: string) => {
    if (!channelId) return;
    setMemberActionError(null);
    try {
      await dmApi.removeRecipient(channelId, userId);
      const { data: recipients } = await dmApi.listRecipients(channelId);
      const updated = dmChannels.map((c) =>
        c.id === channelId ? { ...c, recipients } : c
      );
      setDmChannels(updated);
    } catch (err) {
      setMemberActionError(extractApiError(err) || 'Failed to remove member from this group DM.');
    }
  };

  if (!channelId) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-bg-primary">
        <TopBar isDM recipientName="Direct Messages" />
        <div className="flex flex-1 items-center justify-center overflow-hidden p-6">
          <div className="w-full max-w-md rounded-md border border-border-subtle bg-bg-secondary p-6 shadow-sm">
            <EmptyState
              className="px-0 py-0"
              icon={<MessageCircleMore size={20} />}
              title="Pick up a conversation"
              description="Choose a direct message from the left rail to jump back in, or start a fresh one from someone on your friends list."
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={() => navigate('/app/friends')}>Browse friends</Button>
                  <Button variant="secondary" onClick={() => navigate('/app/friends')}>
                    Start a new DM
                  </Button>
                </div>
              }
            />
          </div>
        </div>
      </div>
    );
  }

  const eligibleFriends = relationships.filter(
    (r) => r.type === 1 && !dmChannel?.recipients?.some((rec) => rec.id === r.user.id),
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-primary">
      <TopBar isDM recipientName={recipientName} dmChannelId={channelId} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isGroupDM && (
            <div className="flex justify-end border-b border-border-subtle px-3 py-2">
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-sm px-3 text-meta font-semibold text-text-secondary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
                onClick={() => setShowMembers(!showMembers)}
                title={showMembers ? 'Hide members' : 'Show members'}
              >
                <Users size={14} />
                {showMembers ? 'Hide Members' : 'Show Members'}
              </button>
            </div>
          )}
          <MessageList
            channelId={channelId}
            onReply={(msg: Message) =>
              setReplyingTo({
                id: msg.id,
                author: msg.author.username,
                content: msg.content || '',
              })
            }
          />
          <MessageInput channelId={channelId} replyingTo={replyingTo} onCancelReply={() => setReplyingTo(null)} />
        </div>

        {isGroupDM && showMembers && (
          <aside className="flex h-full w-64 shrink-0 flex-col border-l border-border-subtle bg-bg-secondary">
            <div className="border-b border-border-subtle px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-section uppercase text-text-muted">Members</span>
                <button
                  type="button"
                  className="rounded-sm px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-accent-tint focus-visible:shadow-[var(--focus-ring)]"
                  onClick={() => {
                    setMemberActionError(null);
                    setAddingMember(!addingMember);
                  }}
                >
                  {addingMember ? 'Cancel' : 'Add'}
                </button>
              </div>
              {memberActionError && (
                <div role="alert" className="mt-3 rounded-md border border-accent-danger/35 bg-danger-tint px-3 py-2 text-meta font-medium text-accent-danger">
                  {memberActionError}
                </div>
              )}
            </div>

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
                    <span className="min-w-0 flex-1 truncate text-label text-text-secondary">{rel.user.username}</span>
                  </button>
                ))}
                {eligibleFriends.length === 0 && (
                  <div className="px-2 py-3 text-meta leading-relaxed text-text-muted">No eligible friends to add.</div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-2 scrollbar-thin">
              {dmChannel?.recipients?.map((recipient) => (
                <div key={recipient.id} className="group flex items-center gap-2.5 rounded-sm px-2 py-1.5 transition-colors hover:bg-bg-mod-subtle">
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-tint text-meta font-semibold text-accent-primary">
                    {recipient.username.charAt(0).toUpperCase()}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-label text-text-secondary">{recipient.username}</span>
                  {dmChannel.owner_id === currentUser?.id && recipient.id !== currentUser?.id && (
                    <button
                      type="button"
                      aria-label={`Remove ${recipient.username} from group DM`}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-text-muted opacity-0 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-strong hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:opacity-100"
                      onClick={() => void handleRemoveMember(recipient.id)}
                      title="Remove from group"
                    >
                      <UserMinus size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
