import { useState, useRef, useEffect, useCallback } from 'react';
import { ExternalLink, Hash, Volume2, User, Shield } from 'lucide-react';
import { ComponentType, ButtonStyle, type Component } from '../../types/components';
import { InteractionType } from '../../types/interactions';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { guildApi } from '../../api/guilds';
import { useChannelStore } from '../../stores/channelStore';
import { toast } from '../../stores/toastStore';
import type { Member, Role, Channel } from '../../types';
import { safeExternalUrl, safeStoredImageDataUrl } from '../../lib/security';
import { roleColorToHex } from '../../lib/colors';
import { LoadingSpinner } from '../ui/Feedback';
import { Button, type ButtonProps } from '../ui/Button';

interface MessageComponentsProps {
  components: Component[];
  messageId: string;
  channelId: string;
}

/** Dispatch a MessageComponent interaction to the server. */
async function dispatchComponentInteraction(
  channelId: string,
  messageId: string,
  customId: string,
  componentType: ComponentType,
  values?: string[],
): Promise<void> {
  await getApi().post('/interactions', {
    type: InteractionType.MessageComponent,
    channel_id: channelId,
    message_id: messageId,
    data: {
      custom_id: customId,
      component_type: componentType,
      values,
    },
  });
}

function notifyComponentError(action: string, err: unknown): void {
  toast.error(`${action}: ${extractApiError(err)}`);
}

// ---------------------------------------------------------------------------
// Button Component
// ---------------------------------------------------------------------------

// Map bot-supplied ButtonStyle onto the shared Button primitive's variants so
// in-message buttons match the rest of the product exactly (design-spec §7).
// Success has no primitive variant; it gets a token-driven className, keeping the
// primitive's metrics/motion/focus-ring intact.
const BUTTON_STYLE_VARIANT: Record<number, ButtonProps['variant']> = {
  [ButtonStyle.Primary]: 'default',
  [ButtonStyle.Secondary]: 'secondary',
  [ButtonStyle.Success]: 'default',
  [ButtonStyle.Danger]: 'destructive',
  [ButtonStyle.Link]: 'link',
};

