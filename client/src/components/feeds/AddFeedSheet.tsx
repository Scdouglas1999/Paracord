import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowLeft, Check, Loader2 } from 'lucide-react';
import {
  feedsApi,
  FEED_KINDS,
  type CreatedFeed,
  type FeedKind,
  type FeedPreview,
  type FeedSourceInput,
  type GithubMode, feedErrorMessage } from '../../api/feeds';
import type { Channel } from '../../types';
import { toast } from '../../stores/toastStore';
import {
  Button,
  ChoiceCards,
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
import { FEED_KIND_META, FeedSourceIcon } from './feedKinds';
import { inputProblem } from './feedStatus';

type Step = 'pick' | 'form' | 'done';

type PreviewState =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'found'; preview: FeedPreview }
  | { state: 'error'; message: string };

const GITHUB_MODES: ReadonlyArray<{ id: GithubMode; label: string; hint: string }> = [
  { id: 'releases', label: 'Releases', hint: 'Each new release, with its notes.' },
  { id: 'commits', label: 'Commits', hint: 'Each commit on one branch.' },
  { id: 'tags', label: 'Tags', hint: 'Each new tag.' },
];

const PREVIEW_DELAY_MS = 650;

export interface AddFeedSheetProps {
  guildId: string;
  open: boolean;
  onClose: () => void;
  twitchAvailable: boolean;
  /** Text and announcement channels in this server. */
  channels: Channel[];
  onAdded: (created: CreatedFeed) => void;
}

function sourceBody(
  kind: FeedKind,
  input: string,
  githubMode: GithubMode,
  branch: string,
  apiKey: string,
): FeedSourceInput {
  const body: FeedSourceInput = { kind, input: input.trim() };
  if (kind === 'github') {
    body.github_mode = githubMode;
    if (githubMode === 'commits') body.branch = branch.trim();
  }
  if (kind === 'jellyfin') body.api_key = apiKey.trim();
  return body;
}

