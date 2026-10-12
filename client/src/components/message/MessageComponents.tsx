import { getAccountChannelView } from '../../lib/channelView';
import { getServerAccountScope } from '../../lib/serverIdentity';
import { useServerListStore } from '../../stores/serverListStore';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { useCurrentChannelStore } from '../../hooks/useChannels';
import { useState, useRef, useEffect, useCallback } from 'react';
import { ExternalLink, Hash, Shield, Volume2 } from 'lucide-react';
import { ComponentType, ButtonStyle, type Component } from '../../types/components';
import { InteractionType } from '../../types/interactions';
import type { Interaction } from '../../types/interactions';
import { extractApiError } from '../../api/client';
import { getApi } from '../../api/activeClient';
import { guildApi } from '../../api/guilds';
import { useInteractionStore } from '../../stores/interactionStore';
import { toast } from '../../stores/toastStore';
import type { Member, Role, Channel } from '../../types';
import { safeExternalUrl } from '../../lib/security';
import { roleColorToHex } from '../../lib/colors';
import { IxGlyph } from '../ix/glyphs/IxGlyph';
import { Avatar } from '../ix/identity/Avatar';
import { displayName } from '../../lib/displayName';
import { useDownloadTicket } from '../../hooks/useDownloadTicket';
import { CustomEmojiImage } from '../ui/ResourceImage';
import { CordSpinner } from '../brand/CordMark';

interface MessageComponentsProps {
  components: Component[];
  messageId: string;
  channelId: string;
  guildId?: string;
}

function resolveGuildIdForChannel(channelId: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const channelsByGuild = getAccountChannelView(getServerAccountScope(useServerListStore.getState().activeServerId ?? LOCAL_SERVER_ID)).channelsByGuild;
  return Object.entries(channelsByGuild).find(([, chs]) =>
    chs.some((c) => c.id === channelId),
  )?.[0];
}

/** Dispatch a MessageComponent interaction to the server. */
async function dispatchComponentInteraction(
  channelId: string,
  messageId: string,
  customId: string,
  componentType: ComponentType,
  values?: string[],
  guildId?: string,
): Promise<void> {
  const resolvedGuildId = resolveGuildIdForChannel(channelId, guildId);
  if (!resolvedGuildId) {
    throw new Error('Could not resolve the server for this channel');
  }
  const { data: interaction } = await getApi().post<Interaction>('/interactions', {
    type: InteractionType.MessageComponent,
    guild_id: resolvedGuildId,
    channel_id: channelId,
    message_id: messageId,
    custom_id: customId,
    component_type: componentType,
    values,
    data: {
      custom_id: customId,
      component_type: componentType,
      values,
    },
  });
  // Track pending so Modal (type 9) responses can stamp channel/guild/application.
  if (interaction?.id) {
    useInteractionStore.getState().addPendingInteraction(interaction);
  }
}

function notifyComponentError(action: string, err: unknown): void {
  toast.error(`${action}: ${extractApiError(err)}`);
}

// ---------------------------------------------------------------------------
// Button Component
// ---------------------------------------------------------------------------

// A bot's button style, in Index's controls (docs/index-spec.md §8.4). Cream is
// the one action on a surface, so a bot's Primary is cream only when it is the
// message's only Primary; with several, each carries a lit edge instead. Success
// is the same lit edge (Index has no green), Danger is the one danger color,
// Link is text, and Secondary is the quiet control.
type BotTone = 'cream' | 'primary' | 'danger' | 'link' | undefined;

function toneForStyle(style: number, onlyPrimary: boolean): BotTone {
  switch (style) {
    case ButtonStyle.Primary:
      return onlyPrimary ? 'cream' : 'primary';
    case ButtonStyle.Success:
      return 'primary';
    case ButtonStyle.Danger:
      return 'danger';
    case ButtonStyle.Link:
      return 'link';
    default:
      return undefined;
  }
}

/** How many Primary buttons the message has, across every row. */
function countPrimaryButtons(components: Component[]): number {
  let count = 0;
  for (const row of components) {
    for (const child of row.components || []) {
      if (child.type === ComponentType.Button && (child.style ?? ButtonStyle.Secondary) === ButtonStyle.Primary) count += 1;
    }
  }
  return count;
}

