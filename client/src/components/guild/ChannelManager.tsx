import { useCallback, useMemo, useState } from 'react';
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
import { GripVertical, Hash, Volume2, MessageSquare, Trash2, Plus } from 'lucide-react';
import type { Channel, Role } from '../../types';
import { guildApi } from '../../api/guilds';
import { channelApi } from '../../api/channels';
import { useChannelStore } from '../../stores/channelStore';
import { buildChannelGroups, isVirtualGroup, type ChannelGroup } from '../../lib/channelGroups';
import { cn } from '../../lib/utils';

interface ChannelManagerProps {
  guildId: string;
  channels: Channel[];
  roles: Role[];
  canManageRoles: boolean;
  onRefresh: () => Promise<void>;
}

// Prefixes to distinguish category vs channel drag IDs
const CAT_PREFIX = 'cat::';
const CH_PREFIX = 'ch::';

function channelTypeIcon(type: number) {
  if (type === 2) return <Volume2 size={14} className="text-text-muted" />;
  if (type === 7) return <MessageSquare size={14} className="text-text-muted" />;
  return <Hash size={14} className="text-text-muted" />;
}

function channelTypeBadge(type: number) {
  if (type === 2) return 'Voice';
  if (type === 7) return 'Forum';
  if (type === 4) return 'Category';
  return 'Text';
}