/** "Add a feed": pick a source, fill in its address, see what it holds, add it. */
export function AddFeedSheet({ guildId, open, onClose, twitchAvailable, channels, onAdded }: AddFeedSheetProps) {
  const titleId = useId();
  const descriptionId = useId();
  const modeLabelId = useId();
  const [step, setStep] = useState<Step>('pick');
  const [kind, setKind] = useState<FeedKind>('rss');
  const [input, setInput] = useState('');
  const [githubMode, setGithubMode] = useState<GithubMode>('releases');
  const [branch, setBranch] = useState('main');
  const [apiKey, setApiKey] = useState('');
  const [channelId, setChannelId] = useState('');
  const [name, setName] = useState('');
  const [showOnFrontPage, setShowOnFrontPage] = useState(true);
  const [preview, setPreview] = useState<PreviewState>({ state: 'idle' });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedFeed | null>(null);
  const [posting, setPosting] = useState(false);
  const [posted, setPosted] = useState(false);
  const sequence = useRef(0);

  const meta = FEED_KIND_META[kind];
  const localProblem = inputProblem(kind, input, kind === 'github' && githubMode === 'commits' ? branch : undefined);
  const ready =
    input.trim().length > 0 && !localProblem && (kind !== 'jellyfin' || apiKey.trim().length > 0);

  // Reset everything each time the sheet opens (and only then: the channel
  // list changing under an open sheet must not throw away what was typed).
  useEffect(() => {
    if (!open) return;
    setStep('pick');
    setInput('');
    setGithubMode('releases');
    setBranch('main');
    setApiKey('');
    setName('');
    setShowOnFrontPage(true);
    setPreview({ state: 'idle' });
    setSaveError(null);
    setCreated(null);
    setPosted(false);
    setChannelId('');
  }, [open]);

  // Default to #general, else the first channel, until one is picked.
  useEffect(() => {
    if (!open) return;
    setChannelId((current) => {
      if (current && channels.some((channel) => channel.id === current)) return current;
      const general = channels.find((channel) => channel.name === 'general');
      return (general ?? channels[0])?.id ?? '';
    });
  }, [open, channels]);

  // The live preview: "Checking…", then what the source holds.
  useEffect(() => {
    if (step !== 'form') return;
    const current = ++sequence.current;
    if (!ready) {
      setPreview({ state: 'idle' });
      return;
    }
    setPreview({ state: 'checking' });
    const timer = window.setTimeout(() => {
      feedsApi
        .preview(guildId, sourceBody(kind, input, githubMode, branch, apiKey))
        .then((res) => {
          if (sequence.current === current) setPreview({ state: 'found', preview: res.data });
        })
        .catch((err: unknown) => {
          if (sequence.current === current) setPreview({ state: 'error', message: feedErrorMessage(err) });
        });
    }, PREVIEW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [step, ready, guildId, kind, input, githubMode, branch, apiKey]);

  const found = preview.state === 'found' ? preview.preview : null;
  const channelName = useMemo(
    () => channels.find((channel) => channel.id === channelId)?.name ?? 'the channel',
    [channels, channelId],
  );

  const choose = (next: FeedKind) => {
    setKind(next);
    setInput('');
    setApiKey('');
    setPreview({ state: 'idle' });
    setSaveError(null);
    setStep('form');
  };

  const submit = async () => {
    if (!found || !channelId) return;
    setSaving(true);
    setSaveError(null);
    try {
      const res = await feedsApi.create(guildId, {
        source: sourceBody(kind, input, githubMode, branch, apiKey),
        channel_id: channelId,
        name: name.trim() || undefined,
        show_on_front_page: showOnFrontPage,
      });
      setCreated(res.data);
      setStep('done');
      onAdded(res.data);
    } catch (err) {
      setSaveError(feedErrorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const postNow = async () => {
    if (!created) return;
    setPosting(true);
    try {
      await feedsApi.postLatest(guildId, created.feed.id);
      setPosted(true);
      toast.success(`Posted in #${channelName}.`);
    } catch (err) {
      toast.error(feedErrorMessage(err));
    } finally {
      setPosting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      labelledBy={titleId}
      describedBy={descriptionId}
      size="md"
      showCloseButton
      closeLabel="Close"
      panelClassName="flex flex-col"
    >
      {step === 'pick' && (
        <>
          <ModalHeader>
            <ModalTitle id={titleId}>Add a feed</ModalTitle>
            <ModalDescription id={descriptionId}>
              Where should the new items come from? Nothing old is posted: a feed starts with whatever is new after you add it.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="overflow-y-auto pb-6">
            <ul className="grid gap-2 sm:grid-cols-2">
              {FEED_KINDS.map((option) => {
                const optionMeta = FEED_KIND_META[option];
                const disabled = option === 'twitch' && !twitchAvailable;
                return (
                  <li key={option}>
                    <button
                      type="button"
                      className="pc-feed-source-tile pc-focusable h-full w-full"
                      disabled={disabled}
                      onClick={() => choose(option)}
                      aria-describedby={disabled ? `${titleId}-twitch` : undefined}
                    >
                      <FeedSourceIcon kind={option} size={32} />
                      <span className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-label font-semibold text-text-primary">{optionMeta.label}</span>
                        <span className="text-meta leading-snug text-text-secondary">
                          {disabled ? 'Your instance admin needs to add Twitch credentials first.' : optionMeta.blurb}
                        </span>
                      </span>
                    </button>
                    {disabled && (
                      <span id={`${titleId}-twitch`} className="sr-only">
                        Your instance admin needs to add Twitch credentials first.
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </ModalBody>
        </>
      )}

      {step === 'form' && (
        <>
          <ModalHeader icon={<FeedSourceIcon kind={kind} size={36} />}>
            <ModalTitle id={titleId}>{meta.label}</ModalTitle>
            <ModalDescription id={descriptionId} className="mt-1">{meta.hint}</ModalDescription>
          </ModalHeader>
          <ModalBody className="flex min-h-0 flex-col gap-5 overflow-y-auto">
            <label className="flex flex-col">
              <FieldLabel>{meta.inputLabel}</FieldLabel>
              <Input
                autoFocus
                value={input}
                placeholder={meta.placeholder}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                error={Boolean(localProblem) || preview.state === 'error'}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>

            {kind === 'github' && (
              <div className="flex flex-col">
                <FieldLabel>
                  <span id={modeLabelId}>Post</span>
                </FieldLabel>
                <ChoiceCards
                  labelledBy={modeLabelId}
                  options={GITHUB_MODES}
                  value={githubMode}
                  onChange={setGithubMode}
                  layout="row"
                />
                {githubMode === 'commits' && (
                  <label className="mt-3 flex flex-col">
                    <FieldLabel>Branch</FieldLabel>
                    <Input
                      value={branch}
                      placeholder="main"
                      spellCheck={false}
                      autoCapitalize="off"
                      onChange={(event) => setBranch(event.target.value)}
                    />
                  </label>
                )}
              </div>
            )}

            {kind === 'jellyfin' && (
              <label className="flex flex-col">
                <FieldLabel>API key</FieldLabel>
                <Input
                  type="password"
                  value={apiKey}
                  autoComplete="off"
                  placeholder="From Dashboard → API keys"
                  onChange={(event) => setApiKey(event.target.value)}
                />
                <span className="mt-1.5 text-meta leading-relaxed text-text-muted">
                  Stored encrypted on this instance and never shown again. Posters are fetched by the instance, so members never connect to your Jellyfin.
                </span>
              </label>
            )}

            <PreviewLine kind={kind} preview={preview} localProblem={localProblem} />

            {found && (
              <div className="pc-feed-row flex flex-col gap-5">
                <label className="flex flex-col">
                  <FieldLabel>Post in</FieldLabel>
                  {channels.length === 0 ? (
                    <p className="text-meta text-text-secondary">This server has no text channels to post in.</p>
                  ) : (
                    <Select value={channelId} onChange={(event) => setChannelId(event.target.value)}>
                      {channels.map((channel) => (
                        <option key={channel.id} value={channel.id}>
                          #{channel.name ?? channel.id}
                        </option>
                      ))}
                    </Select>
                  )}
                </label>
                <label className="flex flex-col">
                  <FieldLabel>Name</FieldLabel>
                  <Input
                    value={name}
                    maxLength={80}
                    placeholder={found.name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <span className="mt-1.5 text-meta text-text-muted">Posts carry this name and the source's picture.</span>
                </label>
                <ToggleRow
                  className="py-0"
                  label="Show on the front page"
                  description="New items also appear in Latest on the server's front page."
                  checked={showOnFrontPage}
                  onChange={setShowOnFrontPage}
                />
              </div>
            )}
            {saveError && <p role="alert" className="text-meta text-accent-danger">{saveError}</p>}
          </ModalBody>
          <ModalFooter className="justify-between">
            <Button variant="ghost" onClick={() => setStep('pick')}>
              <ArrowLeft size={16} aria-hidden />
              Back
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              loading={saving}
              disabled={!found || !channelId || saving}
            >
              Add feed
            </Button>
          </ModalFooter>
        </>
      )}

      {step === 'done' && created && (
        <>
          <ModalHeader
            icon={
              <span className="pc-well flex h-9 w-9 items-center justify-center text-accent-primary" aria-hidden>
                <Check size={18} />
              </span>
            }
          >
            <ModalTitle id={titleId}>Connected</ModalTitle>
            <ModalDescription id={descriptionId} className="mt-1">
              New items from {created.feed.name} will appear in #{channelName}.
            </ModalDescription>
          </ModalHeader>
          <ModalBody className="pb-2">
            {created.newest ? (
              <div className="pc-well flex flex-col gap-1 px-4 py-3">
                <span className="text-meta text-text-muted">The newest item is</span>
                <span className="text-label font-semibold text-text-primary">{created.newest.title}</span>
              </div>
            ) : (
              <p className="text-body text-text-secondary">
                {kind === 'twitch'
                  ? `${created.feed.name} isn't live right now. The next stream will post.`
                  : 'The source has nothing in it yet. The first new item will post.'}
              </p>
            )}
          </ModalBody>
          <ModalFooter>
            {created.newest && (
              <Button variant="ghost" onClick={() => void postNow()} loading={posting} disabled={posting || posted}>
                {posted ? (
                  <>
                    <Check size={16} aria-hidden />
                    Posted
                  </>
                ) : (
                  'Post it now'
                )}
              </Button>
            )}
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

function PreviewLine({
  kind,
  preview,
  localProblem,
}: {
  kind: FeedKind;
  preview: PreviewState;
  localProblem: string | null;
}) {
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
  if (preview.state === 'error') {
    return (
      <p className="text-meta leading-relaxed text-accent-danger" aria-live="polite">
        {preview.message}
      </p>
    );
  }
  const found = preview.preview;
  const count =
    kind === 'twitch'
      ? found.item_count > 0
        ? 'live now'
        : 'not live right now'
      : `${found.item_count} ${found.item_count === 1 ? 'item' : 'items'}`;
  return (
    <div className="pc-feed-row pc-well flex items-center gap-3 px-3.5 py-3" aria-live="polite">
      <FeedSourceIcon kind={kind} iconUrl={found.icon_url} size={32} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label text-text-primary">
          <span className="text-text-muted">Found: </span>
          <span className="font-semibold">{found.title}</span>
          <span className="text-text-muted">, {count}</span>
        </p>
        {found.newest && (
          <p className="mt-0.5 truncate text-meta text-text-muted">Newest: {found.newest.title}</p>
        )}
      </div>
    </div>
  );
}
