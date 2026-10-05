import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Check, Lock, Search, X } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { fileApi } from '../../api/files';
import { useAvailableChannels } from '../../hooks/useChannels';
import { useAvailableGuilds } from '../../hooks/useGuilds';
import { MAX_FILE_SIZE } from '../../lib/constants';
import { composeDmForwardBody, sealedForwardFor } from '../../lib/forwardedMessage';
import { entityScopeKey, type AccountScope } from '../../lib/serverScope';
import { displayName } from '../../lib/displayName';
import { useAccountStore } from '../../stores/accountStore';
import { confirm } from '../../stores/confirmStore';
import { useChannelStore } from '../../stores/channelStore';
import { useInstanceStore } from '../../stores/instanceStore';
import { getMessageStore } from '../../stores/messageStore';
import { toast } from '../../stores/toastStore';
import type { ForwardedFromRequest, Message } from '../../types';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/Feedback';
import { Input, Textarea } from '../ui/Input';
import { Modal, ModalDescription, ModalFooter, ModalHeader, ModalTitle } from '../ui/Modal';
import { Avatar, AvatarStack, ServerMark } from '../ix/identity';
import { cn } from '../../lib/utils';

const MAX_TARGETS = 5;

/** The face a row shows: the server's mark, a person's avatar, or a group's faces (§2.3). */
type ForwardFace =
  | { kind: 'server'; guildId: string; name: string; icon: string | null; hue: number | null }
  | { kind: 'people'; people: Array<{ userId: string; name: string; avatar: string | null }> };

interface ForwardTarget {
  key: string;
  id: string;
  scope: AccountScope;
  label: string;
  detail: string;
  encrypted: boolean;
  recent: bigint;
  face: ForwardFace;
}

function TargetFace({ face }: { face: ForwardFace }) {
  if (face.kind === 'server') {
    return <ServerMark guildId={face.guildId} name={face.name} icon={face.icon} hue={face.hue} size={32} />;
  }
  const [first, second] = face.people;
  if (!first) return null;
  if (!second) return <Avatar userId={first.userId} name={first.name} avatar={first.avatar} size={32} />;
  return <AvatarStack people={face.people.slice(0, 2)} size={26} overlap={10} ring="var(--ix-card)" />;
}

function snowflake(id: string | null | undefined): bigint {
  if (!id) return 0n;
  try {
    return BigInt(id);
  } catch {
    return 0n;
  }
}

/** Text channels, announcement channels and threads take a forward. */
function forwardableType(type: number | undefined): boolean {
  return type === 0 || type === 5 || type === 6;
}

/**
 * Forward: choose up to five conversations on this instance, add an optional
 * note, and send. Each forward goes through the target's ordinary send path,
 * so a direct message is encrypted as usual. When either end is a server
 * channel the server checks the forwarder can read the original and rewrites
 * the attribution from it; between two encrypted conversations the
 * attribution is sealed into the encrypted body instead.
 */
