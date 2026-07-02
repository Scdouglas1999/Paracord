import { useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { Search, Home } from 'lucide-react';
import { useChannelStore } from '../../stores/channelStore';
import { usePresenceStore } from '../../stores/presenceStore';
import { useRelationshipStore } from '../../stores/relationshipStore';
import { useAuthStore } from '../../stores/authStore';
import { dmApi } from '../../api/dms';
import { extractApiError } from '../../api/client';
import { Tooltip } from '../ui/Tooltip';
import { cn } from '../../lib/utils';
import { Button } from '../ui/Button';
import { UserPanel } from './UserPanel';
import { useVoice } from '../../hooks/useVoice';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { isAdmin as isGlobalAdmin } from '../../types/index';
import type { Channel } from '../../types/index';

const STATUS_COLORS: Record<string, string> = {
  online: 'bg-status-online',
  idle: 'bg-status-idle',
  dnd: 'bg-status-dnd',
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
          'glass-modal fixed left-1/2 top-1/2 z-50 max-h-[70vh] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl',
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

function PlusIconSmall() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="currentColor" d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z" />
    </svg>
  );
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

  return (
    <div className="flex h-full flex-col bg-transparent text-text-secondary">
      <div className="panel-divider shrink-0 border-b border-white/8 px-5 pb-6 pt-6">
        <div className="architect-eyebrow">Direct Messages</div>
        <div className="mt-2 mb-3 pl-px text-[1.5rem] font-bold leading-[1.2] tracking-normal text-text-primary">Paracord</div>
        <div className="relative w-full">
          <Search size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-muted" />
          <input
            type="text"
            placeholder="Find a conversation"
            className="h-10 w-full rounded-xl border border-border-subtle bg-bg-mod-subtle py-2 pl-10 pr-3 text-sm text-text-primary placeholder:text-text-muted outline-none transition-all focus:border-border-strong focus:bg-bg-mod-strong"
            value={dmSearch}
            onChange={(e) => setDmSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-4 scrollbar-thin">
        <button
          onClick={() => navigate('/app')}
          className={cn(
            'architect-nav-item px-3 py-2.5 text-[15px] font-semibold',
            location.pathname === '/app' ? 'architect-nav-item-active text-black' : 'text-text-secondary hover:text-text-primary'
          )}
        >
          <div className="w-6 flex justify-center">
            <Home size={20} className="opacity-70" />
          </div>
          Home
        </button>
        <button
          onClick={() => navigate('/app/friends')}
          className={cn(
            'architect-nav-item px-3 py-2.5 text-[15px] font-semibold',
            location.pathname === '/app/friends' ? 'architect-nav-item-active text-black' : 'text-text-secondary hover:text-text-primary'
          )}
        >
          <div className="w-6 flex justify-center">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" className="opacity-70">
              <path d="M13 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-2 2a7 7 0 0 0-7 7 1 1 0 0 0 1 1h16a1 1 0 0 0 1-1 7 7 0 0 0-7-7h-4Z" />
            </svg>
          </div>
          Friends
        </button>

        <div className="group mb-3 mt-5 flex items-center justify-between px-2.5">
          <span className="text-xs font-semibold uppercase tracking-wide text-text-muted transition-colors group-hover:text-text-secondary">
            Direct Messages
          </span>
          <Tooltip content="Create DM" side="top">
            <button
              className="rounded-lg border border-transparent p-1.5 text-text-muted opacity-0 transition-all group-hover:opacity-100 hover:border-border-subtle hover:bg-bg-mod-subtle hover:text-text-primary"
              aria-label="Create direct message"
              onClick={() => setShowDmPicker(true)}
            >
              <PlusIconSmall />
            </button>
          </Tooltip>
        </div>

        {filteredDms.length === 0 ? (
          <div className="mt-2 flex flex-col items-center justify-center px-4 py-10 opacity-70">
            <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-2xl border border-border-subtle bg-bg-mod-subtle">
              <Search size={24} className="text-text-muted" />
            </div>
            <span className="text-sm text-center text-text-muted">No direct messages found</span>
          </div>
        ) : (
          <div className="space-y-1.5">
            {filteredDms.map((dm) => (
              <button
                key={dm.id}
                onClick={() => {
                  selectChannel(dm.id);
                  navigate(`/app/dms/${dm.id}`);
                }}
                className={cn(
                  'group flex w-full items-center gap-3 rounded-xl px-3 py-2.5 transition-all',
                  selectedChannelId === dm.id
                    ? 'architect-nav-item-active text-black'
                    : 'architect-nav-item text-text-secondary hover:text-text-primary'
                )}
              >
                {(dm.channel_type === 3 || dm.type === 3) ? (
                  <>
                    <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-mod-strong text-sm font-semibold text-text-primary">
                      {String(dm.recipients?.length ?? '?')}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="truncate font-semibold text-[15px]">
                        {dm.name || dm.recipients?.map((r) => r.username).join(', ') || 'Group DM'}
                      </span>
                      <span className="truncate text-xs text-text-muted">{dm.recipients?.length ?? 0} members</span>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="relative">
                      <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-bg-mod-strong text-sm font-semibold text-text-primary">
                        {(dm.recipient?.username || 'D').charAt(0).toUpperCase()}
                      </div>
                      <PresenceStatusDot userId={dm.recipient?.id} className="absolute -bottom-0.5 -right-0.5 h-3 w-3 border-[2px] border-bg-secondary" />
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col items-start">
                      <span className="truncate font-semibold text-[15px]">{dm.recipient?.username || 'Direct Message'}</span>
                      <PresenceStatusText userId={dm.recipient?.id} className="truncate text-xs text-text-muted opacity-0 group-hover:opacity-100 transition-opacity" />
                    </div>
                  </>
                )}
              </button>
            ))}
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
          <span className="text-lg font-semibold text-text-primary">
            {groupDmMode ? 'Create Group DM' : 'Start Direct Message'}
          </span>
          <button
            className="text-xs font-semibold text-accent-primary hover:underline"
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
              className="w-full rounded-lg border border-border-subtle bg-bg-primary px-3 py-2 text-sm text-text-primary outline-none placeholder:text-text-muted focus:border-accent-primary"
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
                'w-full rounded-lg px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-bg-mod-subtle',
                groupDmMode && groupDmSelected.includes(rel.user.id) && 'bg-accent-primary/10 text-accent-primary'
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
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                    groupDmSelected.includes(rel.user.id)
                      ? 'border-accent-primary bg-accent-primary text-white'
                      : 'border-border-subtle'
                  )}>
                    {groupDmSelected.includes(rel.user.id) && <span className="text-[10px] font-bold">{'\u2713'}</span>}
                  </div>
                )}
                <span className="text-sm text-text-primary">{rel.user.username}</span>
              </div>
            </button>
          ))}
          {relationships.filter((r) => r.type === 1).length === 0 && (
            <div className="p-5 text-sm text-text-muted text-center">No friends available for DM.</div>
          )}
        </div>
        {dmPickerError && (
          <div role="alert" className="mx-3 mb-3 rounded-lg border border-accent-danger/40 bg-accent-danger/10 px-3 py-2 text-sm font-medium text-accent-danger">
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