function ComponentButton({
  component,
  channelId,
  messageId,
  guildId,
  onlyPrimary,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
  /** This message has exactly one Primary button. */
  onlyPrimary: boolean;
}) {
  const [busy, setBusy] = useState(false);
  // A custom-emoji button face is an authenticated image; re-render when the
  // download ticket its URL needs is minted.
  useDownloadTicket();

  const style = component.style ?? ButtonStyle.Secondary;
  const isLink = style === ButtonStyle.Link;
  const isDisabled = component.disabled || busy;

  const tone = toneForStyle(style, onlyPrimary);

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
        undefined,
        guildId,
      );
    } catch (err) {
      notifyComponentError('Could not run message action', err);
    } finally {
      setBusy(false);
    }
  };

  const emoji = component.emoji;
  // A custom emoji lives behind the guild's authenticated image route, reached
  // with a download ticket — `/emojis/<id>.png` is not a path this server ever
  // served, so a button decorated with one used to render a broken image.
  const emojiRender = emoji ? (
    <span className="text-base leading-none">
      {emoji.id && guildId ? (
        <CustomEmojiImage
          guildId={guildId}
          emojiId={emoji.id}
          alt={emoji.name || ''}
          className="inline-block h-4 w-4"
          fallback={<>{emoji.name}</>}
        />
      ) : (
        emoji.name
      )}
    </span>
  ) : null;

  return (
    <button
      type="button"
      className="ix-bot-btn"
      data-tone={tone}
      onClick={() => void handleClick()}
      disabled={isDisabled}
      aria-busy={busy || undefined}
      title={component.label || component.custom_id || undefined}
    >
      {busy && <CordSpinner className="ix-bot-btn__busy" />}
      {emojiRender}
      {component.label && <span>{component.label}</span>}
      {isLink && <ExternalLink size={13} aria-hidden />}
    </button>
  );
}

// ---------------------------------------------------------------------------
// String Select Menu
// ---------------------------------------------------------------------------

