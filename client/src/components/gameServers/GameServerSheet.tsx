import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Loader2 } from 'lucide-react';
import {
  GAME_SERVER_KINDS,
  gameServerErrorMessage,
  gameServersApi,
  type GameServer,
  type GameServerKind,
  type GameServerPreview,
} from '../../api/gameServers';
import type { Channel } from '../../types';
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalDescription,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  Select,
  ToggleRow,
} from '../ui';
import { FieldLabel } from '../guild/SettingsPrimitives';
import { GAME_KIND_META, addressProblem, joinAddress, splitAddress } from './gameServerModel';
import { GameKindIcon, PlayerPile } from './GameServerParts';

type Step = 'pick' | 'form';

type PreviewState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'done'; preview: GameServerPreview }
  | { state: 'refused'; message: string };

const PREVIEW_DELAY_MS = 600;

export interface GameServerSheetProps {
  guildId: string;
  open: boolean;
  /** The server being edited; add a new one when absent. */
  editing?: GameServer | null;
  onClose: () => void;
  /** Text and announcement channels in this server. */
  channels: Channel[];
  onSaved: (server: GameServer) => void;
}

function defaultChannel(channels: Channel[]): string {
  const general = channels.find((channel) => channel.name === 'general');
  return (general ?? channels[0])?.id ?? '';
}