export function ChannelManager({ guildId, channels, roles, canManageRoles, onRefresh }: ChannelManagerProps) {
  const reorderChannels = useChannelStore((s) => s.reorderChannels);

  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice' | 'forum'>('text');
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
      setError('Failed to create category');
    }
  }, [guildId, newCategoryName, onRefresh]);

  const handleDeleteCategory = useCallback(async (categoryId: string) => {
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
    } catch {
      setError('Failed to delete category');
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
    } catch {
      setError('Failed to rename category');
    }
  }, [editingCategoryName, onRefresh]);

  const handleCreateChannel = useCallback(async () => {
    if (!newChannelName.trim()) return;
    setError(null);
    try {
      const typeNum = newChannelType === 'voice' ? 2 : newChannelType === 'forum' ? 7 : 0;
      await guildApi.createChannel(guildId, {
        name: newChannelName.trim(),
        channel_type: typeNum,
        parent_id: newChannelCategoryId || null,
        ...(canManageRoles ? { required_role_ids: newChannelRequiredRoleIds } : {}),
      });
      setNewChannelName('');
      setNewChannelRequiredRoleIds([]);
      await onRefresh();
    } catch {
      setError('Failed to create channel');
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
    } catch {
      setError('Failed to create channel');
    }
  }, [guildId, inlineName, inlineType, onRefresh]);

  const handleDeleteChannel = useCallback(async (channelId: string) => {
    setError(null);
    try {
      await channelApi.delete(channelId);
      await onRefresh();
    } catch {
      setError('Failed to delete channel');
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
    <div className="settings-surface-card min-h-[calc(100dvh-13.5rem)] !p-8 max-sm:!p-6 card-stack">
      <h2 className="settings-section-title !mb-0">Channels</h2>

      {error && (
        <div className="rounded-lg border border-accent-danger/30 bg-accent-danger/10 px-3.5 py-2.5 text-sm text-accent-danger">
          {error}
        </div>
      )}

      {/* Create Category */}
      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-4 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Create Category
        </div>
        <div className="settings-action-row">
          <input
            className="input-field flex-1"
            placeholder="Category name"
            value={newCategoryName}
            onChange={(e) => setNewCategoryName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateCategory(); }}
          />
          <button className="btn-primary" onClick={() => void handleCreateCategory()}>
            Create
          </button>
        </div>
      </div>

      {!hasRealCategories && (
        <div className="rounded-xl border border-border-subtle bg-bg-mod-subtle/40 px-4 py-3 text-sm text-text-muted">
          Create a category to organize channels into custom groups.
        </div>
      )}

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
                channels={channels}
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
            <div className="rounded-lg border border-accent-primary/40 bg-bg-secondary px-3.5 py-2.5 shadow-lg">
              <div className="flex items-center gap-2 text-sm text-text-primary">
                {activeDragItem.type === 'category' ? (
                  <span className="font-semibold uppercase text-text-muted text-xs">
                    {activeDragItem.channel.name}
                  </span>
                ) : (
                  <>
                    {channelTypeIcon(activeDragItem.channel.type)}
                    <span>{activeDragItem.channel.name}</span>
                  </>
                )}
              </div>
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Create Channel form */}
      <div className="card-surface rounded-xl border border-border-subtle bg-bg-mod-subtle/60 p-4 space-y-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
          Create Channel
        </div>
        <div className="settings-action-row flex-wrap">
          <input
            className="input-field flex-1 min-w-[10rem]"
            placeholder="Channel name"
            value={newChannelName}
            onChange={(e) => setNewChannelName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleCreateChannel(); }}
          />
          <select
            className="select-field min-w-[7rem]"
            value={newChannelType}
            onChange={(e) => setNewChannelType(e.target.value as 'text' | 'voice' | 'forum')}
          >
            <option value="text">Text</option>
            <option value="voice">Voice</option>
            <option value="forum">Forum</option>
          </select>
          <select
            className="select-field min-w-[9rem]"
            value={newChannelCategoryId}
            onChange={(e) => setNewChannelCategoryId(e.target.value)}
          >
            <option value="">No Category</option>
            {categories.map((cat) => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={() => void handleCreateChannel()}>
            Create
          </button>
        </div>
        {canManageRoles && assignableRoles.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-text-secondary">
              Required Roles
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {assignableRoles.map((role) => (
                <label
                  key={role.id}
                  className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-primary/50 px-2.5 py-2 text-sm text-text-secondary"
                >
                  <input
                    type="checkbox"
                    checked={newChannelRequiredRoleIds.includes(role.id)}
                    onChange={() => setNewChannelRequiredRoleIds((prev) => toggleRoleId(prev, role.id))}
                    className="h-4 w-4 rounded border-border-subtle accent-accent-primary"
                  />
                  <span
                    className="inline-block h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: roleColorHex(role) }}
                  />
                  <span className="truncate">{role.name}</span>
                </label>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Category Group Section ──────────────────────────────────────────────────

interface CategoryGroupSectionProps {
  group: ChannelGroup;
  channels: Channel[];
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
  onStartInlineAdd: (catId: string) => void;
  onInlineNameChange: (name: string) => void;
  onInlineTypeChange: (type: 'text' | 'voice') => void;
  onInlineCreate: (parentId: string | null) => Promise<void>;
  onCancelInlineAdd: () => void;
}

function CategoryGroupSection({
  group,
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

  const isEditing = editingCategoryId === group.id;
  const isAddingInline = addingInCategoryId === group.id;
  const parentIdForCreate = group.isReal ? group.id : null;

  return (
    <div ref={setNodeRef} style={style}>
      {/* Category header */}
      <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-secondary px-3 py-2.5">
        {isSortableCategory && (
          <button
            className="cursor-grab text-text-muted hover:text-text-secondary active:cursor-grabbing"
            {...attributes}
            {...listeners}
          >
            <GripVertical size={14} />
          </button>
        )}
        {isEditing ? (
          <input
            className="input-field flex-1 !py-1 text-sm"
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
              'flex-1 text-xs font-semibold uppercase tracking-wide',
              group.isReal ? 'text-text-primary cursor-pointer' : 'text-text-muted'
            )}
            onDoubleClick={() => {
              if (group.isReal) onStartEditCategory(group.id, group.name);
            }}
          >
            {group.name}
          </span>
        )}
        {group.isReal && (
          <>
            {isEditing ? (
              <div className="flex items-center gap-1">
                <button className="btn-primary !py-1 !px-2.5 text-xs" onClick={() => void onSaveRename(group.id)}>
                  Save
                </button>
                <button className="rounded px-2 py-1 text-xs text-text-muted hover:text-text-primary" onClick={onCancelEdit}>
                  Cancel
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  className="rounded p-1 text-text-muted transition-colors hover:bg-bg-mod-subtle hover:text-text-primary"
                  title="Add channel"
                  onClick={() => onStartInlineAdd(group.id)}
                >
                  <Plus size={14} />
                </button>
                <button
                  className="rounded p-1 text-text-muted transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
                  title="Delete category"
                  onClick={() => void onDeleteCategory(group.id)}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            )}
          </>
        )}
        {!group.isReal && !isVirtualGroup(group.id) && (
          <span className="text-[10px] text-text-muted">Uncategorized</span>
        )}
      </div>

      {/* Inline add channel */}
      {isAddingInline && (
        <div className="mx-2 mt-2 rounded-lg border border-border-subtle bg-bg-mod-subtle p-2.5 space-y-2">
          <input
            className="w-full rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary placeholder:text-text-muted outline-none focus:border-border-strong"
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
              className="rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-xs text-text-secondary"
              value={inlineType}
              onChange={(e) => onInlineTypeChange(e.target.value as 'text' | 'voice')}
            >
              <option value="text">Text</option>
              <option value="voice">Voice</option>
            </select>
            <button
              className="rounded-md bg-accent-primary px-3 py-1 text-xs font-semibold text-white hover:bg-accent-primary/80"
              onClick={() => void onInlineCreate(parentIdForCreate)}
            >
              Create
            </button>
            <button
              className="rounded-md px-2 py-1 text-xs text-text-muted hover:text-text-primary"
              onClick={onCancelInlineAdd}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Channels in this group */}
      <SortableContext items={channelIds} strategy={verticalListSortingStrategy}>
        <div className="mt-1 space-y-1">
          {group.channels.map((ch) => (
            <SortableChannelItem
              key={ch.id}
              channel={ch}
              onDelete={onDeleteChannel}
            />
          ))}
          {group.channels.length === 0 && (
            <div className="px-4 py-2 text-xs text-text-muted">No channels</div>
          )}
        </div>
      </SortableContext>
    </div>
  );
}

// ── Sortable Channel Item ───────────────────────────────────────────────────

interface SortableChannelItemProps {
  channel: Channel;
  onDelete: (id: string) => Promise<void>;
}

function SortableChannelItem({ channel, onDelete }: SortableChannelItemProps) {
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-lg border border-border-subtle bg-bg-mod-subtle/70 px-3 py-2.5 ml-3"
    >
      <button
        className="cursor-grab text-text-muted hover:text-text-secondary active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <GripVertical size={14} />
      </button>
      {channelTypeIcon(channel.type)}
      <span className="flex-1 truncate text-sm text-text-primary">{channel.name || 'unnamed'}</span>
      <span className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
        {channelTypeBadge(channel.type)}
      </span>
      {roleCount > 0 && (
        <span className="rounded border border-border-subtle px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
          {roleCount} role{roleCount !== 1 ? 's' : ''}
        </span>
      )}
      <button
        className="rounded p-1 text-text-muted transition-colors hover:bg-accent-danger/10 hover:text-accent-danger"
        onClick={() => void onDelete(channel.id)}
        title="Delete channel"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}