export function ForwardPicker({
  message,
  scope,
  sourceEncrypted,
  open,
  onClose,
}: {
  message: Message;
  /** The account the original was read through. Only its instance can verify a forward. */
  scope: AccountScope;
  sourceEncrypted: boolean;
  open: boolean;
  onClose: () => void;
}) {
  const guilds = useAvailableGuilds();
  const channelsByGuild = useChannelStore((state) => state.channelsByGuild);
  const conversations = useAvailableChannels();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<ForwardTarget[]>([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [needsUnlock, setNeedsUnlock] = useState(false);
  const [sending, setSending] = useState(false);
  const unlocked = useAccountStore((state) => state.isUnlocked);

  const allTargets = useMemo(() => {
    const rows: ForwardTarget[] = [];
    for (const guild of guilds) {
      if (guild.scope.serverId !== scope.serverId) continue;
      for (const channel of channelsByGuild[entityScopeKey(guild.scope, guild.id)] ?? []) {
        if (!forwardableType(channel.channel_type ?? channel.type)) continue;
        rows.push({
          key: entityScopeKey(guild.scope, channel.id),
          id: channel.id,
          scope: guild.scope,
          label: `#${channel.name || 'untitled'}`,
          detail: guild.name,
          encrypted: false,
          recent: snowflake(channel.last_message_id),
          face: {
            kind: 'server',
            guildId: guild.id,
            name: guild.name,
            icon: guild.icon_hash ?? guild.icon ?? null,
            hue: guild.hue ?? null,
          },
        });
      }
    }
    for (const channel of conversations) {
      if (channel.guild_id || channel.scope.serverId !== scope.serverId) continue;
      const type = channel.channel_type ?? channel.type;
      if (type !== 1 && type !== 3) continue;
      rows.push({
        key: entityScopeKey(channel.scope, channel.id),
        id: channel.id,
        scope: channel.scope,
        label: channel.recipient ? displayName(channel.recipient) : channel.name || 'Group conversation',
        detail: type === 3 ? 'Group conversation' : 'Direct message',
        encrypted: true,
        recent: snowflake(channel.last_message_id),
        face: {
          kind: 'people',
          people: (type === 3 ? (channel.recipients ?? []) : channel.recipient ? [channel.recipient] : []).map((person) => ({
            userId: person.id,
            name: displayName(person),
            avatar: person.avatar_hash ?? null,
          })),
        },
      });
    }
    // Most recently active first, the same order the sidebar uses.
    rows.sort((a, b) => (a.recent === b.recent ? 0 : a.recent > b.recent ? -1 : 1));
    return rows;
  }, [guilds, channelsByGuild, conversations, scope.serverId]);

  const targets = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return allTargets;
    return allTargets.filter((row) => `${row.label} ${row.detail}`.toLowerCase().includes(needle));
  }, [allTargets, query]);

  const selectedKeys = new Set(selected.map((row) => row.key));

  function toggle(target: ForwardTarget) {
    setError(null);
    if (selectedKeys.has(target.key)) {
      setSelected((current) => current.filter((row) => row.key !== target.key));
      return;
    }
    if (selected.length >= MAX_TARGETS) {
      setError(`You can forward to ${MAX_TARGETS} conversations at a time.`);
      return;
    }
    setSelected((current) => [...current, target]);
  }

  /** A server message's files, fetched once, for targets that must encrypt them. */
  async function filesForEncryptedTargets(): Promise<File[]> {
    const attachments = message.attachments ?? [];
    return Promise.all(attachments.map(async (attachment) => {
      const { data } = await fileApi.download(attachment.id);
      return new File([data], attachment.filename, {
        type: attachment.content_type || data.type || 'application/octet-stream',
      });
    }));
  }

  async function send() {
    if (selected.length === 0 || sending) return;
    const quote = (message.content ?? '').trim();
    // Between two encrypted conversations the attribution rides inside the
    // encrypted body, so the instance never learns where the text came from.
    const sealed = sourceEncrypted ? sealedForwardFor(message) : null;
    const missingText = sourceEncrypted && selected.some((target) => (target.encrypted ? !sealed?.quote : !quote));
    if (missingText) {
      setError('This message has no text to forward.');
      return;
    }
    // A direct message or group is sealed on this device. With the identity
    // locked (every page load locks it) the send can only fail, so say how to
    // open it before anything goes out.
    if (selected.some((target) => target.encrypted) && !useAccountStore.getState().isUnlocked) {
      setNeedsUnlock(true);
      setError('Unlock encryption on this device to forward into a direct message or group.');
      return;
    }
    setNeedsUnlock(false);
    const publicTargets = selected.filter((target) => !target.encrypted);
    if (sourceEncrypted && publicTargets.length > 0) {
      const names = publicTargets.map((target) => target.label).join(', ');
      const ok = await confirm({
        title: 'Forward outside this conversation?',
        description: `This conversation is end-to-end encrypted. Forwarding posts this message unencrypted in ${names}.`,
        confirmLabel: 'Forward',
      });
      if (!ok) return;
    }
    setSending(true);
    setError(null);
    const sent: string[] = [];
    try {
      const needsFiles = !sourceEncrypted
        && (message.attachments?.length ?? 0) > 0
        && selected.some((target) => target.encrypted);
      const files = needsFiles ? await filesForEncryptedTargets() : [];
      const maxCiphertextBytes = useInstanceStore.getState().getActiveMaxUploadSize() ?? MAX_FILE_SIZE;
      for (const target of selected) {
        const store = getMessageStore(target.scope).getState();
        if (sealed && target.encrypted) {
          // The server has no plaintext for either end: the quote travels
          // inside the encrypted body after the note, and the attribution
          // with it. Nothing about the source is sent in the clear.
          await store.sendMessage(
            target.id,
            composeDmForwardBody(note, sealed.quote),
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            sealed.forward,
          );
          sent.push(target.label);
          continue;
        }
        const forwarded: ForwardedFromRequest = { channel_id: message.channel_id, message_id: message.id };
        if (sourceEncrypted) forwarded.content = quote;
        await store.sendMessage(
          target.id,
          note.trim(),
          undefined,
          undefined,
          undefined,
          undefined,
          target.encrypted && files.length > 0 ? { files, maxCiphertextBytes } : undefined,
          forwarded,
        );
        sent.push(target.label);
      }
      toast.success(sent.length === 1 ? `Forwarded to ${sent[0]}` : `Forwarded to ${sent.length} conversations`);
      onClose();
    } catch (err) {
      const reason = extractApiError(err);
      setError(sent.length > 0 ? `${reason} Already sent to ${sent.join(', ')}.` : reason);
      // Targets that already went out are not sent twice on a retry.
      setSelected((current) => current.filter((target) => !sent.includes(target.label)));
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      labeledBy="forward-title"
      size="sm"
      placement="center"
      panelClassName="flex max-h-[min(80dvh,40rem)] flex-col"
    >
      <ModalHeader className="pb-2">
        <ModalTitle id="forward-title">Forward</ModalTitle>
        <ModalDescription className="mt-1 text-[13px]">Choose up to {MAX_TARGETS} conversations.</ModalDescription>
      </ModalHeader>

      <div className="flex flex-col gap-2.5 px-[22px] pb-2 pt-1">
        <div className="relative">
          <Search size={15} aria-hidden className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--ix-ink-3)]" />
          <Input
            type="search"
            aria-label="Search conversations"
            placeholder="Search channels and conversations"
            className="pl-9 [&::-webkit-search-cancel-button]:appearance-none"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        {selected.length > 0 && (
          <ul aria-label="Forwarding to" className="flex flex-wrap gap-1.5">
            {selected.map((target) => (
              <li key={target.key}>
                <button
                  type="button"
                  className="pc-focusable inline-flex h-7 max-w-[14rem] items-center gap-1 rounded-[8px] bg-[var(--ix-fill-2)] pl-2.5 pr-1.5 text-[12.5px] font-semibold text-[var(--ix-ink)] transition-colors duration-[55ms] ease-[var(--ix-ease)] hover:bg-[var(--ix-fill-ctl-hover)]"
                  onClick={() => toggle(target)}
                  aria-label={`Remove ${target.label}`}
                >
                  <span className="truncate">{target.label}</span>
                  <X size={12} aria-hidden className="shrink-0 text-[var(--ix-ink-3)]" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-1 scrollbar-thin">
        {targets.length === 0 ? (
          <EmptyState
            className="px-2"
            icon={<Search size={20} />}
            title="Nothing matches"
            description={query.trim() ? `No channel or conversation matches “${query.trim()}”.` : 'There is nowhere on this instance to forward to yet.'}
          />
        ) : (
          targets.map((target) => {
            const on = selectedKeys.has(target.key);
            return (
              <button
                key={target.key}
                type="button"
                aria-pressed={on}
                className={cn(
                  'pc-focusable flex w-full items-center gap-3 rounded-[12px] px-2.5 py-2 text-left transition-colors duration-[55ms] ease-[var(--ix-ease)]',
                  on ? 'bg-[var(--ix-fill-2)]' : 'hover:bg-[var(--ix-fill)]',
                )}
                onClick={() => toggle(target)}
              >
                <TargetFace face={target.face} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] font-semibold text-[var(--ix-ink)]">{target.label}</span>
                  <span className="flex items-center gap-1 truncate text-[12.5px] text-[var(--ix-ink-3)]">
                    {target.encrypted && <Lock size={11} aria-label="End-to-end encrypted" className="shrink-0" />}
                    <span className="truncate">{target.detail}</span>
                  </span>
                </span>
                <span
                  className={cn(
                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-full transition-colors duration-[55ms] ease-[var(--ix-ease)]',
                    on
                      ? 'bg-[var(--ix-cream)] text-[var(--ix-cream-ink)]'
                      : 'shadow-[inset_0_0_0_1.5px_var(--ix-edge-strong)]',
                  )}
                  aria-hidden
                >
                  {on && <Check size={12} strokeWidth={3} />}
                </span>
              </button>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-2.5 px-[22px] pb-0 pt-2">
        <Textarea
          aria-label="Note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={2}
          maxLength={1800}
          placeholder="Add a note (optional)"
          className="min-h-[3.5rem] resize-none"
        />
        {error && (
          <p role="alert" className="rounded-[12px] bg-[var(--ix-danger-fill)] px-3.5 py-2.5 text-[13px] font-medium leading-relaxed text-[var(--ix-danger-ink)]">
            {error}
            {needsUnlock && !unlocked && (
              <Link
                className="ml-2 underline"
                to={`/unlock?${new URLSearchParams({ returnTo: window.location.pathname + window.location.search })}`}
                onClick={onClose}
              >
                Unlock encryption
              </Link>
            )}
          </p>
        )}
      </div>
      <ModalFooter className="pt-3">
        <Button variant="ghost" onClick={onClose} disabled={sending}>Cancel</Button>
        <Button onClick={() => void send()} disabled={selected.length === 0} loading={sending}>
          {selected.length > 1 ? `Send to ${selected.length}` : 'Send'}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
