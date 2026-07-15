import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, Hash, Volume2, MessageSquare, Megaphone, Radio, Trash2, Plus, Shield, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import type { Channel, Role } from '../../types';
import { guildApi } from '../../api/guilds';
import { channelApi, type ChannelFeatureSettings } from '../../api/channels';
import { extractApiError } from '../../api/client';
import { useChannelStore } from '../../stores/channelStore';
import { buildChannelGroups, isVirtualGroup, type ChannelGroup } from '../../lib/features/channelGroups';
import { cn } from '../../lib/utils';
import { ChannelPermissionsEditor } from './ChannelPermissionsEditor';
import { confirm } from '../../stores/confirmStore';
import { Button } from '../ui/Button';
import { ErrorBanner } from '../ui/Feedback';
import { FieldLabel } from './SettingsPrimitives';
import { toast } from '../../stores/toastStore';

interface ChannelManagerProps {
  guildId: string;
  channels: Channel[];
  roles: Role[];
  canManageRoles: boolean;
  highlightedChannelId?: string | null;
  onRefresh: () => Promise<void>;
}

// Prefixes to distinguish category vs channel drag IDs
const CAT_PREFIX = 'cat::';
const CH_PREFIX = 'ch::';

function channelManagerError(action: string, err: unknown): string {
  return `${action}: ${extractApiError(err)}`;
}

function channelTypeIcon(type: number) {
  if (type === 2) return <Volume2 size={16} className="shrink-0 text-channel-icon" />;
  if (type === 7) return <MessageSquare size={16} className="shrink-0 text-channel-icon" />;
  if (type === 5) return <Megaphone size={16} className="shrink-0 text-channel-icon" />;
  return <Hash size={16} className="shrink-0 text-channel-icon" />;
}

function channelTypeBadge(type: number) {
  if (type === 2) return 'Voice';
  if (type === 7) return 'Forum';
  if (type === 13) return 'Stage';
  if (type === 4) return 'Category';
  return 'Text';
}

