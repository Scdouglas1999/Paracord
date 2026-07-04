import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, Home, Users, Plus, MessagesSquare } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useAuthStore } from '../../stores/authStore';
import { dmApi } from '../../api/dms';
import { extractApiError } from '../../api/client';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { UserPanel } from './UserPanel';
import { useVoice } from '../../hooks/useVoice';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isAdmin as isGlobalAdmin } from '../../types/index';
import type { Channel } from '../../types/index';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
  streaming: 'bg-status-streaming',
  offline: 'bg-status-offline',
};

const EMPTY_CHANNELS: Channel[] = [];

interface DmPickerModalShellProps {
  open: boolean;
  onClose: () => void;
  widthClass?: string;
  children: ReactNode;
}

function DmPickerModalShell({
  open,
  onClose,
  widthClass = 'w-full max-w-[480px]',
  children,
}: DmPickerModalShellProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, open, onClose);

  if (!open) return null;
  return (
    <>
      <div className="fixed inset-0 z-50 modal-backdrop" onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Direct message picker"
        tabIndex={-1}
        className={cn(
          'glass-modal fixed left-1/2 top-1/2 z-50 max-h-[70vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-lg',
          widthClass,
        )}
      >
        {children}
      </div>
    </>
  );
}

function PresenceStatusDot({ userId, className = '' }: { userId?: string; className?: string }) {
  const status = usePresenceStore((s) => {
    if (!userId) return 'offline';
    return s.getPresence(userId)?.status ?? 'offline';
  });
  const colorClass = STATUS_COLORS[status] || STATUS_COLORS.offline;
  return <div className={cn('rounded-full', colorClass, className)} />;
}

function PresenceStatusText({ userId, className = '' }: { userId?: string; className?: string }) {
  const status = usePresenceStore((s) => {
    if (!userId) return 'offline';
    return s.getPresence(userId)?.status ?? 'offline';
  });
  const label = status === 'dnd' ? 'Do Not Disturb' : status.charAt(0).toUpperCase() + status.slice(1);
  return <span className={className}>{label}</span>;
}