function ComponentButton({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const [busy, setBusy] = useState(false);

  const style = component.style ?? ButtonStyle.Secondary;
  const isLink = style === ButtonStyle.Link;
  const isDisabled = component.disabled || busy;

  const variant = BUTTON_STYLE_VARIANT[style] ?? 'secondary';
  const successClasses =
    style === ButtonStyle.Success
      ? 'bg-accent-success text-text-on-accent hover:bg-[color-mix(in_srgb,var(--accent-success)_90%,#000)] active:bg-[color-mix(in_srgb,var(--accent-success)_82%,#000)]'
      : '';

  const handleClick = async () => {
    if (isDisabled) return;

    if (isLink && component.url) {
      const url = safeExternalUrl(component.url);
      if (!url) {
        toast.error('Blocked unsafe link button URL.');
        return;
      }
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }

    if (!component.custom_id) return;
    setBusy(true);
    try {
      await dispatchComponentInteraction(
        channelId,
        messageId,
        component.custom_id,
        ComponentType.Button,
      );
    } catch (err) {
      notifyComponentError('Could not run message action', err);
    } finally {
      setBusy(false);
    }
  };

  const emoji = component.emoji;
  const emojiRender = emoji ? (
    <span className="text-base leading-none">
      {emoji.id ? (
        <img
          src={`/emojis/${emoji.id}.${emoji.animated ? 'gif' : 'png'}`}
          alt={emoji.name || ''}
          className="inline-block h-4 w-4"
        />
      ) : (
        emoji.name
      )}
    </span>
  ) : null;

  return (
    <Button
      variant={variant}
      size="sm"
      className={`gap-1.5${successClasses ? ` ${successClasses}` : ''}`}
      onClick={() => void handleClick()}
      disabled={isDisabled}
      loading={busy}
      title={component.label || component.custom_id || undefined}
    >
      {emojiRender}
      {component.label && <span>{component.label}</span>}
      {isLink && <ExternalLink size={13} />}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// String Select Menu
// ---------------------------------------------------------------------------

function StringSelectMenu({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const [open, setOpen] = useState(false);
  const [selectedValues, setSelectedValues] = useState<string[]>(() => {
    return (component.options || []).filter((o) => o.default).map((o) => o.value);
  });
  const [busy, setBusy] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const options = component.options || [];
  const minValues = component.min_values ?? 1;
  const maxValues = component.max_values ?? 1;
  const isMulti = maxValues > 1;
  const isDisabled = component.disabled || busy;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const toggleOption = useCallback(
    (value: string) => {
      setSelectedValues((prev) => {
        if (isMulti) {
          if (prev.includes(value)) {
            return prev.filter((v) => v !== value);
          }
          if (prev.length >= maxValues) return prev;
          return [...prev, value];
        }
        return [value];
      });
    },
    [isMulti, maxValues],
  );

  const submitSelection = async () => {
    if (!component.custom_id || isDisabled) return;
    if (selectedValues.length < minValues) return;

    setBusy(true);
    setOpen(false);
    try {
      await dispatchComponentInteraction(
        channelId,
        messageId,
        component.custom_id,
        ComponentType.StringSelect,
        selectedValues,
      );
    } catch (err) {
      notifyComponentError('Could not submit selection', err);
    } finally {
      setBusy(false);
    }
  };

  const handleOptionClick = (value: string) => {
    if (isMulti) {
      toggleOption(value);
    } else {
      setSelectedValues([value]);
      // Auto-submit for single select
      if (!component.custom_id || isDisabled) return;
      setBusy(true);
      setOpen(false);
      void dispatchComponentInteraction(
        channelId,
        messageId,
        component.custom_id!,
        ComponentType.StringSelect,
        [value],
      ).catch((err) => notifyComponentError('Could not submit selection', err)).finally(() => setBusy(false));
    }
  };

  const displayText =
    selectedValues.length > 0
      ? options
          .filter((o) => selectedValues.includes(o.value))
          .map((o) => o.label)
          .join(', ')
      : component.placeholder || 'Make a selection...';

  return (
    <div ref={containerRef} className="relative inline-block min-w-[12rem] max-w-[25rem]">
      <button
        type="button"
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-3 text-left text-body transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-input)] ${
          isDisabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:border-border-strong'
        }`}
        onClick={() => {
          if (!isDisabled) setOpen((prev) => !prev);
        }}
        disabled={isDisabled}
      >
        <span
          className={`truncate ${
            selectedValues.length > 0 ? 'text-text-primary' : 'text-text-muted'
          }`}
        >
          {displayText}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-[140ms] ease-[var(--ease-out)] ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border-subtle bg-bg-floating p-1 shadow-lg">
          {options.map((option) => {
            const isSelected = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={`flex w-full flex-col gap-0.5 rounded-sm px-2.5 py-1.5 text-left text-label transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                  isSelected ? 'bg-accent-tint text-text-primary' : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                }`}
                onClick={() => handleOptionClick(option.value)}
              >
                <div className="flex items-center gap-2">
                  {isMulti && (
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border text-[10px] ${
                        isSelected
                          ? 'border-accent-primary bg-accent-primary text-text-on-accent'
                          : 'border-border-strong bg-transparent'
                      }`}
                    >
                      {isSelected ? '\u2713' : ''}
                    </span>
                  )}
                  <span className="truncate font-medium">{option.label}</span>
                </div>
                {option.description && (
                  <span className="text-meta text-text-muted">{option.description}</span>
                )}
              </button>
            );
          })}

          {isMulti && (
            <div className="mt-1 border-t border-border-subtle px-1 pt-2">
              <button
                type="button"
                className={`w-full rounded-sm px-2 py-1.5 text-meta font-semibold transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                  selectedValues.length >= minValues
                    ? 'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover'
                    : 'cursor-not-allowed bg-bg-mod-strong text-text-muted opacity-50'
                }`}
                onClick={() => void submitSelection()}
                disabled={selectedValues.length < minValues}
              >
                Confirm ({selectedValues.length} selected)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared dropdown shell for entity selects
// ---------------------------------------------------------------------------

interface EntityItem {
  id: string;
  label: string;
  sublabel?: string;
  avatar?: string | null;
  color?: number;
  icon?: React.ReactNode;
}

function EntitySelectMenu({
  component,
  channelId,
  messageId,
  componentType,
  loadItems,
  renderItem,
  placeholderText,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  componentType: ComponentType;
  loadItems: () => Promise<EntityItem[]>;
  renderItem: (item: EntityItem, isSelected: boolean, isMulti: boolean) => React.ReactNode;
  placeholderText: string;
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<EntityItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const minValues = component.min_values ?? 1;
  const maxValues = component.max_values ?? 1;
  const isMulti = maxValues > 1;
  const isDisabled = component.disabled || busy;

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  // Load items when opening
  const handleOpen = async () => {
    if (isDisabled) return;
    setOpen((prev) => {
      if (!prev && items.length === 0) {
        setLoading(true);
        setLoadError(null);
        void loadItems().then((loaded) => {
          setItems(loaded);
          setLoading(false);
        }).catch((err) => {
          const message = `Could not load options: ${extractApiError(err)}`;
          setLoadError(message);
          toast.error(message);
          setLoading(false);
        });
      }
      return !prev;
    });
  };

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      if (isMulti) {
        if (prev.includes(id)) return prev.filter((v) => v !== id);
        if (prev.length >= maxValues) return prev;
        return [...prev, id];
      }
      return [id];
    });
  };

  const submitSelection = async (ids: string[]) => {
    if (!component.custom_id) return;
    setBusy(true);
    setOpen(false);
    try {
      await dispatchComponentInteraction(
        channelId,
        messageId,
        component.custom_id,
        componentType,
        ids,
      );
    } catch (err) {
      notifyComponentError('Could not submit selection', err);
    } finally {
      setBusy(false);
    }
  };

  const handleItemClick = (id: string) => {
    if (isMulti) {
      toggleItem(id);
    } else {
      void submitSelection([id]);
    }
  };

  const displayText =
    selectedIds.length > 0
      ? items
          .filter((i) => selectedIds.includes(i.id))
          .map((i) => i.label)
          .join(', ')
      : component.placeholder || placeholderText;

  return (
    <div ref={containerRef} className="relative inline-block min-w-[12rem] max-w-[25rem]">
      <button
        type="button"
        className={`flex h-10 w-full items-center justify-between gap-2 rounded-sm border border-border-subtle bg-bg-tertiary px-3 text-left text-body transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:border-accent-primary focus-visible:outline-none focus-visible:shadow-[var(--focus-ring-input)] ${
          isDisabled
            ? 'cursor-not-allowed opacity-50'
            : 'cursor-pointer hover:border-border-strong'
        }`}
        onClick={() => void handleOpen()}
        disabled={isDisabled}
      >
        <span className={`truncate ${selectedIds.length > 0 ? 'text-text-primary' : 'text-text-muted'}`}>
          {displayText}
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-text-muted transition-transform duration-[140ms] ease-[var(--ease-out)] ${open ? 'rotate-180' : ''}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="absolute left-0 z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border-subtle bg-bg-floating p-1 shadow-lg">
          {loading ? (
            <LoadingSpinner className="px-3 py-3" size="sm" label="Loading options..." />
          ) : loadError ? (
            <div role="alert" className="px-2.5 py-3 text-label text-accent-danger">
              {loadError}
            </div>
          ) : items.length === 0 ? (
            <div className="px-2.5 py-3 text-center text-label text-text-muted">Nothing here to pick from yet</div>
          ) : (
            items.map((item) => {
              const isSelected = selectedIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className={`flex w-full items-center gap-2 rounded-sm px-2.5 py-1.5 text-left text-label transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                    isSelected ? 'bg-accent-tint text-text-primary' : 'text-text-secondary hover:bg-accent-tint hover:text-text-primary'
                  }`}
                  onClick={() => handleItemClick(item.id)}
                >
                  {isMulti && (
                    <span
                      className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-xs border text-[10px] ${
                        isSelected
                          ? 'border-accent-primary bg-accent-primary text-text-on-accent'
                          : 'border-border-strong bg-transparent'
                      }`}
                    >
                      {isSelected ? '\u2713' : ''}
                    </span>
                  )}
                  {renderItem(item, isSelected, isMulti)}
                </button>
              );
            })
          )}

          {isMulti && selectedIds.length > 0 && (
            <div className="mt-1 border-t border-border-subtle px-1 pt-2">
              <button
                type="button"
                className={`w-full rounded-sm px-2 py-1.5 text-meta font-semibold transition-colors duration-[140ms] ease-[var(--ease-out)] focus-visible:outline-none focus-visible:shadow-[var(--focus-ring)] ${
                  selectedIds.length >= minValues
                    ? 'bg-accent-primary text-text-on-accent hover:bg-accent-primary-hover'
                    : 'cursor-not-allowed bg-bg-mod-strong text-text-muted opacity-50'
                }`}
                onClick={() => void submitSelection(selectedIds)}
                disabled={selectedIds.length < minValues}
              >
                Confirm ({selectedIds.length} selected)
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// User Select
// ---------------------------------------------------------------------------

function UserSelectMenu({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  // Derive guildId from the channelId
  const guildId = Object.entries(channelsByGuild).find(([, chs]) =>
    chs.some((c) => c.id === channelId)
  )?.[0] ?? null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const { data } = await guildApi.getMembers(guildId);
    return (data as Member[]).map((m) => ({
      id: m.user.id,
      label: m.nick || m.user.username,
      sublabel: m.nick ? m.user.username : undefined,
      avatar: m.user.avatar_hash,
    }));
  }, [guildId]);

  const renderItem = useCallback((item: EntityItem) => {
    const avatarSrc = safeStoredImageDataUrl(item.avatar);
    return (
      <div className="flex min-w-0 items-center gap-2">
        {avatarSrc ? (
          <img
            src={avatarSrc}
            alt=""
            className="h-6 w-6 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong">
            <User size={12} className="text-text-muted" />
          </span>
        )}
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-text-primary">{item.label}</div>
          {item.sublabel && (
            <div className="truncate text-xs text-text-muted">{item.sublabel}</div>
          )}
        </div>
      </div>
    );
  }, []);

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      componentType={ComponentType.UserSelect}
      loadItems={loadItems}
      renderItem={renderItem}
      placeholderText="Select a user..."
    />
  );
}

// ---------------------------------------------------------------------------
// Role Select
// ---------------------------------------------------------------------------

function RoleSelectMenu({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  const guildId = Object.entries(channelsByGuild).find(([, chs]) =>
    chs.some((c) => c.id === channelId)
  )?.[0] ?? null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const { data } = await guildApi.getRoles(guildId);
    return (data as Role[])
      .filter((r) => r.id !== guildId) // exclude @everyone
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: r.id,
        label: r.name,
        color: r.color,
      }));
  }, [guildId]);

  const renderItem = useCallback((item: EntityItem) => {
    const colorHex = item.color ? roleColorToHex(item.color) : undefined;
    return (
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
          style={colorHex ? { backgroundColor: colorHex + '33', border: `2px solid ${colorHex}` } : undefined}
        >
          <Shield size={10} style={colorHex ? { color: colorHex } : undefined} className="text-text-muted" />
        </span>
        <span className="truncate text-sm font-medium" style={colorHex ? { color: colorHex } : undefined}>
          {item.label}
        </span>
      </div>
    );
  }, []);

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      componentType={ComponentType.RoleSelect}
      loadItems={loadItems}
      renderItem={renderItem}
      placeholderText="Select a role..."
    />
  );
}

// ---------------------------------------------------------------------------
// Mentionable Select (users + roles combined)
// ---------------------------------------------------------------------------

function MentionableSelectMenu({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  const guildId = Object.entries(channelsByGuild).find(([, chs]) =>
    chs.some((c) => c.id === channelId)
  )?.[0] ?? null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const [membersRes, rolesRes] = await Promise.all([
      guildApi.getMembers(guildId),
      guildApi.getRoles(guildId),
    ]);
    const memberItems: EntityItem[] = (membersRes.data as Member[]).map((m) => ({
      id: `user:${m.user.id}`,
      label: m.nick || m.user.username,
      sublabel: 'User',
      avatar: m.user.avatar_hash,
    }));
    const roleItems: EntityItem[] = (rolesRes.data as Role[])
      .filter((r) => r.id !== guildId)
      .sort((a, b) => b.position - a.position)
      .map((r) => ({
        id: `role:${r.id}`,
        label: r.name,
        sublabel: 'Role',
        color: r.color,
      }));
    return [...roleItems, ...memberItems];
  }, [guildId]);

  const renderItem = useCallback((item: EntityItem) => {
    const isRole = item.id.startsWith('role:');
    const colorHex = item.color ? roleColorToHex(item.color) : undefined;
    const avatarSrc = safeStoredImageDataUrl(item.avatar);
    return (
      <div className="flex min-w-0 items-center gap-2">
        {isRole ? (
          <span
            className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full"
            style={colorHex ? { backgroundColor: colorHex + '33', border: `2px solid ${colorHex}` } : undefined}
          >
            <Shield size={10} style={colorHex ? { color: colorHex } : undefined} className="text-text-muted" />
          </span>
        ) : avatarSrc ? (
          <img
            src={avatarSrc}
            alt=""
            className="h-5 w-5 shrink-0 rounded-full object-cover"
          />
        ) : (
          <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-bg-mod-strong">
            <User size={10} className="text-text-muted" />
          </span>
        )}
        <div className="min-w-0">
          <span
            className="truncate text-sm font-medium"
            style={!isRole || !colorHex ? undefined : { color: colorHex }}
          >
            {item.label}
          </span>
          {item.sublabel && (
            <span className="ml-1.5 text-xs text-text-muted">{item.sublabel}</span>
          )}
        </div>
      </div>
    );
  }, []);

  // Strip the type prefix before submitting
  const handleLoadItems = loadItems;

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      componentType={ComponentType.MentionableSelect}
      loadItems={handleLoadItems}
      renderItem={renderItem}
      placeholderText="Select a user or role..."
    />
  );
}

// ---------------------------------------------------------------------------
// Channel Select
// ---------------------------------------------------------------------------

function channelIcon(type: number) {
  if (type === 2) return <Volume2 size={12} className="text-text-muted" />;
  return <Hash size={12} className="text-text-muted" />;
}

function ChannelSelectMenu({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const channelsByGuild = useChannelStore((s) => s.channelsByGuild);

  const guildId = Object.entries(channelsByGuild).find(([, chs]) =>
    chs.some((c) => c.id === channelId)
  )?.[0] ?? null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const { data } = await guildApi.getChannels(guildId);
    return (data as Channel[])
      .filter((c) => c.type !== 4) // exclude categories
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        id: c.id,
        label: c.name || c.id,
        color: c.type,
        icon: channelIcon(c.type),
      }));
  }, [guildId]);

  const renderItem = useCallback((item: EntityItem) => (
    <div className="flex min-w-0 items-center gap-1.5">
      <span className="shrink-0">{item.icon ?? <Hash size={12} className="text-text-muted" />}</span>
      <span className="truncate text-sm font-medium text-text-primary">{item.label}</span>
    </div>
  ), []);

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      componentType={ComponentType.ChannelSelect}
      loadItems={loadItems}
      renderItem={renderItem}
      placeholderText="Select a channel..."
    />
  );
}

// ---------------------------------------------------------------------------
// Action Row
// ---------------------------------------------------------------------------

function ActionRow({
  component,
  channelId,
  messageId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
}) {
  const children = component.components || [];

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {children.map((child, index) => {
        const key = child.custom_id || `comp-${index}`;

        switch (child.type) {
          case ComponentType.Button:
            return (
              <ComponentButton
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          case ComponentType.StringSelect:
            return (
              <StringSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          case ComponentType.UserSelect:
            return (
              <UserSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          case ComponentType.RoleSelect:
            return (
              <RoleSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          case ComponentType.MentionableSelect:
            return (
              <MentionableSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          case ComponentType.ChannelSelect:
            return (
              <ChannelSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
              />
            );
          default:
            return null;
        }
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Top-level Message Components
// ---------------------------------------------------------------------------

export function MessageComponents({ components, messageId, channelId }: MessageComponentsProps) {
  if (!components || components.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      {components.map((row, index) => {
        if (row.type === ComponentType.ActionRow) {
          return (
            <ActionRow
              key={row.custom_id || `row-${index}`}
              component={row}
              channelId={channelId}
              messageId={messageId}
            />
          );
        }
        // If it's not an ActionRow at top level, still try to render it
        return null;
      })}
    </div>
  );
}