export function ChannelManager({ guildId, channels, roles, canManageRoles, highlightedChannelId, onRefresh }: ChannelManagerProps) {
  const reorderChannels = useChannelStore((s) => s.reorderChannels);

  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice' | 'forum' | 'stage'>('text');
  const [newChannelCategoryId, setNewChannelCategoryId] = useState<string>('');
  const [newChannelRequiredRoleIds, setNewChannelRequiredRoleIds] = useState<string[]>([]);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingCategoryName, setEditingCategoryName] = useState('');
  const [addingInCategoryId, setAddingInCategoryId] = useState<string | null>(null);
  const [inlineName, setInlineName] = useState('');
  const [inlineType, setInlineType] = useState<'text' | 'voice'>('text');
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permissionsChannel, setPermissionsChannel] = useState<Channel | null>(null);

  const groups = useMemo(() => buildChannelGroups(channels), [channels]);
  const categories = useMemo(() => channels.filter((c) => c.type === 4), [channels]);
  const hasRealCategories = categories.length > 0;

  const memberRoleId = guildId;
  const assignableRoles = useMemo(
    () => roles.filter((role) => role.id !== memberRoleId),
    [roles, memberRoleId]
  );

  // Build flat ordered IDs for categories (for category-level sorting)
  const categoryIds = useMemo(
    () => groups.filter((g) => g.isReal).map((g) => CAT_PREFIX + g.id),
    [groups]
  );

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } })
  );

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = event;
      if (!over || active.id === over.id) return;

      const activeStr = String(active.id);
      const overStr = String(over.id);

      // Category reorder
      if (activeStr.startsWith(CAT_PREFIX) && overStr.startsWith(CAT_PREFIX)) {
        const activeCatId = activeStr.slice(CAT_PREFIX.length);
        const overCatId = overStr.slice(CAT_PREFIX.length);
        const catChannels = channels.filter((c) => c.type === 4);
        const sorted = [...catChannels].sort((a, b) => a.position - b.position);
        const fromIdx = sorted.findIndex((c) => c.id === activeCatId);
        const toIdx = sorted.findIndex((c) => c.id === overCatId);
        if (fromIdx === -1 || toIdx === -1) return;

        const reordered = arrayMove(sorted, fromIdx, toIdx);
        const positions = reordered.map((c, i) => ({
          id: c.id,
          position: i * 10,
        }));
        void reorderChannels(guildId, positions);
        return;
      }

      // Channel reorder (within or across categories)
      if (activeStr.startsWith(CH_PREFIX)) {
        const activeChId = activeStr.slice(CH_PREFIX.length);
        const activeCh = channels.find((c) => c.id === activeChId);
        if (!activeCh) return;

        // Determine target category
        let targetCatId: string | null = null;
        if (overStr.startsWith(CH_PREFIX)) {
          const overChId = overStr.slice(CH_PREFIX.length);
          const overCh = channels.find((c) => c.id === overChId);
          if (overCh) {
            targetCatId = overCh.parent_id ?? null;
          }
        } else if (overStr.startsWith(CAT_PREFIX)) {
          targetCatId = overStr.slice(CAT_PREFIX.length);
        }

        // Build the channel list within the target category
        const targetGroup = groups.find((g) => {
          if (targetCatId === null) return g.id === '__uncategorized__';
          return g.id === targetCatId;
        });

        if (!targetGroup) {
          // Just move parent_id
          const positions = [
            { id: activeChId, position: activeCh.position, parent_id: targetCatId },
          ];
          void reorderChannels(guildId, positions);
          return;
        }

        // Build new channel list for this group
        const groupChannels = [...targetGroup.channels];
        // Remove active if already in this group
        const existingIdx = groupChannels.findIndex((c) => c.id === activeChId);
        if (existingIdx !== -1) groupChannels.splice(existingIdx, 1);

        // Find insert position
        let insertIdx = groupChannels.length;
        if (overStr.startsWith(CH_PREFIX)) {
          const overChId = overStr.slice(CH_PREFIX.length);
          const overIdx = groupChannels.findIndex((c) => c.id === overChId);
          if (overIdx !== -1) insertIdx = overIdx;
        }

        groupChannels.splice(insertIdx, 0, activeCh);

        const positions = groupChannels.map((c, i) => ({
          id: c.id,
          position: i * 10,
          parent_id: targetCatId && !isVirtualGroup(targetCatId) ? targetCatId : null,
        }));

        // If moving between categories, also include the source update
        if (activeCh.parent_id !== targetCatId) {
          const alreadyInPositions = positions.some((p) => p.id === activeChId);
          if (!alreadyInPositions) {
            positions.push({
              id: activeChId,
              position: insertIdx * 10,
              parent_id: targetCatId && !isVirtualGroup(targetCatId) ? targetCatId : null,
            });
          }
        }

        void reorderChannels(guildId, positions);
      }
    },
    [channels, groups, guildId, reorderChannels]
  );

  const handleCreateCategory = useCallback(async () => {
    if (!newCategoryName.trim()) return;
    setError(null);
    try {
      await guildApi.createChannel(guildId, {
        name: newCategoryName.trim(),
        channel_type: 4,
      });
      setNewCategoryName('');
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to create category', err));
    }
  }, [guildId, newCategoryName, onRefresh]);

  const handleDeleteCategory = useCallback(async (categoryId: string) => {
    const ok = await confirm({
      title: 'Delete category?',
      description: 'All child channels will be moved to uncategorized before deleting this category.',
      confirmLabel: 'Delete category',
      variant: 'danger',
    });
    if (!ok) return;
    setError(null);
    try {
      // Move children to uncategorized first
      const children = channels.filter((c) => c.parent_id === categoryId && c.type !== 4);
      if (children.length > 0) {
        const positions = children.map((c) => ({
          id: c.id,
          position: c.position,
          parent_id: null as string | null,
        }));
        await channelApi.updatePositions(guildId, positions);
      }
      await channelApi.delete(categoryId);
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to delete category', err));
    }
  }, [channels, guildId, onRefresh]);

  const handleRenameCategory = useCallback(async (categoryId: string) => {
    if (!editingCategoryName.trim()) return;
    setError(null);
    try {
      await channelApi.update(categoryId, { name: editingCategoryName.trim() });
      setEditingCategoryId(null);
      setEditingCategoryName('');
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to rename category', err));
    }
  }, [editingCategoryName, onRefresh]);

  const handleCreateChannel = useCallback(async () => {
    if (!newChannelName.trim()) return;
    setError(null);
    try {
      const typeNum =
        newChannelType === 'voice' ? 2 : newChannelType === 'forum' ? 7 : newChannelType === 'stage' ? 13 : 0;
      await guildApi.createChannel(guildId, {
        name: newChannelName.trim(),
        channel_type: typeNum,
        parent_id: newChannelCategoryId || null,
        ...(canManageRoles ? { required_role_ids: newChannelRequiredRoleIds } : {}),
      });
      setNewChannelName('');
      setNewChannelRequiredRoleIds([]);
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to create channel', err));
    }
  }, [guildId, newChannelName, newChannelType, newChannelCategoryId, newChannelRequiredRoleIds, canManageRoles, onRefresh]);

  const handleInlineCreate = useCallback(async (parentId: string | null) => {
    if (!inlineName.trim()) return;
    setError(null);
    try {
      await guildApi.createChannel(guildId, {
        name: inlineName.trim(),
        channel_type: inlineType === 'voice' ? 2 : 0,
        parent_id: parentId && !isVirtualGroup(parentId) ? parentId : null,
      });
      setInlineName('');
      setAddingInCategoryId(null);
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to create channel', err));
    }
  }, [guildId, inlineName, inlineType, onRefresh]);

  const handleDeleteChannel = useCallback(async (channelId: string) => {
    const ok = await confirm({
      title: 'Delete channel?',
      description: 'This permanently deletes the channel and its history.',
      confirmLabel: 'Delete channel',
      variant: 'danger',
    });
    if (!ok) return;
    setError(null);
    const deleted = channels.find((c) => c.id === channelId);
    try {
      await channelApi.delete(channelId);
      await onRefresh();
      if (deleted) {
        toast.info('Channel deleted.', 6000, {
          label: 'Undo',
          onClick: async () => {
            await guildApi.createChannel(guildId, {
              name: deleted.name || 'restored-channel',
              channel_type: deleted.channel_type ?? deleted.type ?? 0,
              parent_id: deleted.parent_id ?? null,
              topic: deleted.topic ?? undefined,
              bitrate: deleted.bitrate ?? undefined,
              user_limit: deleted.user_limit ?? undefined,
              required_role_ids: deleted.required_role_ids ?? undefined,
            });
            await onRefresh();
            toast.success('Channel restored.');
          },
        });
      }
    } catch (err) {
      setError(channelManagerError('Failed to delete channel', err));
    }
  }, [channels, guildId, onRefresh]);

  const handleToggleNsfw = useCallback(async (channelId: string, nsfw: boolean) => {
    setError(null);
    try {
      await channelApi.update(channelId, { nsfw });
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to update channel', err));
    }
  }, [onRefresh]);

  const handleUpdateSlowmode = useCallback(async (channelId: string, rateLimitPerUser: number) => {
    setError(null);
    try {
      await channelApi.update(channelId, { rate_limit_per_user: rateLimitPerUser });
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to update slowmode', err));
    }
  }, [onRefresh]);

  const handleUpdateVoiceSettings = useCallback(async (channelId: string, bitrate: number, userLimit: number) => {
    setError(null);
    try {
      await channelApi.update(channelId, { bitrate, user_limit: userLimit });
      await onRefresh();
    } catch (err) {
      setError(channelManagerError('Failed to update voice settings', err));
    }
  }, [onRefresh]);

  const toggleRoleId = (arr: string[], id: string) =>
    arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id];

  const roleColorHex = (role: Role) =>
    role.color ? `#${role.color.toString(16).padStart(6, '0')}` : '#99aab5';

  // Find the active item for DragOverlay
  const activeDragItem = useMemo(() => {
    if (!activeId) return null;
    if (activeId.startsWith(CAT_PREFIX)) {
      const catId = activeId.slice(CAT_PREFIX.length);
      const cat = channels.find((c) => c.id === catId);
      return cat ? { type: 'category' as const, channel: cat } : null;
    }
    if (activeId.startsWith(CH_PREFIX)) {
      const chId = activeId.slice(CH_PREFIX.length);
      const ch = channels.find((c) => c.id === chId);
      return ch ? { type: 'channel' as const, channel: ch } : null;
    }
    return null;
  }, [activeId, channels]);

  return (
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] space-y-6 !p-8 max-sm:!p-6">
      <div>
        <h2 className="font-display text-heading text-text-primary">Channels</h2>
        <p className="mt-1 text-sm leading-relaxed text-text-secondary">
          Organize your server into categories and channels. Drag to reorder.
        </p>
      </div>

      {error && <ErrorBanner message={error} />}

      {/* Create Category */}
      <div className="rounded-sm border border-border-subtle bg-bg-tertiary p-4">
        <FieldLabel>New category</FieldLabel>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input-field flex-1"
            placeholder="Category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateCategory(); }}
          />
          <Button onClick={() => void handleCreateCategory()} disabled={!newCategoryName.trim()}>
            Create
          </Button>
        </div>
        {!hasRealCategories && (
          <p className="mt-2 text-meta leading-relaxed text-text-muted">
            Categories let you group related channels — like “Support”, “Off-topic”, or a project name.
          </p>
        )}
      </div>

      {/* Channel groups with drag-and-drop */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
      >
        {/* Category-level sorting */}
        <SortableContext items={categoryIds} strategy={verticalListSortingStrategy}>
          <div className="card-stack">
            {groups.map((group) => (
              <CategoryGroupSection
                key={group.id}
                group={group}
                guildId={guildId}
                channels={channels}
                roles={roles}
                editingCategoryId={editingCategoryId}
                editingCategoryName={editingCategoryName}
                addingInCategoryId={addingInCategoryId}
                inlineName={inlineName}
                inlineType={inlineType}
                onStartEditCategory={(id, name) => {
                  setEditingCategoryId(id);
                  setEditingCategoryName(name);
                }}
                onEditCategoryNameChange={setEditingCategoryName}
                onSaveRename={handleRenameCategory}
                onCancelEdit={() => { setEditingCategoryId(null); setEditingCategoryName(''); }}
                onDeleteCategory={handleDeleteCategory}
                onDeleteChannel={handleDeleteChannel}
                onToggleNsfw={handleToggleNsfw}
                onUpdateSlowmode={handleUpdateSlowmode}
                onUpdateVoiceSettings={handleUpdateVoiceSettings}
                onEditPermissions={setPermissionsChannel}
                highlightedChannelId={highlightedChannelId}
                onStartInlineAdd={(catId) => {
                  setAddingInCategoryId(catId);
                  setInlineName('');
                  setInlineType('text');
                }}
                onInlineNameChange={setInlineName}
                onInlineTypeChange={setInlineType}
                onInlineCreate={handleInlineCreate}
                onCancelInlineAdd={() => setAddingInCategoryId(null)}
                />
            ))}
          </div>
        </SortableContext>

        <DragOverlay>
          {activeDragItem && (
            <div className="flex scale-[1.02] items-center gap-2 rounded-sm border border-accent-primary bg-bg-accent px-3 py-2 text-sm text-text-primary shadow-md">
              {activeDragItem.type === 'category' ? (
                <span className="text-section uppercase text-text-secondary">
                  {activeDragItem.channel.name}
                </span>
              ) : (
                <>
                  {channelTypeIcon(activeDragItem.channel.type)}
                  <span>{activeDragItem.channel.name}</span>
                </>
              )}
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Create Channel form */}
      <div className="space-y-4 rounded-sm border border-border-subtle bg-bg-tertiary p-4">
        <FieldLabel className="!mb-0">New channel</FieldLabel>

        {/* Type picker — selectable tiles */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {([
            { value: 'text', label: 'Text', icon: Hash, hint: 'Send messages' },
            { value: 'voice', label: 'Voice', icon: Volume2, hint: 'Talk & video' },
            { value: 'forum', label: 'Forum', icon: MessageSquare, hint: 'Threaded posts' },
            { value: 'stage', label: 'Stage', icon: Radio, hint: 'Audience & speakers' },
          ] as const).map(({ value, label, icon: Icon, hint }) => {
            const active = newChannelType === value;
            return (
              <button
                key={value}
                type="button"
                onClick={() => setNewChannelType(value)}
                aria-pressed={active}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-sm border p-3 text-left outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                  active
                    ? 'border-accent-primary bg-accent-tint'
                    : 'border-border-subtle bg-bg-secondary hover:border-border-strong hover:bg-bg-mod-subtle',
                )}
              >
                <Icon size={18} className={active ? 'text-accent-primary' : 'text-channel-icon'} />
                <span className="text-label font-medium text-text-primary">{label}</span>
                <span className="text-meta text-text-muted">{hint}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            className="input-field flex-1"
            placeholder="Channel name"
            value={newChannelName}
            onChange={(e) => setNewChannelName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateChannel(); }}
          />
          <select
            className="select-field sm:w-48"
            value={newChannelCategoryId}
            onChange={(e) => setNewChannelCategoryId(e.target.value)}
            aria-label="Parent category"
          >
            <option value="">No category</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <Button onClick={() => void handleCreateChannel()} disabled={!newChannelName.trim()}>
            Create
          </Button>
        </div>

        {canManageRoles && assignableRoles.length > 0 && (
          <div className="space-y-2 border-t border-border-subtle pt-3">
            <div className="text-section uppercase text-text-muted">Restrict to roles (optional)</div>
            <div className="flex flex-wrap gap-1.5">
              {assignableRoles.map((role) => {
                const active = newChannelRequiredRoleIds.includes(role.id);
                return (
                  <button
                    key={role.id}
                    type="button"
                    onClick={() => setNewChannelRequiredRoleIds((prev) => toggleRoleId(prev, role.id))}
                    aria-pressed={active}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-meta font-medium outline-none transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:shadow-[var(--focus-ring)]',
                      active
                        ? 'border-accent-primary bg-accent-tint text-text-primary'
                        : 'border-border-subtle bg-bg-secondary text-text-secondary hover:border-border-strong hover:text-text-primary',
                    )}
                  >
                    <span
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: roleColorHex(role) }}
                    />
                    {role.name}
                  </button>
                );
              })}
            </div>
            <p className="text-meta leading-relaxed text-text-muted">
              Only members with a selected role will see this channel. Leave empty to make it public.
            </p>
          </div>
        )}
      </div>

      {permissionsChannel && (
        <ChannelPermissionsEditor
          channelId={permissionsChannel.id}
          channelName={permissionsChannel.name ?? permissionsChannel.id}
          roles={roles}
          guildId={guildId}
          onClose={() => setPermissionsChannel(null)}
        />
      )}
    </div>
  );
}