export function DMList() {
  const navigate = useNavigate();
  const location = useLocation();
  const dmChannels = useChannelStore((s) => s.channelsByGuild[''] ?? EMPTY_CHANNELS);
  const setDmChannels = useChannelStore((s) => s.setDmChannels);
  const selectedChannelId = useChannelStore((s) => s.selectedChannelId);
  const selectChannel = useChannelStore((s) => s.selectChannel);
  const user = useAuthStore((s) => s.user);
  const relationships = useRelationshipStore((s) => s.relationships);
  const fetchRelationships = useRelationshipStore((s) => s.fetchRelationships);
  const { selfMute, selfDeaf, toggleMute, toggleDeaf } = useVoice();
  const showAdminDashboardShortcut = Boolean(user && isGlobalAdmin(user.flags ?? 0));

  const [dmSearch, setDmSearch] = useState('');
  const [showDmPicker, setShowDmPicker] = useState(false);
  const [groupDmMode, setGroupDmMode] = useState(false);
  const [groupDmSelected, setGroupDmSelected] = useState<string[]>([]);
  const [groupDmName, setGroupDmName] = useState('');
  const [dmPickerError, setDmPickerError] = useState<string | null>(null);

  useEffect(() => {
    dmApi
      .list()
      .then(({ data }) => setDmChannels(data))
      .catch(() => {
        // ignore
      });
  }, [setDmChannels]);

  useEffect(() => {
    if (showDmPicker) {
      void fetchRelationships();
    }
  }, [showDmPicker, fetchRelationships]);

  const filteredDms = dmChannels.filter((dm) => {
    if (dm.channel_type === 3 || dm.type === 3) {
      const name = dm.name || (dm.recipients?.map((r) => r.username).join(', ') ?? 'Group DM');
      return name.toLowerCase().includes(dmSearch.toLowerCase());
    }
    return (dm.recipient?.username || 'Direct Message').toLowerCase().includes(dmSearch.toLowerCase());
  });

  const hasDms = dmChannels.length > 0;

  return (
    <div className="flex h-full flex-col bg-transparent text-text-secondary">
      <div className="panel-divider shrink-0 border-b px-4 pb-4 pt-5">
        <div className="text-section uppercase text-text-muted">Direct Messages</div>
        <h2 className="mb-3.5 mt-1 text-heading text-text-primary">Messages</h2>
        <div className="relative w-full">
          <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Find a conversation"
            className="h-10 w-full rounded-sm border border-border-subtle bg-bg-tertiary py-2 pl-9 pr-3 text-body text-text-primary placeholder:text-text-muted outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
            value={dmSearch}
            onChange={(e) => setDmSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3 scrollbar-thin">
        <button
          onClick={() => navigate('/app')}
          className={cn(
            'group relative flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
            location.pathname === '/app'
              ? 'bg-accent-tint text-text-primary'
              : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
          )}
        >
          {location.pathname === '/app' && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
          )}
          <Home size={18} className={location.pathname === '/app' ? 'text-accent-primary' : 'text-channel-icon'} />
          Home
        </button>
        <button
          onClick={() => navigate('/app/friends')}
          className={cn(
            'group relative mt-0.5 flex h-[34px] w-full items-center gap-2.5 rounded-sm px-2 text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
            location.pathname === '/app/friends'
              ? 'bg-accent-tint text-text-primary'
              : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
          )}
        >
          {location.pathname === '/app/friends' && (
            <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
          )}
          <Users size={18} className={location.pathname === '/app/friends' ? 'text-accent-primary' : 'text-channel-icon'} />
          Friends
        </button>

        <div className="group mb-1 mt-6 flex items-center justify-between px-2">
          <span className="text-section uppercase text-text-muted transition-colors group-hover:text-text-secondary">
            Direct Messages
          </span>
          <Tooltip content="Create DM" side="top">
            <button
              className="flex h-6 w-6 items-center justify-center rounded-sm text-text-muted outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] group-hover:text-text-secondary"
              aria-label="Create direct message"
              onClick={() => setShowDmPicker(true)}
            >
              <Plus size={16} />
            </button>
          </Tooltip>
        </div>

        {!hasDms ? (
          <EmptyState
            className="px-2"
            icon={<MessagesSquare size={20} />}
            title="Your DMs are quiet"
            description="Start a conversation from someone's profile or the search bar above — your recent chats will collect here."
            action={
              <Button size="sm" variant="secondary" onClick={() => navigate('/app/friends')}>
                <Users size={16} className="mr-1.5" />
                Find friends
              </Button>
            }
          />
        ) : filteredDms.length === 0 ? (
          <p className="px-2 py-6 text-body text-text-muted">
            No conversations match “{dmSearch.trim()}”.
          </p>
        ) : (
          <div className="mt-0.5 space-y-0.5">
            {filteredDms.map((dm) => {
              const isSelected = selectedChannelId === dm.id;
              const isGroup = dm.channel_type === 3 || dm.type === 3;
              return (
                <button
                  key={dm.id}
                  onClick={() => {
                    selectChannel(dm.id);
                    navigate(`/app/dms/${dm.id}`);
                  }}
                  className={cn(
                    'group relative flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                    isSelected
                      ? 'bg-accent-tint text-text-primary'
                      : 'text-text-secondary hover:bg-bg-mod-subtle hover:text-text-primary'
                  )}
                >
                  {isSelected && (
                    <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r-full bg-accent-secondary" />
                  )}
                  {isGroup ? (
                    <>
                      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong text-meta font-semibold text-text-secondary">
                        <MessagesSquare size={15} />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="truncate text-label font-medium">
                          {dm.name || dm.recipients?.map((r) => r.username).join(', ') || 'Group DM'}
                        </span>
                        <span className="truncate text-meta text-text-muted">{dm.recipients?.length ?? 0} members</span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="relative shrink-0">
                        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-bg-mod-strong text-meta font-semibold text-text-secondary">
                          {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                        </div>
                        <PresenceStatusDot userId={dm.recipient?.id} className="absolute -bottom-0.5 -right-0.5 h-3 w-3 ring-2 ring-bg-secondary" />
                      </div>
                      <div className="flex min-w-0 flex-1 flex-col items-start">
                        <span className="truncate text-label font-medium">{dm.recipient?.username || 'Direct Message'}</span>
                        <PresenceStatusText userId={dm.recipient?.id} className="truncate text-meta text-text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                      </div>
                    </>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <UserPanel
        user={user}
        navigate={navigate}
        muted={selfMute}
        deafened={selfDeaf}
        onToggleMute={toggleMute}
        onToggleDeaf={toggleDeaf}
        showAdminDashboard={showAdminDashboardShortcut}
      />

      <DmPickerModalShell
        open={showDmPicker}
        widthClass="w-full max-w-[480px]"
        onClose={() => {
          setShowDmPicker(false);
          setGroupDmMode(false);
          setGroupDmSelected([]);
          setGroupDmName('');
          setDmPickerError(null);
        }}
      >
        <div className="panel-divider flex items-center justify-between border-b px-5 py-4">
          <span className="text-subhead text-text-primary">
            {groupDmMode ? 'Create Group DM' : 'Start Direct Message'}
          </span>
          <button
            className="rounded-sm px-1 text-meta font-semibold text-accent-primary outline-none hover:underline focus-visible:shadow-[var(--focus-ring)]"
            onClick={() => {
              setGroupDmMode(!groupDmMode);
              setGroupDmSelected([]);
              setGroupDmName('');
              setDmPickerError(null);
            }}
          >
            {groupDmMode ? 'Single DM' : 'Group DM'}
          </button>
        </div>
        {groupDmMode && (
          <div className="border-b border-border-subtle px-5 py-3">
            <input
              type="text"
              placeholder="Group name (optional)"
              className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-3 py-2 text-body text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] placeholder:text-text-muted focus-visible:border-accent-primary focus-visible:shadow-[var(--focus-ring-input)]"
              value={groupDmName}
              onChange={(e) => setGroupDmName(e.target.value)}
            />
          </div>
        )}
        <div className="max-h-[40vh] overflow-y-auto p-3">
          {relationships.filter((r) => r.type === 1).map((rel) => (
            <button
              key={rel.id}
              className={cn(
                'w-full rounded-sm px-3 py-2 text-left text-label font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] hover:bg-bg-mod-subtle focus-visible:shadow-[var(--focus-ring)]',
                groupDmMode && groupDmSelected.includes(rel.user.id) && 'bg-accent-tint text-accent-primary'
              )}
              onClick={async () => {
                if (groupDmMode) {
                  setGroupDmSelected((prev) =>
                    prev.includes(rel.user.id)
                      ? prev.filter((id) => id !== rel.user.id)
                      : [...prev, rel.user.id]
                  );
                  return;
                }
                setDmPickerError(null);
                try {
                  const { data } = await dmApi.create(rel.user.id);
                  const current = useChannelStore.getState().channelsByGuild[''] || [];
                  const next = current.some((c) => c.id === data.id) ? current : [...current, data];
                  setDmChannels(next);
                  selectChannel(data.id);
                  setShowDmPicker(false);
                  navigate(`/app/dms/${data.id}`);
                } catch (err) {
                  setDmPickerError(extractApiError(err) || 'Failed to start this direct message.');
                }
              }}
            >
              <div className="flex items-center gap-2">
                {groupDmMode && (
                  <div className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border',
                    groupDmSelected.includes(rel.user.id)
                      ? 'border-accent-primary bg-accent-primary text-text-on-accent'
                      : 'border-border-subtle'
                  )}>
                    {groupDmSelected.includes(rel.user.id) && <span className="text-[10px] font-bold">{'\u2713'}</span>}
                  </div>
                )}
                <span className="text-label text-text-primary">{rel.user.username}</span>
              </div>
            </button>
          ))}
          {relationships.filter((r) => r.type === 1).length === 0 && (
            <p className="px-3 py-6 text-body text-text-muted">
              Add a friend first — you can only DM people you're friends with.
            </p>
          )}
        </div>
        {dmPickerError && (
          <div role="alert" className="mx-3 mb-3 rounded-sm border border-accent-danger/40 bg-danger-tint px-3 py-2 text-label font-medium text-accent-danger">
            {dmPickerError}
          </div>
        )}
        {groupDmMode && groupDmSelected.length > 0 && (
          <div className="border-t border-border-subtle p-3">
            <Button
              className="w-full"
              onClick={async () => {
                try {
                  const { data } = await dmApi.createGroup(groupDmSelected, groupDmName || undefined);
                  const current = useChannelStore.getState().channelsByGuild[''] || [];
                  const next = current.some((c) => c.id === data.id) ? current : [...current, data];
                  setDmChannels(next);
                  selectChannel(data.id);
                  setShowDmPicker(false);
                  setGroupDmMode(false);
                  setGroupDmSelected([]);
                  setGroupDmName('');
                  setDmPickerError(null);
                  navigate(`/app/dms/${data.id}`);
                } catch (err) {
                  setDmPickerError(extractApiError(err) || 'Failed to create this group DM.');
                }
              }}
            >
              Create Group DM ({groupDmSelected.length + 1} members)
            </Button>
          </div>
        )}
      </DmPickerModalShell>
    </div>
  );
}