/** "Add a game server" and "Edit game server": type, address, name, announcements. */
export function GameServerSheet({ guildId, open, editing = null, onClose, channels, onSaved }: GameServerSheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const hostId = useId();
  const portId = useId();
  const [step, setStep] = useState<Step>('pick');
  const [kind, setKind] = useState<GameServerKind>('minecraft_java');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('');
  const [name, setName] = useState('');
  const [announce, setAnnounce] = useState(false);
  const [channelId, setChannelId] = useState('');
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const sequence = useRef(0);

  const meta = GAME_KIND_META[kind];
  const address = joinAddress(host, port);
  const localProblem = addressProblem(host, port, kind);
  const ready = host.trim().length > 0 && !localProblem;
  const unchangedAddress = Boolean(editing) && editing?.kind === kind && editing?.address === address;

  // Reset each time the sheet opens, from the server being edited if any.
  useEffect(() => {
    if (!open) return;
    setSaveError(null);
    setPreview({ state: 'idle' });
    if (editing) {
      const split = splitAddress(editing.address);
      setStep('form');
      setKind(editing.kind);
      setHost(split.host);
      setPort(split.port ?? '');
      setName(editing.name);
      setAnnounce(Boolean(editing.announce_channel_id));
      setChannelId(editing.announce_channel_id ?? defaultChannel(channels));
    } else {
      setStep('pick');
      setHost('');
      setPort('');
      setName('');
      setAnnounce(false);
      setChannelId(defaultChannel(channels));
    }
    // Only on open: the channel list changing must not wipe what was typed.
  }, [open, editing]);

  // The live check: "Checking…", then what answered.
  useEffect(() => {
    if (!open || step !== 'form') return;
    const current = ++sequence.current;
    if (!ready || unchangedAddress) {
      setPreview({ state: 'idle' });
      return;
    }
    setPreview({ state: 'checking' });
    const timer = window.setTimeout(() => {
      gameServersApi
        .preview(guildId, { kind, address })
        .then((res) => {
          if (sequence.current === current) setPreview({ state: 'done', preview: res.data });
        })
        .catch((err: unknown) => {
          if (sequence.current === current) setPreview({ state: 'refused', message: gameServerErrorMessage(err) });
        });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [open, step, ready, unchangedAddress, guildId, kind, address]);

  const choose = (next: GameServerKind) => {
    setKind(next);
    setPort(GAME_KIND_META[next].defaultPort?.toString() ?? '');
    setSaveError(null);
    setStep('form');
  };

  const changeKind = (next: GameServerKind) => {
    const previousDefault = GAME_KIND_META[kind].defaultPort?.toString() ?? '';
    setKind(next);
    // A port still at the old type's default follows the new type.
    if (!port.trim() || port.trim() === previousDefault) {
      setPort(GAME_KIND_META[next].defaultPort?.toString() ?? '');
    }
  };

  const onHostChange = (value: string) => {
    // A pasted host:port fills both fields.
    const split = splitAddress(value);
    if (split.port !== null && /^\d{1,5}$/.test(split.port)) {
      setHost(split.host);
      setPort(split.port);
    } else {
      setHost(value);
    }
  };

  const placeholderName = preview.state === 'done' ? preview.preview.name : editing?.name ?? address;
  const canSave =
    ready &&
    !saving &&
    preview.state !== 'checking' &&
    preview.state !== 'refused' &&
    (!announce || Boolean(channelId));

  const submit = async () => {
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const trimmed = name.trim();
      let saved: GameServer;
      if (editing) {
        const res = await gameServersApi.update(guildId, editing.id, {
          kind,
          address,
          name: trimmed || editing.name,
          announce_channel_id: announce ? channelId : null,
        });
        saved = res.data;
      } else {
        const res = await gameServersApi.create(guildId, {
          kind,
          address,
          name: trimmed || undefined,
          announce_channel_id: announce ? channelId : undefined,
        });
        saved = res.data;
      }
      onSaved(saved);
      onClose();
    } catch (err) {
      setSaveError(gameServerErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const channelOptions = useMemo(
    () =>
      channels.map((channel) => (
        <option key={channel.id} value={channel.id}>
          #{channel.name ?? channel.id}
        </option>
      )),
    [channels],
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      labeledBy={titleId}
      describedBy={descriptionId}
      size="md"
      showCloseButton
      closeLabel="Close"
      panelClassName="flex flex-col"
    >
      {step === 'pick' && (
        <>
          <ModalHeader>
            <ModalTitle id={titleId}>Add a game server</ModalTitle>
            <ModalDescription id={descriptionId}>
              What does it run? The instance checks it every minute and shows who is on.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="overflow-y-auto pb-6">
            <ul className="grid gap-2 sm:grid-cols-2">
              {GAME_SERVER_KINDS.map((option) => (
                <li key={option}>
                  <button
                    type="button"
                    className="pc-feed-source-tile pc-focusable h-full w-full"
                    onClick={() => choose(option)}
                  >
                    <GameKindIcon kind={option} size={32} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-label font-semibold text-text-primary">{GAME_KIND_META[option].label}</span>
                      <span className="text-meta leading-snug text-text-secondary">{GAME_KIND_META[option].blurb}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </ModalBody>
        </>
      )}

      {step === 'form' && (
        <>
          <ModalHeader icon={<GameKindIcon kind={kind} size={36} />}>
            <ModalTitle id={titleId}>{editing ? 'Edit game server' : meta.label}</ModalTitle>
            <ModalDescription id={descriptionId} className="mt-1">
              {meta.hint}
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="flex min-h-0 flex-col gap-5 overflow-y-auto">
            {editing && (
              <label className="flex flex-col">
                <FieldLabel>Type</FieldLabel>
                <Select value={kind} onChange={(event) => changeKind(event.target.value as GameServerKind)}>
                  {GAME_SERVER_KINDS.map((option) => (
                    <option key={option} value={option}>
                      {GAME_KIND_META[option].label}
                    </option>
                  ))}
                </Select>
              </label>
            )}
            <div className="grid grid-cols-[minmax(0,1fr)_6.5rem] gap-3">
              <div className="flex min-w-0 flex-col">
                <FieldLabel>
                  <label htmlFor={hostId}>Address</label>
                </FieldLabel>
                <Input
                  id={hostId}
                  autoFocus={!editing}
                  value={host}
                  placeholder={meta.hostPlaceholder}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  error={Boolean(localProblem) || preview.state === 'refused'}
                  onChange={(event) => onHostChange(event.target.value)}
                />
              </div>
              <div className="flex flex-col">
                <FieldLabel>
                  <label htmlFor={portId}>Port</label>
                </FieldLabel>
                <Input
                  id={portId}
                  value={port}
                  inputMode="numeric"
                  placeholder={meta.defaultPort?.toString() ?? '7777'}
                  autoComplete="off"
                  onChange={(event) => setPort(event.target.value.replace(/[^\d]/g, '').slice(0, 5))}
                />
              </div>
            </div>

            <PreviewLine preview={preview} localProblem={localProblem} />

            <label className="flex flex-col">
              <FieldLabel>Name</FieldLabel>
              <Input
                value={name}
                maxLength={80}
                placeholder={placeholderName || 'A name people know it by'}
                onChange={(event) => setName(event.target.value)}
              />
            </label>

            <div className="flex flex-col gap-3">
              <ToggleRow
                className="py-0"
                label="Announce when it goes down or comes back"
                description="Posted after three missed checks in a row, and again when it answers."
                checked={announce}
                onChange={setAnnounce}
              />
              {announce && (
                <label className="pc-feed-row flex flex-col">
                  <FieldLabel>Post in</FieldLabel>
                  {channels.length === 0 ? (
                    <p className="text-meta text-text-secondary">This server has no text channels to post in.</p>
                  ) : (
                    <Select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
                      {channelOptions}
                    </Select>
                  )}
                </label>
              )}
            </div>
            {saveError && <p role="alert" className="text-meta text-accent-danger">{saveError}</p>}
          </ModalBody>
          <ModalFooter className={editing ? undefined : 'justify-between'}>
            {editing ? (
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
            ) : (
              <Button variant="ghost" onClick={() => setStep('pick')}>
                <ArrowLeft size={16} aria-hidden />
                Back
              </Button>
            )}
            <Button variant="primary" onClick={() => void submit()} loading={saving} disabled={!canSave}>
              {editing ? 'Save' : 'Add game server'}
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function PreviewLine({ preview, localProblem }: { preview: PreviewState; localProblem: string | null }) {
  if (localProblem) {
    return <p className="text-meta text-accent-danger">{localProblem}</p>;
  }
  if (preview.state === 'idle') return null;
  if (preview.state === 'checking') {
    return (
      <p className="flex items-center gap-2 text-meta text-text-muted" aria-live="polite">
        <Loader2 size={14} className="animate-spin" aria-hidden />
        Checking…
      </p>
    );
  }
  if (preview.state === 'refused') {
    return (
      <p className="text-meta leading-relaxed text-accent-danger" aria-live="polite">
        {preview.message}
      </p>
    );
  }
  const found = preview.preview;
  if (!found.online) {
    return (
      <div className="pc-feed-row pc-well flex flex-col gap-1 px-3.5 py-3" aria-live="polite">
        <p className="text-label font-semibold text-text-primary">Not answering right now</p>
        <p className="text-meta leading-relaxed text-text-secondary">
          {found.error} You can still add it; it shows as down until it answers.
        </p>
      </div>
    );
  }
  const players =
    found.players_online != null
      ? `${found.players_online}${found.players_max != null ? `/${found.players_max}` : ''} online`
      : 'Up';
  const details = [players, found.map, found.version, found.latency_ms != null ? `${found.latency_ms} ms` : null]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className="pc-feed-row pc-well flex items-center gap-3 px-3.5 py-3" aria-live="polite">
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-status-up" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label text-text-primary">
          <span className="text-text-muted">Found: </span>
          <span className="font-semibold">{found.name}</span>
        </p>
        <p className="mt-0.5 truncate text-meta text-text-muted">{details}</p>
      </div>
      {found.player_names && found.player_names.length > 0 && (
        <PlayerPile names={found.player_names} total={found.players_online} max={4} />
      )}
    </div>
  );
}