// ── Category Group Section ──────────────────────────────────────────────────

interface CategoryGroupSectionProps {
  group: ChannelGroup;
  guildId: string;
  channels: Channel[];
  roles: Role[];
  editingCategoryId: string | null;
  editingCategoryName: string;
  addingInCategoryId: string | null;
  inlineName: string;
  inlineType: 'text' | 'voice';
  onStartEditCategory: (id: string, name: string) => void;
  onEditCategoryNameChange: (name: string) => void;
  onSaveRename: (id: string) => Promise<void>;
  onCancelEdit: () => void;
  onDeleteCategory: (id: string) => Promise<void>;
  onDeleteChannel: (id: string) => Promise<void>;
  onToggleNsfw: (id: string, nsfw: boolean) => Promise<void>;
  onUpdateSlowmode: (id: string, rateLimitPerUser: number) => Promise<void>;
  onUpdateVoiceSettings: (id: string, bitrate: number, userLimit: number) => Promise<void>;
  onEditPermissions: (channel: Channel) => void;
  highlightedChannelId?: string | null;
  onStartInlineAdd: (catId: string) => void;
  onInlineNameChange: (name: string) => void;
  onInlineTypeChange: (type: 'text' | 'voice') => void;
  onInlineCreate: (parentId: string | null) => Promise<void>;
  onCancelInlineAdd: () => void;
}

