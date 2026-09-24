import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Share2 } from 'lucide-react';
import { extractApiError } from '../../api/client';
import { apiErrorCode, NOT_IN_WORD_LIST, type DailyWordGuess } from '../../api/dailyWord';
import { useDailyWordSettings } from '../../hooks/useDailyWord';
import { useChannelActions, useCurrentChannelStore, useGuildChannels } from '../../hooks/useChannels';
import { useCurrentMessageStoreApi } from '../../hooks/useMessageStore';
import { useReducedMotion } from '../../lib/motion';
import { cn } from '../../lib/utils';
import { useDailyWordStore } from '../../stores/dailyWordStore';
import { toast } from '../../stores/toastStore';
import { useUIStore } from '../../stores/uiStore';
import { ChannelType } from '../../types';
import { Button, Plate, Select, Switch } from '../ui';
import {
  effectivePalette,
  keyboardStates,
  localTime,
  MAX_GUESSES,
  readPalette,
  shareText,
  timeUntil,
  WORD_LENGTH,
  writePalette,
} from './model';
import { ServerWordBoard } from './ServerWordBoard';
import { WordBoard } from './WordBoard';
import { WordKeyboard } from './WordKeyboard';
import { WordDistribution, WordResult, WordStats } from './WordResults';

const REVEAL_MS = 180 * WORD_LENGTH + 40;
const SHAKE_MS = 260;
const BOARD_POLL_MS = 60_000;

