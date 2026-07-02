import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { MessageCircleMore, Users, UserMinus } from 'lucide-react';
import { TopBar } from '../components/layout/TopBar';
import { MessageList } from '../components/message/MessageList';
import { MessageInput } from '../components/message/MessageInput';
import { useChannelStore } from '../stores/channelStore';
import { useAuthStore } from '../stores/authStore';
import { useRelationshipStore } from '../stores/relationshipStore';
import { dmApi } from '../api/dms';
import { extractApiError } from '../api/client';
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
      <div className="flex h-full min-h-0 flex-col">
        <TopBar isDM recipientName="Direct Messages" />
        <div className="relative flex flex-1 items-center justify-center overflow-hidden p-4 md:p-6">
          <div className="pointer-events-none absolute -top-14 left-1/2 h-44 w-44 -translate-x-1/2 rounded-full blur-3xl" style={{ backgroundColor: 'var(--ambient-glow-primary)' }} />
          <div className="relative flex w-full max-w-xl flex-col items-center rounded-2xl border border-border-subtle bg-bg-mod-subtle/70 px-8 py-8 text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl border border-border-subtle bg-bg-primary/70 text-text-secondary">
              <MessageCircleMore size={21} />
            </div>
            <div className="text-base font-semibold text-text-primary">Select a conversation</div>
            <p className="mt-1 text-sm leading-6 text-text-secondary">
              Pick an existing DM from the left rail, or start a new one from your friends list.
            </p>
            <div className="mt-4 flex items-center gap-3">
              <button className="btn-primary" onClick={() => navigate('/app/friends')}>
                Browse Friends
              </button>
              <button
                className="rounded-lg border border-border-subtle bg-bg-mod-subtle px-3.5 py-2 text-sm font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
                onClick={() => navigate('/app/friends')}
              >
                Start New DM
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar isDM recipientName={recipientName} dmChannelId={channelId} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {isGroupDM && (
            <div className="flex justify-end px-3 pt-2">
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border-subtle bg-bg-mod-subtle px-3 text-xs font-semibold text-text-secondary transition-colors hover:bg-bg-mod-strong hover:text-text-primary"
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
          <div className="flex h-full w-60 shrink-0 flex-col border-l border-border-subtle bg-bg-secondary">
            <div className="border-b border-border-subtle px-4 py-3">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text-primary">Members</span>
                <button
                  className="rounded px-2 py-1 text-xs font-medium text-accent-primary hover:bg-accent-primary/10"
                  onClick={() => {
                    setMemberActionError(null);
                    setAddingMember(!addingMember);
                  }}
                >
                  {addingMember ? 'Cancel' : 'Add'}
                </button>
              </div>
              {memberActionError && (
                <div role="alert" className="mt-3 rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-xs font-medium text-accent-danger">
                  {memberActionError}
                </div>
              )}
            </div>

            {addingMember && (
              <div className="border-b border-border-subtle p-2">
                <div className="text-xs font-semibold uppercase tracking-wide text-text-muted px-2 pb-1">Add from friends</div>
                {relationships
                  .filter((r) => r.type === 1 && !dmChannel?.recipients?.some((rec) => rec.id === r.user.id))
                  .map((rel) => (
                    <button
                      key={rel.id}
                      className="w-full rounded px-2 py-1.5 text-left text-sm text-text-secondary transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                      onClick={() => void handleAddMember(rel.user.id)}
                    >
                      {rel.user.username}
                    </button>
                  ))}
                {relationships.filter((r) => r.type === 1 && !dmChannel?.recipients?.some((rec) => rec.id === r.user.id)).length === 0 && (
                  <div className="rounded px-2 py-3 text-xs text-text-muted">No eligible friends to add.</div>
                )}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-2">
              {dmChannel?.recipients?.map((recipient) => (
                <div key={recipient.id} className="group flex items-center gap-2 rounded px-2 py-1.5">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-xs font-semibold text-text-primary">
                    {recipient.username.charAt(0).toUpperCase()}
                  </div>
                  <span className="flex-1 truncate text-sm text-text-secondary">{recipient.username}</span>
                  {dmChannel.owner_id === currentUser?.id && recipient.id !== currentUser?.id && (
                    <button
                      aria-label={`Remove ${recipient.username} from group DM`}
                      className="hidden text-text-muted transition-colors hover:text-accent-danger group-hover:block"
                      onClick={() => void handleRemoveMember(recipient.id)}
                      title="Remove from group"
                    >
                      <UserMinus size={14} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