function CategoryGroupSection({
  group,
  guildId,
  channels,
  roles,
  editingCategoryId,
  editingCategoryName,
  addingInCategoryId,
  inlineName,
  inlineType,
  onStartEditCategory,
  onEditCategoryNameChange,
  onSaveRename,
  onCancelEdit,
  onDeleteCategory,
  onDeleteChannel,
  onToggleNsfw,
  onUpdateSlowmode,
  onUpdateVoiceSettings,
  onEditPermissions,
  highlightedChannelId,
  onStartInlineAdd,
  onInlineNameChange,
  onInlineTypeChange,
  onInlineCreate,
  onCancelInlineAdd,
}: CategoryGroupSectionProps) {
  const isSortableCategory = group.isReal;
  const sortableId = isSortableCategory ? CAT_PREFIX + group.id : group.id;

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: sortableId,
    disabled: !isSortableCategory,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const channelIds = useMemo(
    () => group.channels.map((c) => CH_PREFIX + c.id),
    [group.channels]
  );

  const [collapsed, setCollapsed] = useState(false);
  const isEditing = editingCategoryId === group.id;
  const isAddingInline = addingInCategoryId === group.id;
  const parentIdForCreate = group.isReal ? group.id : null;

  return (
    <div ref={setNodeRef} style={style}>
      {/* Category header */}
      <div className="group/cat flex items-center gap-1.5 rounded-sm px-1.5 py-1.5 transition-colors hover:bg-bg-mod-subtle">
        {isSortableCategory && (
          <button
            className="cursor-grab text-text-muted opacity-0 outline-none transition-opacity hover:text-text-secondary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] active:cursor-grabbing group-hover/cat:opacity-100"
            aria-label={`Reorder ${group.name} category`}
            title={`Reorder ${group.name} category`}
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>
        )}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-xs text-text-muted outline-none transition-colors hover:text-text-secondary focus-visible:shadow-[var(--focus-ring)]"
          aria-label={collapsed ? `Expand ${group.name}` : `Collapse ${group.name}`}
          aria-expanded={!collapsed}
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        {isEditing ? (
          <input
            className="input-field flex-1 !min-h-0 !py-1 text-sm"
            value={editingCategoryName}
            onChange={(e) => onEditCategoryNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onSaveRename(group.id);
              if (e.key === 'Escape') onCancelEdit();
            }}
            autoFocus
          />
        ) : (
          <span
            className={cn(
              'flex-1 truncate text-section uppercase',
              group.isReal ? 'cursor-pointer text-text-secondary' : 'text-text-muted'
            )}
            onDoubleClick={() => {
              if (group.isReal) onStartEditCategory(group.id, group.name);
            }}
            title={group.isReal ? 'Double-click to rename' : undefined}
          >
            {group.name}
          </span>
        )}
        {group.isReal && (
          <>
            {isEditing ? (
              <div className="flex items-center gap-1">
                <Button size="sm" onClick={() => void onSaveRename(group.id)}>
                  Save
                </Button>
                <Button variant="ghost" size="sm" onClick={onCancelEdit}>
                  Cancel
                </Button>
              </div>
            ) : (
              <div className="flex items-center gap-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/cat:opacity-100">
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                  title="Add channel"
                  aria-label={`Add channel to ${group.name}`}
                  onClick={() => onStartInlineAdd(group.id)}
                >
                  <Plus size={15} />
                </button>
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)]"
                  title="Delete category"
                  aria-label={`Delete ${group.name} category`}
                  onClick={() => void onDeleteCategory(group.id)}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )}
          </>
        )}
        {!group.isReal && !isVirtualGroup(group.id) && (
          <span className="text-meta text-text-muted">Uncategorized</span>
        )}
      </div>

      {/* Inline add channel */}
      {isAddingInline && !collapsed && (
        <div className="ml-6 mt-1.5 space-y-2 rounded-sm border border-border-subtle bg-bg-tertiary p-2.5">
          <input
            className="w-full rounded-sm border border-border-subtle bg-bg-tertiary px-2.5 py-1.5 text-sm text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] placeholder:text-text-muted focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
            placeholder="Channel name"
            value={inlineName}
            onChange={(e) => onInlineNameChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void onInlineCreate(parentIdForCreate);
              if (e.key === 'Escape') onCancelInlineAdd();
            }}
            autoFocus
          />
          <div className="flex items-center gap-2">
            <select
              className="rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1.5 text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
              value={inlineType}
              onChange={(e) => onInlineTypeChange(e.target.value as 'text' | 'voice')}
              aria-label="Channel type"
            >
              <option value="text">Text</option>
              <option value="voice">Voice</option>
            </select>
            <Button size="sm" onClick={() => void onInlineCreate(parentIdForCreate)}>
              Create
            </Button>
            <Button variant="ghost" size="sm" onClick={onCancelInlineAdd}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {/* Channels in this group */}
      <SortableContext items={channelIds} strategy={verticalListSortingStrategy}>
        <div className={cn('mt-0.5 space-y-0.5', collapsed && 'hidden')}>
          {group.channels.map((ch) => (
            <SortableChannelItem
              key={ch.id}
              guildId={guildId}
              channels={channels}
              roles={roles}
              channel={ch}
              onDelete={onDeleteChannel}
              onToggleNsfw={onToggleNsfw}
              onUpdateSlowmode={onUpdateSlowmode}
              onUpdateVoiceSettings={onUpdateVoiceSettings}
              onEditPermissions={onEditPermissions}
              isHighlighted={highlightedChannelId === ch.id}
            />
          ))}
          {group.channels.length === 0 && (
            <div className="px-6 py-1.5 text-meta text-text-muted">
              {group.isReal ? 'No channels here yet — add one with the + above.' : 'No channels here yet.'}
            </div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ── Sortable Channel Item ───────────────────────────────────────────────────

const SLOWMODE_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '5s', value: 5 },
  { label: '10s', value: 10 },
  { label: '15s', value: 15 },
  { label: '30s', value: 30 },
  { label: '1m', value: 60 },
  { label: '2m', value: 120 },
  { label: '5m', value: 300 },
  { label: '10m', value: 600 },
  { label: '15m', value: 900 },
  { label: '30m', value: 1800 },
  { label: '1h', value: 3600 },
  { label: '2h', value: 7200 },
  { label: '6h', value: 21600 },
];

const DISAPPEARING_OPTIONS = [
  { label: 'Off', value: 0 },
  { label: '1 hour', value: 3600 },
  { label: '24 hours', value: 86400 },
  { label: '7 days', value: 604800 },
  { label: '30 days', value: 2592000 },
];

interface SortableChannelItemProps {
  guildId: string;
  channels: Channel[];
  roles: Role[];
  channel: Channel;
  onDelete: (id: string) => Promise<void>;
  onToggleNsfw: (id: string, nsfw: boolean) => Promise<void>;
  onUpdateSlowmode: (id: string, rateLimitPerUser: number) => Promise<void>;
  onUpdateVoiceSettings: (id: string, bitrate: number, userLimit: number) => Promise<void>;
  onEditPermissions: (channel: Channel) => void;
  isHighlighted?: boolean;
}

function SortableChannelItem({
  guildId,
  channels,
  roles,
  channel,
  onDelete,
  onToggleNsfw,
  onUpdateSlowmode,
  onUpdateVoiceSettings,
  onEditPermissions,
  isHighlighted = false,
}: SortableChannelItemProps) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: CH_PREFIX + channel.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const roleCount = channel.required_role_ids?.length || 0;
  const isVoice = channel.type === 2;
  const isAnnouncement = channel.type === 5 || channel.channel_type === 5;

  // Feature settings state
  const [featuresExpanded, setFeaturesExpanded] = useState(false);
  const [featureSettings, setFeatureSettings] = useState<ChannelFeatureSettings | null>(null);
  const [featuresBusy, setFeaturesBusy] = useState(false);

  const loadFeatureSettings = useCallback(async () => {
    if (featureSettings !== null) return;
    setFeaturesBusy(true);
    try {
      const { data } = await channelApi.getFeatureSettings(channel.id);
      setFeatureSettings(data);
    } catch {
      // ignore — feature settings may not exist yet
    } finally {
      setFeaturesBusy(false);
    }
  }, [channel.id, featureSettings]);

  const handleToggleFeatures = useCallback(async () => {
    const next = !featuresExpanded;
    setFeaturesExpanded(next);
    if (next) await loadFeatureSettings();
  }, [featuresExpanded, loadFeatureSettings]);

  const patchFeatureSettings = useCallback(async (patch: Partial<ChannelFeatureSettings>) => {
    if (!featureSettings) return;
    const updated = { ...featureSettings, ...patch };
    setFeatureSettings(updated);
    try {
      const { data } = await channelApi.updateFeatureSettings(channel.id, patch);
      setFeatureSettings(data);
    } catch (err) {
      setFeatureSettings(featureSettings);
      toast.error(channelManagerError('Failed to update channel features', err));
    }
  }, [channel.id, featureSettings]);

  const toggleExemptRole = useCallback((roleId: string) => {
    if (!featureSettings) return;
    const current = featureSettings.slowmode_exempt_role_ids;
    const next = current.includes(roleId)
      ? current.filter((id) => id !== roleId)
      : [...current, roleId];
    void patchFeatureSettings({ slowmode_exempt_role_ids: next });
  }, [featureSettings, patchFeatureSettings]);

  const assignableRoles = useMemo(
    () => roles.filter((r) => r.id !== guildId),
    [roles, guildId]
  );
  const [followers, setFollowers] = useState<
    Array<{ id: string; target_channel_id: string; target_guild_id: string }>
  >([]);
  const [followersLoading, setFollowersLoading] = useState(false);
  const [followTargetId, setFollowTargetId] = useState('');
  const [followBusy, setFollowBusy] = useState(false);
  const followTargets = useMemo(
    () =>
      channels.filter(
        (candidate) =>
          candidate.id !== channel.id
          && (candidate.type === 0 || candidate.channel_type === 0)
          && candidate.guild_id === guildId,
      ),
    [channels, channel.id, guildId],
  );

  // Local state for voice settings to allow editing before saving
  const [draftBitrate, setDraftBitrate] = useState<number>(channel.bitrate ?? 64000);
  const [draftUserLimit, setDraftUserLimit] = useState<number>(channel.user_limit ?? 0);

  const refreshFollowers = useCallback(async () => {
    if (!isAnnouncement) return;
    setFollowersLoading(true);
    try {
      const { data } = await channelApi.getFollowers(channel.id);
      setFollowers(
        data.map((entry) => ({
          id: entry.id,
          target_channel_id: entry.target_channel_id,
          target_guild_id: entry.target_guild_id,
        })),
      );
    } catch {
      setFollowers([]);
    } finally {
      setFollowersLoading(false);
    }
  }, [channel.id, isAnnouncement]);

  useEffect(() => {
    if (!isAnnouncement) return;
    void refreshFollowers();
  }, [isAnnouncement, refreshFollowers]);

  useEffect(() => {
    if (!isAnnouncement || followTargets.length === 0) {
      setFollowTargetId('');
      return;
    }
    setFollowTargetId((prev) =>
      prev && followTargets.some((target) => target.id === prev) ? prev : followTargets[0].id,
    );
  }, [followTargets, isAnnouncement]);

  const addFollow = useCallback(async () => {
    if (!followTargetId) return;
    setFollowBusy(true);
    try {
      await channelApi.addFollower(channel.id, followTargetId, guildId);
      await refreshFollowers();
    } catch (err) {
      toast.error(channelManagerError('Failed to follow announcement channel', err));
    } finally {
      setFollowBusy(false);
    }
  }, [channel.id, followTargetId, guildId, refreshFollowers]);

  const removeFollow = useCallback(async () => {
    if (!followTargetId) return;
    setFollowBusy(true);
    try {
      await channelApi.removeFollower(channel.id, followTargetId);
      await refreshFollowers();
    } catch (err) {
      toast.error(channelManagerError('Failed to unfollow announcement channel', err));
    } finally {
      setFollowBusy(false);
    }
  }, [channel.id, followTargetId, refreshFollowers]);

  const activeFollow = followers.some((entry) => entry.target_channel_id === followTargetId);
  const activeFeatureCount = featureSettings
    ? Number(featureSettings.disappearing_seconds > 0)
      + Number(featureSettings.anonymous_posting_enabled)
      + Number(featureSettings.adaptive_slowmode_enabled)
      + Number(featureSettings.slowmode_exempt_role_ids.length > 0)
    : 0;

  useEffect(() => {
    if (!isHighlighted) return;
    rowRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [isHighlighted]);

  return (
    <div ref={setNodeRef} style={style} className="ml-5">
      {/* Main channel row */}
      <div
        ref={rowRef}
        data-channel-id={channel.id}
        data-highlighted-channel={isHighlighted ? channel.id : undefined}
        className={cn(
          'group/row flex items-center gap-2 rounded-sm px-2 py-1.5 transition-colors hover:bg-bg-mod-subtle',
          isHighlighted && 'bg-accent-tint ring-1 ring-inset ring-accent-primary',
        )}
      >
        <button
          className="cursor-grab text-text-muted opacity-0 outline-none transition-opacity hover:text-text-secondary focus-visible:opacity-100 focus-visible:shadow-[var(--focus-ring)] active:cursor-grabbing group-hover/row:opacity-100"
          aria-label={`Reorder ${channel.name || 'channel'}`}
          title={`Reorder ${channel.name || 'channel'}`}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} />
        </button>
        {channelTypeIcon(channel.type)}
        <span className="flex-1 truncate text-label text-text-primary">{channel.name || 'unnamed'}</span>
        <span className="rounded-xs bg-bg-mod-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-text-secondary">
          {channelTypeBadge(channel.type)}
        </span>
        {roleCount > 0 && (
          <span className="rounded-xs bg-accent-tint px-1.5 py-0.5 text-[10px] font-semibold text-accent-primary">
            {roleCount} role{roleCount !== 1 ? 's' : ''}
          </span>
        )}
        {isAnnouncement && (
          <div className="ml-1 flex items-center gap-1.5">
            <span className="text-meta tabular-nums text-text-muted">
              {followers.length} following
            </span>
            <select
              className="rounded-sm border border-border-subtle bg-bg-tertiary px-1.5 py-1 text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
              value={followTargetId}
              onChange={(e) => setFollowTargetId(e.target.value)}
              disabled={followTargets.length === 0 || followersLoading || followBusy}
              title="Target channel"
            >
              {followTargets.length === 0 ? (
                <option value="">No target channels</option>
              ) : (
                followTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    #{target.name || target.id}
                  </option>
                ))
              )}
            </select>
            {activeFollow ? (
              <button
                type="button"
                className="rounded-sm border border-accent-danger/40 bg-danger-tint px-2 py-1 text-meta font-semibold text-accent-danger outline-none transition-colors hover:bg-danger-tint focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                onClick={() => void removeFollow()}
                disabled={!followTargetId || followBusy || followersLoading}
              >
                {followBusy ? '…' : 'Unfollow'}
              </button>
            ) : (
              <button
                type="button"
                className="rounded-sm border border-accent-primary/40 bg-accent-tint px-2 py-1 text-meta font-semibold text-accent-primary outline-none transition-colors hover:bg-accent-tint-strong focus-visible:shadow-[var(--focus-ring)] disabled:opacity-60"
                onClick={() => void addFollow()}
                disabled={!followTargetId || followBusy || followersLoading}
              >
                {followBusy ? '…' : 'Follow'}
              </button>
            )}
          </div>
        )}
        {isVoice && (
          <div className="ml-1 flex items-center gap-3">
            <label className="flex items-center gap-1.5" title="Audio bitrate">
              <span className="text-meta font-medium text-text-muted">Bitrate</span>
              <input
                type="range"
                min={8000}
                max={384000}
                step={8000}
                value={draftBitrate}
                onChange={(e) => setDraftBitrate(Number(e.target.value))}
                onMouseUp={() => void onUpdateVoiceSettings(channel.id, draftBitrate, draftUserLimit)}
                onTouchEnd={() => void onUpdateVoiceSettings(channel.id, draftBitrate, draftUserLimit)}
                className="w-16 accent-accent-primary"
              />
              <span className="w-8 text-meta tabular-nums text-text-muted">
                {Math.round(draftBitrate / 1000)}k
              </span>
            </label>
            <label className="flex items-center gap-1.5" title="User limit (0 = unlimited)">
              <span className="text-meta font-medium text-text-muted">Limit</span>
              <input
                type="number"
                min={0}
                max={99}
                value={draftUserLimit}
                onChange={(e) => setDraftUserLimit(Number(e.target.value))}
                onBlur={() => void onUpdateVoiceSettings(channel.id, draftBitrate, draftUserLimit)}
                className="w-11 rounded-sm border border-border-subtle bg-bg-tertiary px-1 py-1 text-center text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
              />
            </label>
          </div>
        )}
        {!isVoice && channel.type !== 4 && (
          <>
            <label className="flex cursor-pointer items-center gap-1.5" title="NSFW channel">
              <input
                type="checkbox"
                checked={channel.nsfw ?? false}
                onChange={(e) => void onToggleNsfw(channel.id, e.target.checked)}
                className="h-3.5 w-3.5 rounded-xs border-border-subtle accent-accent-danger"
              />
              <span className="text-meta font-medium text-text-muted">NSFW</span>
            </label>
            <label className="flex items-center gap-1.5" title="Slowmode">
              <span className="text-meta font-medium text-text-muted">Slow</span>
              <select
                className="rounded-sm border border-border-subtle bg-bg-tertiary px-1.5 py-1 text-meta text-text-secondary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                value={channel.rate_limit_per_user ?? 0}
                onChange={(e) => void onUpdateSlowmode(channel.id, Number(e.target.value))}
              >
                {SLOWMODE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          </>
        )}
        {/* Advanced feature settings toggle (text/forum channels only) */}
        {channel.type !== 4 && !isVoice && (
          <button
            className={cn(
              'flex h-7 items-center gap-1.5 rounded-sm px-2 text-meta font-semibold text-text-muted outline-none transition-colors hover:bg-bg-mod-strong hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]',
              featuresExpanded && 'bg-accent-tint text-accent-primary',
            )}
            onClick={() => void handleToggleFeatures()}
            title="Advanced channel features"
            aria-label={`${featuresExpanded ? 'Hide' : 'Show'} advanced features for ${channel.name || 'channel'}`}
          >
            <SlidersHorizontal size={14} aria-hidden />
            <span>Features</span>
            {activeFeatureCount > 0 && (
              <span className="rounded-full bg-accent-primary/15 px-1.5 text-[10px] tabular-nums text-accent-primary">
                {activeFeatureCount}
              </span>
            )}
            {featuresExpanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        )}
        <button
          className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-bg-mod-strong hover:text-accent-primary focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => onEditPermissions(channel)}
          title="Edit permissions"
          aria-label={`Edit permissions for ${channel.name || 'channel'}`}
        >
          <Shield size={15} />
        </button>
        <button
          className="flex h-7 w-7 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-danger-tint hover:text-accent-danger focus-visible:shadow-[var(--focus-ring)]"
          onClick={() => void onDelete(channel.id)}
          title="Delete channel"
          aria-label={`Delete ${channel.name || 'channel'}`}
        >
          <Trash2 size={15} />
        </button>
      </div>

      {/* Advanced feature settings panel */}
      {featuresExpanded && channel.type !== 4 && !isVoice && (
        <div className="ml-6 mt-1 space-y-3 rounded-sm border border-border-subtle bg-bg-tertiary px-4 py-3">
          <div className="flex items-start gap-2.5 border-b border-border-subtle pb-3">
            <SlidersHorizontal size={16} className="mt-0.5 shrink-0 text-accent-primary" aria-hidden />
            <div>
              <h4 className="text-label font-semibold text-text-primary">Channel features</h4>
              <p className="mt-0.5 text-meta leading-relaxed text-text-secondary">
                Automation and privacy controls that apply only to #{channel.name || 'this channel'}.
              </p>
            </div>
          </div>
          {featuresBusy && (
            <p className="text-meta text-text-muted">Loading…</p>
          )}
          {!featuresBusy && featureSettings && (
            <>
              {/* Disappearing messages */}
              <div className="flex items-center gap-3">
                <span className="w-36 shrink-0 text-meta font-medium text-text-secondary">
                  Disappearing messages
                </span>
                <select
                  className="rounded-sm border border-border-subtle bg-bg-tertiary px-2 py-1 text-meta text-text-primary outline-none transition-[border-color,box-shadow] duration-[140ms] ease-[var(--ease-out)] focus:border-accent-primary focus:shadow-[var(--focus-ring-input)]"
                  value={featureSettings.disappearing_seconds}
                  onChange={(e) => void patchFeatureSettings({ disappearing_seconds: Number(e.target.value) })}
                >
                  {DISAPPEARING_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>

              {/* Anonymous posting */}
              <label className="flex items-center gap-3 cursor-pointer">
                <span className="w-36 shrink-0 text-meta font-medium text-text-secondary">
                  Anonymous posting
                </span>
                <input
                  type="checkbox"
                  checked={featureSettings.anonymous_posting_enabled}
                  onChange={(e) => void patchFeatureSettings({ anonymous_posting_enabled: e.target.checked })}
                  className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary"
                />
                <span className="text-meta text-text-muted">
                  {featureSettings.anonymous_posting_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </label>

              {/* Adaptive slowmode */}
              <label className="flex items-center gap-3 cursor-pointer">
                <span className="w-36 shrink-0 text-meta font-medium text-text-secondary">
                  Adaptive slowmode
                </span>
                <input
                  type="checkbox"
                  checked={featureSettings.adaptive_slowmode_enabled}
                  onChange={(e) => void patchFeatureSettings({ adaptive_slowmode_enabled: e.target.checked })}
                  className="h-4 w-4 rounded-xs border-border-subtle accent-accent-primary"
                />
                <span className="text-meta text-text-muted">
                  {featureSettings.adaptive_slowmode_enabled ? 'Enabled' : 'Disabled'}
                </span>
              </label>

              {/* Slowmode exempt roles */}
              {assignableRoles.length > 0 && (
                <div className="space-y-1.5">
                  <span className="text-meta font-medium text-text-secondary">
                    Slowmode exempt roles
                  </span>
                  <div className="flex flex-wrap gap-1.5">
                    {assignableRoles.map((role) => {
                      const isExempt = featureSettings.slowmode_exempt_role_ids.includes(role.id);
                      const colorHex = role.color
                        ? `#${role.color.toString(16).padStart(6, '0')}`
                        : '#99aab5';
                      return (
                        <button
                          key={role.id}
                          type="button"
                          onClick={() => toggleExemptRole(role.id)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-meta font-medium outline-none transition-colors focus-visible:shadow-[var(--focus-ring)]',
                            isExempt
                              ? 'border-accent-primary bg-accent-tint text-accent-primary'
                              : 'border-border-subtle bg-bg-secondary text-text-muted hover:border-border-strong hover:text-text-secondary',
                          )}
                        >
                          <span
                            className="inline-block h-2 w-2 rounded-full shrink-0"
                            style={{ backgroundColor: colorHex }}
                          />
                          {role.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
          {!featuresBusy && !featureSettings && (
            <p className="text-meta text-text-muted">Could not load feature settings.</p>
          )}
        </div>
      )}
    </div>
  );
}