/** The game page: the board and keyboard, then your result and the server's board. */
export function DailyWordView({ guildId, serverName }: { guildId: string; serverName: string }) {
  const { settings, status, error: settingsError, enabled } = useDailyWordSettings(guildId);
  const today = useDailyWordStore((state) => state.today);
  const todayStatus = useDailyWordStore((state) => state.todayStatus);
  const todayError = useDailyWordStore((state) => state.todayError);
  const stats = useDailyWordStore((state) => state.stats);
  const statsError = useDailyWordStore((state) => state.statsError);
  const boardEntry = useDailyWordStore((state) => state.boards[guildId]);
  const theme = useUIStore((state) => state.theme);
  const reducedMotion = useReducedMotion();

  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [revealRow, setRevealRow] = useState<number | null>(null);
  const [shaking, setShaking] = useState(false);
  const [paletteChoice, setPaletteChoice] = useState(readPalette);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [announcement, setAnnouncement] = useState('');
  // Finished in this visit: the results ease in. On a page load they are just there.
  const [justFinished, setJustFinished] = useState(false);
  const timers = useRef<number[]>([]);

  const palette = effectivePalette(paletteChoice, theme);
  const finished = today?.finished === true;
  const revealing = revealRow !== null;
  const showResults = finished && !revealing;

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void useDailyWordStore.getState().refreshToday();
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !guildId) return;
    void useDailyWordStore.getState().refreshBoard(guildId);
    const timer = window.setInterval(() => {
      if (!document.hidden) void useDailyWordStore.getState().refreshBoard(guildId);
    }, BOARD_POLL_MS);
    return () => window.clearInterval(timer);
  }, [enabled, guildId]);

  // Once the last row has turned over: your stats, and everyone's results.
  useEffect(() => {
    if (!enabled || !showResults) return;
    void useDailyWordStore.getState().refreshStats();
    void useDailyWordStore.getState().refreshBoard(guildId);
  }, [enabled, showResults, guildId]);

  // The clock for "Next word in …", and a fresh game once midnight UTC passes.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!today) return;
    const next = Date.parse(today.next_puzzle_at);
    if (Number.isFinite(next) && nowMs >= next) {
      setInput('');
      void useDailyWordStore.getState().refreshToday();
      void useDailyWordStore.getState().refreshBoard(guildId);
    }
  }, [nowMs, today, guildId]);

  const later = useCallback((fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  }, []);

  const submit = useCallback(async () => {
    if (!today || finished || sending || revealing) return;
    if (input.length < WORD_LENGTH) {
      if (!reducedMotion) {
        setShaking(true);
        later(() => setShaking(false), SHAKE_MS);
      }
      toast.info('Not enough letters');
      return;
    }
    setSending(true);
    try {
      const next = await useDailyWordStore.getState().guess(input);
      const row = next.guesses.length - 1;
      setInput('');
      const sent = next.guesses[row];
      if (sent) setAnnouncement(announceGuess(sent, next.finished, next.solved));
      if (next.finished) setJustFinished(true);
      if (!reducedMotion) {
        setRevealRow(row);
        later(() => setRevealRow(null), REVEAL_MS);
      }
    } catch (err) {
      if (apiErrorCode(err) === NOT_IN_WORD_LIST) {
        if (!reducedMotion) {
          setShaking(true);
          later(() => setShaking(false), SHAKE_MS);
        }
        toast.info('Not in the word list');
        setAnnouncement('Not in the word list');
      } else {
        toast.error(extractApiError(err));
      }
    } finally {
      setSending(false);
    }
  }, [today, finished, sending, revealing, input, reducedMotion, later]);

  const onKey = useCallback((key: string) => {
    if (!today || finished || revealing) return;
    if (key === 'enter') {
      void submit();
      return;
    }
    if (key === 'backspace') {
      setInput((value) => value.slice(0, -1));
      return;
    }
    if (/^[a-z]$/.test(key)) {
      setInput((value) => (value.length >= WORD_LENGTH ? value : value + key));
    }
  }, [today, finished, revealing, submit]);

  // Physical keys, unless you are typing somewhere else on the page.
  useEffect(() => {
    if (!enabled) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (key === 'enter') {
        // Enter on a focused button is that button's click.
        if (target?.tagName === 'BUTTON') return;
        event.preventDefault();
        onKey('enter');
      } else if (key === 'backspace') {
        event.preventDefault();
        onKey('backspace');
      } else if (/^[a-z]$/.test(key)) {
        onKey(key);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [enabled, onKey]);

  const keyStates = useMemo(() => {
    const guesses = today?.guesses ?? [];
    // The keyboard catches up once the tiles have turned over.
    return keyboardStates(revealRow === null ? guesses : guesses.slice(0, revealRow));
  }, [today, revealRow]);

  const pickPalette = (contrast: boolean) => {
    const next = contrast ? 'contrast' : 'standard';
    writePalette(next);
    setPaletteChoice(next);
  };

  if (!guildId || status === 'idle' || status === 'loading') {
    return (
      <Page serverName={serverName}>
        <p role="status" className="text-label text-text-secondary">Loading the daily word…</p>
      </Page>
    );
  }
  if (status === 'error') {
    return (
      <Page serverName={serverName}>
        <p role="alert" className="text-body text-accent-danger">{settingsError || "The daily word couldn't be loaded."}</p>
      </Page>
    );
  }
  if (!enabled || !settings) {
    return (
      <Page serverName={serverName}>
        <p className="text-body text-text-secondary">The daily word is turned off for this server.</p>
      </Page>
    );
  }
  if (!today) {
    return (
      <Page serverName={serverName}>
        {todayStatus === 'error' ? (
          <div className="flex flex-col items-start gap-3">
            <p role="alert" className="text-body text-accent-danger">{todayError}</p>
            <Button size="sm" variant="ghost" onClick={() => void useDailyWordStore.getState().refreshToday()}>
              Try again
            </Button>
          </div>
        ) : (
          <p role="status" className="text-label text-text-secondary">Loading today's word…</p>
        )}
      </Page>
    );
  }

  const nextIn = timeUntil(today.next_puzzle_at, nowMs);
  const subtitle = `No. ${today.puzzle} · ${formatDay(today.date)}`;

  return (
    <Page
      serverName={serverName}
      subtitle={subtitle}
      palette={palette}
      aside={
        <span className="flex items-center gap-2">
          <span id="pc-word-contrast-label" className="text-meta text-text-secondary">High contrast colors</span>
          <Switch checked={palette === 'contrast'} labeledBy="pc-word-contrast-label" onChange={pickPalette} />
        </span>
      }
    >
      <div className="flex min-w-0 flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
        <div className="flex min-w-0 flex-col items-center gap-6 lg:flex-[1.1]">
          <WordBoard
            guesses={today.guesses}
            input={input}
            revealRow={revealRow}
            shaking={shaking}
            locked={finished}
          />
          {finished ? (
            <p className="text-meta text-text-muted">
              Next word in {nextIn} <span className="text-text-faint">· at {localTime(today.next_puzzle_at)}</span>
            </p>
          ) : (
            <WordKeyboard states={keyStates} disabled={sending || revealing} onKey={onKey} />
          )}
          <p className="sr-only" aria-live="polite">{announcement}</p>
        </div>

        <aside
          className={cn('flex min-w-0 flex-col gap-6 lg:flex-1', showResults && justFinished && 'pc-word-result-in')}
          aria-label="Results"
        >
          {showResults ? (
            <>
              <WordResult today={today} />
              {stats ? (
                <>
                  <WordStats stats={stats} />
                  <WordDistribution stats={stats} today={today.solved ? today.guesses.length : null} />
                </>
              ) : statsError ? (
                <p role="alert" className="text-meta text-accent-danger">{statsError}</p>
              ) : null}
              <ShareControls
                guildId={guildId}
                shareChannelId={settings.share_channel_id}
                text={shareText(today.puzzle, today.guesses, today.solved, palette, today.max_guesses)}
              />
            </>
          ) : (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-label font-semibold text-text-secondary">How to play</h2>
              <p className="text-body text-text-secondary">
                Guess the five-letter word in {MAX_GUESSES} tries. After each guess the tiles show which letters are in
                place, which are in the word somewhere else, and which are not in it.
              </p>
              <p className="text-meta text-text-muted">
                Everyone on this instance gets the same word. A new one comes in {nextIn}.
              </p>
            </section>
          )}
          <ServerWordBoard board={boardEntry?.board ?? null} error={boardEntry?.error ?? null} serverName={serverName} />
        </aside>
      </div>
    </Page>
  );
}

function announceGuess(guess: DailyWordGuess, finished: boolean, solved: boolean): string {
  const inPlace = guess.states.filter((state) => state === 'correct').length;
  const inWord = guess.states.filter((state) => state === 'present').length;
  const head = `${guess.word.toUpperCase()}: ${inPlace} in place, ${inWord} elsewhere in the word.`;
  if (solved) return `${head} Solved.`;
  if (finished) return `${head} That was the last guess.`;
  return head;
}

function formatDay(isoDay: string): string {
  const date = new Date(`${isoDay}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return isoDay;
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function ShareControls({ guildId, shareChannelId, text }: { guildId: string; shareChannelId: string | null; text: string }) {
  const channels = useGuildChannels(guildId);
  const loaded = useCurrentChannelStore((view) => view.guildChannelsLoaded[guildId] === true);
  const selectedChannelId = useCurrentChannelStore((view) => view.selectedChannelId);
  const { fetchChannels } = useChannelActions();
  const messageStore = useCurrentMessageStoreApi();
  const [picked, setPicked] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [sharedIn, setSharedIn] = useState<string | null>(null);

  const [channelsError, setChannelsError] = useState<string | null>(null);
  useEffect(() => {
    if (loaded || !guildId) return;
    Promise.resolve()
      .then(() => fetchChannels(guildId))
      .catch((err: unknown) => setChannelsError(`This server's channels couldn't be loaded: ${extractApiError(err)}`));
  }, [loaded, guildId, fetchChannels]);

  const textChannels = useMemo(
    () => channels
      .filter((channel) => (channel.type ?? channel.channel_type) === ChannelType.Text)
      .sort((a, b) => a.position - b.position),
    [channels],
  );
  const configured = shareChannelId ? textChannels.find((channel) => channel.id === shareChannelId) ?? null : null;
  const fallbackId = textChannels.some((channel) => channel.id === selectedChannelId)
    ? selectedChannelId
    : textChannels[0]?.id ?? null;
  const targetId = shareChannelId ?? picked ?? fallbackId;
  const target = textChannels.find((channel) => channel.id === targetId) ?? null;

  const share = async () => {
    if (!targetId) return;
    setSharing(true);
    try {
      await messageStore.getState().sendMessage(targetId, text);
      const name = target?.name ?? 'the channel';
      setSharedIn(name);
      toast.success(`Shared in #${name}`);
    } catch (err) {
      toast.error(`Your result wasn't shared: ${extractApiError(err)}`);
    } finally {
      setSharing(false);
    }
  };

  return (
    <section aria-label="Share" className="flex flex-col gap-2">
      <pre className="whitespace-pre-wrap rounded-[var(--radius-card)] bg-bg-mod-subtle px-3 py-2.5 font-sans text-body leading-snug text-text-primary">
        {text}
      </pre>
      <div className="flex flex-wrap items-center gap-2">
        {shareChannelId ? null : (
          <Select
            aria-label="Share in"
            className="min-w-0 max-w-[14rem] flex-1"
            value={targetId ?? ''}
            onChange={(event) => setPicked(event.target.value || null)}
            disabled={textChannels.length === 0}
          >
            {textChannels.length === 0 && <option value="">No text channels</option>}
            {textChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>#{channel.name}</option>
            ))}
          </Select>
        )}
        <Button size="lg" onClick={() => void share()} loading={sharing} disabled={!target || sharing}>
          <Share2 size={15} aria-hidden />
          {shareChannelId ? `Share in #${configured?.name ?? 'channel'}` : 'Share'}
        </Button>
      </div>
      {shareChannelId && !configured && loaded && (
        <p role="alert" className="text-meta text-accent-danger">
          The channel set for sharing results is gone or you can't see it. Ask whoever runs the server to pick another one.
        </p>
      )}
      {channelsError && <p role="alert" className="text-meta text-accent-danger">{channelsError}</p>}
      {sharedIn && <p className="text-meta text-text-muted">Posted in #{sharedIn}. No letters, just colors.</p>}
    </section>
  );
}

function Page({
  serverName,
  subtitle,
  palette = 'standard',
  aside,
  children,
}: {
  serverName: string;
  subtitle?: string;
  palette?: 'standard' | 'contrast';
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full min-w-0 overflow-x-hidden overflow-y-auto bg-bg-base p-[var(--gutter)]">
      <Plate
        as="section"
        aria-label="Daily word"
        bare
        className="pc-word flex min-w-0 flex-col gap-6 px-4 py-5 sm:px-6"
        data-palette={palette}
      >
        <header className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="font-display text-heading text-text-primary">Daily word</h1>
            <p className="truncate text-meta text-text-muted">
              {[subtitle, serverName].filter(Boolean).join(' · ')}
            </p>
          </div>
          {aside}
        </header>
        {children}
      </Plate>
    </div>
  );
}