function StringSelectMenu({
  component,
  channelId,
  messageId,
  guildId,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
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
        guildId,
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
        guildId,
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
    <div ref={containerRef} className="ix-bot-select">
      <SelectTrigger
        open={open}
        disabled={isDisabled}
        hasValue={selectedValues.length > 0}
        text={displayText}
        onToggle={() => {
          if (!isDisabled) setOpen((prev) => !prev);
        }}
      />

      {open && (
        <div className="ix-bot-select__pop">
          {options.map((option) => {
            const isSelected = selectedValues.includes(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className="ix-bot-select__opt"
                data-selected={isSelected || undefined}
                onClick={() => handleOptionClick(option.value)}
              >
                <span className="ix-bot-select__line">
                  {isMulti && <ChoiceMark chosen={isSelected} />}
                  <span className="ix-bot-select__label">{option.label}</span>
                </span>
                {option.description && <span className="ix-bot-select__desc">{option.description}</span>}
              </button>
            );
          })}

          {isMulti && (
            <ConfirmFoot
              count={selectedValues.length}
              enabled={selectedValues.length >= minValues}
              onConfirm={() => void submitSelection()}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The select's shared parts: the trigger, a choice mark, the Confirm row
// ---------------------------------------------------------------------------

function SelectTrigger({
  open,
  disabled,
  hasValue,
  text,
  onToggle,
}: {
  open: boolean;
  disabled: boolean;
  hasValue: boolean;
  text: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      className="ix-bot-select__btn"
      aria-expanded={open}
      aria-label={text}
      onClick={onToggle}
      disabled={disabled}
    >
      <span className="ix-bot-select__value" data-placeholder={hasValue ? undefined : ''}>
        {text}
      </span>
      <IxGlyph name="chevron" size={14} className="ix-bot-select__chevron" />
    </button>
  );
}

/** A multi-select's choice: a ring, cream and checked once chosen. */
function ChoiceMark({ chosen }: { chosen: boolean }) {
  return (
    <span className="ix-bot-select__mark" aria-hidden>
      {chosen && <IxGlyph name="check" size={12} />}
    </span>
  );
}

/** A multi-select sends nothing until you confirm: one cream button under the list. */
function ConfirmFoot({ count, enabled, onConfirm }: { count: number; enabled: boolean; onConfirm: () => void }) {
  return (
    <div className="ix-bot-select__foot">
      <button type="button" className="ix-bot-select__confirm" onClick={onConfirm} disabled={!enabled}>
        Confirm ({count} selected)
      </button>
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
  guildId,
  componentType,
  loadItems,
  renderItem,
  placeholderText,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
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
    // MentionableSelect uses user:/role: prefixes for disambiguation in the UI;
    // the API requires bare snowflake IDs.
    const submitIds =
      componentType === ComponentType.MentionableSelect
        ? ids.map((id) => id.replace(/^(user|role):/, ''))
        : ids;
    try {
      await dispatchComponentInteraction(
        channelId,
        messageId,
        component.custom_id,
        componentType,
        submitIds,
        guildId,
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
    <div ref={containerRef} className="ix-bot-select">
      <SelectTrigger
        open={open}
        disabled={isDisabled}
        hasValue={selectedIds.length > 0}
        text={displayText}
        onToggle={() => void handleOpen()}
      />

      {open && (
        <div className="ix-bot-select__pop">
          {loading ? (
            <p className="ix-bot-select__note" role="status">Loading options…</p>
          ) : loadError ? (
            <div role="alert" className="ix-bot-select__note">
              {loadError}
            </div>
          ) : items.length === 0 ? (
            <p className="ix-bot-select__note">Nothing here to pick from yet</p>
          ) : (
            items.map((item) => {
              const isSelected = selectedIds.includes(item.id);
              return (
                <button
                  key={item.id}
                  type="button"
                  className="ix-bot-select__opt"
                  data-selected={isSelected || undefined}
                  onClick={() => handleItemClick(item.id)}
                >
                  <span className="ix-bot-select__line">
                    {isMulti && <ChoiceMark chosen={isSelected} />}
                    {renderItem(item, isSelected, isMulti)}
                  </span>
                </button>
              );
            })
          )}

          {isMulti && selectedIds.length > 0 && (
            <ConfirmFoot
              count={selectedIds.length}
              enabled={selectedIds.length >= minValues}
              onConfirm={() => void submitSelection(selectedIds)}
            />
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
  guildId: guildIdProp,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
}) {
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);
  // Member avatars in this list are authenticated images; re-render when the
  // download ticket lands.
  useDownloadTicket();

  // Derive guildId from the channelId
  const guildId =
    guildIdProp ??
    Object.entries(channelsByGuild).find(([, chs]) =>
      chs.some((c) => c.id === channelId)
    )?.[0] ??
    null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const { data } = await guildApi.getMembers(guildId);
    return (data as Member[]).map((m) => ({
      id: m.user.id,
      label: displayName(m.user, m.nick),
      sublabel: displayName(m.user, m.nick) !== m.user.username ? m.user.username : undefined,
      avatar: m.user.avatar_hash,
    }));
  }, [guildId]);

  const renderItem = (item: EntityItem) => (
    <>
      <Avatar userId={item.id} name={item.label} avatar={item.avatar} size={24} />
      <span className="ix-bot-select__label">
        {item.label}
        {item.sublabel && <span className="ix-bot-select__desc">{` ${item.sublabel}`}</span>}
      </span>
    </>
  );

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      guildId={guildId ?? undefined}
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
  guildId: guildIdProp,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
}) {
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);

  const guildId =
    guildIdProp ??
    Object.entries(channelsByGuild).find(([, chs]) =>
      chs.some((c) => c.id === channelId)
    )?.[0] ??
    null;

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

  // A role's own color is its data: the shield and the name carry it.
  const renderItem = useCallback((item: EntityItem) => {
    const colorHex = item.color ? roleColorToHex(item.color) : undefined;
    return (
      <>
        <span className="ix-bot-select__role" style={colorHex ? { color: colorHex } : undefined}>
          <Shield size={12} aria-hidden />
        </span>
        <span className="ix-bot-select__label" style={colorHex ? { color: colorHex } : undefined}>
          {item.label}
        </span>
      </>
    );
  }, []);

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      guildId={guildId ?? undefined}
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
  guildId: guildIdProp,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
}) {
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);
  // Member avatars in this list are authenticated images; re-render when the
  // download ticket lands.
  useDownloadTicket();

  const guildId =
    guildIdProp ??
    Object.entries(channelsByGuild).find(([, chs]) =>
      chs.some((c) => c.id === channelId)
    )?.[0] ??
    null;

  const loadItems = useCallback(async (): Promise<EntityItem[]> => {
    if (!guildId) return [];
    const [membersRes, rolesRes] = await Promise.all([
      guildApi.getMembers(guildId),
      guildApi.getRoles(guildId),
    ]);
    const memberItems: EntityItem[] = (membersRes.data as Member[]).map((m) => ({
      id: `user:${m.user.id}`,
      label: displayName(m.user, m.nick),
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

  const renderItem = (item: EntityItem) => {
    const isRole = item.id.startsWith('role:');
    const colorHex = item.color ? roleColorToHex(item.color) : undefined;
    return (
      <>
        {isRole ? (
          <span className="ix-bot-select__role" style={colorHex ? { color: colorHex } : undefined}>
            <Shield size={12} aria-hidden />
          </span>
        ) : (
          <Avatar userId={item.id.replace(/^user:/, '')} name={item.label} avatar={item.avatar} size={24} />
        )}
        <span className="ix-bot-select__label" style={isRole && colorHex ? { color: colorHex } : undefined}>
          {item.label}
          {item.sublabel && <span className="ix-bot-select__desc">{` ${item.sublabel}`}</span>}
        </span>
      </>
    );
  };

  // Strip the type prefix before submitting (handled in EntitySelectMenu for MentionableSelect)
  const handleLoadItems = loadItems;

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      guildId={guildId ?? undefined}
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
  if (type === 2) return <Volume2 size={14} aria-hidden />;
  return <Hash size={14} aria-hidden />;
}

function ChannelSelectMenu({
  component,
  channelId,
  messageId,
  guildId: guildIdProp,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
}) {
  const channelsByGuild = useCurrentChannelStore((s) => s.channelsByGuild);

  const guildId =
    guildIdProp ??
    Object.entries(channelsByGuild).find(([, chs]) =>
      chs.some((c) => c.id === channelId)
    )?.[0] ??
    null;

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
    <>
      <span className="ix-bot-select__role">{item.icon ?? <Hash size={14} aria-hidden />}</span>
      <span className="ix-bot-select__label">{item.label}</span>
    </>
  ), []);

  return (
    <EntitySelectMenu
      component={component}
      channelId={channelId}
      messageId={messageId}
      guildId={guildId ?? undefined}
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
  guildId,
  onlyPrimary,
}: {
  component: Component;
  channelId: string;
  messageId: string;
  guildId?: string;
  onlyPrimary: boolean;
}) {
  const children = component.components || [];

  return (
    <div className="ix-bot__row">
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
                guildId={guildId}
                onlyPrimary={onlyPrimary}
              />
            );
          case ComponentType.StringSelect:
            return (
              <StringSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
                guildId={guildId}
              />
            );
          case ComponentType.UserSelect:
            return (
              <UserSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
                guildId={guildId}
              />
            );
          case ComponentType.RoleSelect:
            return (
              <RoleSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
                guildId={guildId}
              />
            );
          case ComponentType.MentionableSelect:
            return (
              <MentionableSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
                guildId={guildId}
              />
            );
          case ComponentType.ChannelSelect:
            return (
              <ChannelSelectMenu
                key={key}
                component={child}
                channelId={channelId}
                messageId={messageId}
                guildId={guildId}
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

export function MessageComponents({ components, messageId, channelId, guildId }: MessageComponentsProps) {
  if (!components || components.length === 0) return null;
  const onlyPrimary = countPrimaryButtons(components) === 1;

  return (
    <div className="ix-bot">
      {components.map((row, index) => {
        if (row.type === ComponentType.ActionRow) {
          return (
            <ActionRow
              key={row.custom_id || `row-${index}`}
              component={row}
              channelId={channelId}
              messageId={messageId}
              guildId={guildId}
              onlyPrimary={onlyPrimary}
            />
          );
        }
        // If it's not an ActionRow at top level, still try to render it
        return null;
      })}
    </div>
  );
}
