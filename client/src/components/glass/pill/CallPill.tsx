import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import { Mic, MicOff } from 'lucide-react';

import { prefersReducedMotion } from '../../../lib/motion';
import { selectStageOpen, useGlassStore } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { GlassButton, JoinButton, WatchGlyph, ListenGlyph, Waveform } from '../primitives';
import { FaceStack } from '../places/Lead';
import type { CallPillProps } from '../shell/slots';
import {
  PILL_FACES,
  collapseLevelFor,
  pillLine,
  streamLabel,
  type CollapseLevel,
  type PillTarget,
} from './model';
import { useJoinMuteStore } from './muteStore';
import {
  joinCall,
  leaveCall,
  listenBlockReason,
  toggleJoinMute,
  toggleListen,
  toggleMic,
  useListenBlockStore,
  showCall,
  watchStream,
  type PillActionTarget,
} from './pillActions';
import {
  PILL_FADE_MS,
  PILL_FADE_REDUCED_MS,
  measurePill,
  playPillResize,
  settlePill,
  type PillGeometry,
} from './pillMotion';
import { PillPreview } from './PillPreview';
import { PillRoster } from './PillRoster';
import { useCallPillTarget } from './useCallPill';

/**
 * The call pill (docs/glass-spec.md §5, §7, §8, §9; docs/design/glass-g12-checkpoint.md).
 *
 * A black capsule for the most relevant live voice channel: the call you are in,
 * else this server's busiest, else one in another server named with its server.
 * Nothing live and no call: nothing is drawn, and the header's slot takes no
 * room. Compact it is 52px: faces, name, the talking waveform, then controls.
 * Click the faces or the name and it grows to the column's width to show the
 * stream and the roster. On the phone (`layout="stacked"`) it is two rows.
 *
 * The one filled button is Join. Listen never sends (it is receive-only), Watch
 * only opens the stage (it never joins), and Leave is the only way out of a call.
 */

type Phase = 'compact' | 'expanded' | 'closing';

/** Where the column's left edge is, so the expanded pill is exactly as wide as it. */
function fitColumn(root: HTMLElement): void {
  const slot = root.parentElement;
  if (!slot) return;
  const header = slot.closest<HTMLElement>('.glass-header') ?? slot;
  const left = header.getBoundingClientRect().left + (Number.parseFloat(getComputedStyle(header).paddingLeft) || 0);
  const width = slot.getBoundingClientRect().right - left;
  if (width > 0) root.style.setProperty('--pill-col-w', `${Math.round(width)}px`);
}

/** What a screen reader hears when your part in the call changes. */
function announce(before: PillTarget['relation'], now: PillTarget['relation'], title: string): string | null {
  if (now === 'listening') return `Listening in to ${title}`;
  if (now === 'joined') return `Joined ${title}`;
  if (now === 'idle' && (before === 'joined' || before === 'listening')) return `Left ${title}`;
  return null;
}

export function CallPill({ guildId, channelId = null, layout }: CallPillProps) {
  const target = useCallPillTarget(guildId, channelId);
  const stageOpen = useGlassStore(selectStageOpen);
  // On the row the pill becomes the stage (screens/04): it is not drawn while one
  // is open. On the phone the stream sits above it and the pill stays (screens/07).
  const visible = target !== null && !(stageOpen && layout === 'row');
  if (!visible) return <HiddenPill />;
  return <PillBody target={target} layout={layout} stageOpen={stageOpen} />;
}

/** Draws nothing, and clears a stale "expanded" so it does not return with the pill. */
function HiddenPill() {
  const expanded = useGlassStore((state) => state.pillExpanded);
  const setPillExpanded = useGlassStore((state) => state.setPillExpanded);
  useEffect(() => {
    if (expanded) setPillExpanded(false);
  }, [expanded, setPillExpanded]);
  return null;
}

function PillBody({
  target,
  layout,
  stageOpen,
}: {
  target: PillTarget;
  layout: CallPillProps['layout'];
  stageOpen: boolean;
}) {
  const bodyId = useId();
  const requested = useGlassStore((state) => state.pillExpanded);
  const setPillExpanded = useGlassStore((state) => state.setPillExpanded);
  const joinMuted = useJoinMuteStore((state) => state.joinMuted);
  const selfMute = useVoiceStore((state) => state.selfMute);
  const modeSwitching = useVoiceStore((state) => state.modeSwitching);
  const blocked = useListenBlockStore((state) => state.blocked);

  const rootRef = useRef<HTMLElement | null>(null);
  const surfaceRef = useRef<HTMLSpanElement | null>(null);
  const glowRef = useRef<HTMLSpanElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const whoRef = useRef<HTMLButtonElement | null>(null);
  const firstRef = useRef<PillGeometry | null>(null);

  // The words fade before the capsule shrinks, so closing takes a short
  // "closing" phase. It starts in the same render that sees the request, so no
  // frame is drawn between (React's "adjusting state while rendering").
  const [closing, setClosing] = useState(false);
  const [askedFor, setAskedFor] = useState(requested);
  if (requested !== askedFor) {
    setAskedFor(requested);
    setClosing(!requested);
  }
  const phase: Phase = requested ? 'expanded' : closing ? 'closing' : 'compact';
  const [collapse, setCollapse] = useState<CollapseLevel>(0);
  const [slotWidth, setSlotWidth] = useState(0);
  const [announcement, setAnnouncement] = useState('');

  const { relation } = target;
  const joined = relation === 'joined';
  const listening = relation === 'listening' || (relation === 'joining' && target.mode === 'listen');
  const busy = relation === 'joining' || modeSwitching;
  const muted = joined ? selfMute : joinMuted;
  const streamer = target.streamer;
  const watchLabel = streamer ? streamLabel(streamer) : null;
  const canWatch = Boolean(streamer) && !stageOpen;
  // Nobody else's screen to watch: in the call, the stage can still show the
  // call itself (cameras, sharing, the call's controls).
  const canShowCall = joined && !streamer && !stageOpen;
  const blockReason = listenBlockReason(blocked, target);
  const line = pillLine(target, joined && selfMute);
  const talker = target.talkers[0] ?? null;
  // In a call this client holds, the engine publishes each voice's level and the
  // waveform follows it; outside one there is only "somebody is talking".
  const realVoice = relation === 'joined' || relation === 'listening';

  const action = useMemo<PillActionTarget>(
    () => ({ serverId: target.serverId, guildId: target.guildId, channelId: target.channelId, title: target.title }),
    [target.serverId, target.guildId, target.channelId, target.title],
  );

  /* ---- Opening and closing ---------------------------------------------- */
  const stacked = layout === 'stacked';

  useEffect(() => {
    if (!closing) return undefined;
    const timer = setTimeout(
      () => {
        firstRef.current = measurePill(surfaceRef.current, whoRef.current);
        setClosing(false);
      },
      prefersReducedMotion() ? PILL_FADE_REDUCED_MS : PILL_FADE_MS,
    );
    return () => clearTimeout(timer);
  }, [closing]);

  /** Ask for the roster, remembering where the capsule is so the move can play. */
  const setExpanded = useCallback(
    (next: boolean) => {
      firstRef.current = next ? measurePill(surfaceRef.current, whoRef.current) : null;
      setPillExpanded(next);
    },
    [setPillExpanded],
  );

  // What the row can afford to draw (§5), decided before the browser paints. The
  // pill's natural width at each level is measured by drawing it there.
  const fitSignature = [
    target.title,
    relation,
    Math.min(target.faces.length, PILL_FACES),
    target.faces.length > PILL_FACES,
    canWatch,
    canShowCall,
    listening,
    line ?? '',
  ].join('|');

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || stacked) return;
    if (phase !== 'compact') fitColumn(root);
    const bar = barRef.current;
    const available = phase === 'compact' ? root.parentElement?.clientWidth ?? 0 : bar?.clientWidth ?? 0;
    const level = collapseLevelFor(available, (candidate) => {
      root.dataset.collapse = String(candidate);
      return phase === 'compact' ? root.offsetWidth : bar?.scrollWidth ?? 0;
    });
    root.dataset.collapse = String(level);
    setCollapse((previous) => (previous === level ? previous : level));
  }, [phase, stacked, slotWidth, fitSignature]);

  // The capsule changed size or place this commit: play the difference.
  const previousPhase = useRef<Phase>(phase);
  useLayoutEffect(() => {
    const was = previousPhase.current;
    previousPhase.current = phase;
    if (was === phase || (was === 'compact') === (phase === 'compact')) return;
    const first = firstRef.current;
    firstRef.current = null;
    if (stacked || !first) return;
    const surface = surfaceRef.current;
    const who = whoRef.current;
    if (!surface || !who) return;
    const glow = glowRef.current;
    settlePill(surface, glow, who);
    const last = measurePill(surface, who);
    if (last) playPillResize(surface, glow, who, first, last);
  }, [phase, stacked]);

  // The room the header gives the pill, so the labels can go when it is short.
  useEffect(() => {
    const slot = rootRef.current?.parentElement;
    if (!slot || stacked || typeof ResizeObserver === 'undefined') return undefined;
    const header = slot.closest<HTMLElement>('.glass-header') ?? slot;
    const observer = new ResizeObserver(() => {
      setSlotWidth(Math.round(slot.clientWidth));
      const root = rootRef.current;
      if (root && root.dataset.phase !== 'compact') fitColumn(root);
    });
    observer.observe(slot);
    if (header !== slot) observer.observe(header);
    return () => observer.disconnect();
  }, [stacked]);

  /* ---- Keyboard and focus ------------------------------------------------- */
  const collapseToFaces = useCallback(() => {
    const root = rootRef.current;
    const inside = root?.contains(document.activeElement) ?? false;
    setExpanded(false);
    // The words are about to go: the focus goes back to what opened them.
    if (inside) whoRef.current?.focus();
  }, [setExpanded]);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || phase !== 'expanded') return;
    event.preventDefault();
    collapseToFaces();
  };

  /* ---- Saying what happened ----------------------------------------------- */
  const [seenRelation, setSeenRelation] = useState(relation);
  if (relation !== seenRelation) {
    setSeenRelation(relation);
    const said = announce(seenRelation, relation, target.title);
    if (said) setAnnouncement(said);
  }

  /* ---- What the buttons do ------------------------------------------------- */
  const onListen = () => {
    if (busy || (!listening && blockReason)) return;
    void toggleListen(action, listening);
  };
  const onJoin = () => {
    if (busy) return;
    void joinCall(action);
  };
  const onWatch = () => {
    if (streamer) watchStream(action, streamer.userId);
  };
  const onShowCall = () => showCall(action);

  const expanded = phase !== 'compact';
  const faces = target.faces.map((person) => ({ userId: person.userId, name: person.name, avatar: person.avatar }));
  const shownFaces = faces.slice(0, PILL_FACES);
  const moreFaces = faces.length - shownFaces.length;

  const listenTitle = blockReason
    ?? (listening
      ? 'Stop listening in'
      : `Hear ${target.channelName} quietly before joining. Everyone there can see you're listening.`);

  /* ---- Pieces --------------------------------------------------------------- */
  const wave = (
    <span className="glass-pill__wave-slot">
      {talker && (
        <Waveform
          className="glass-pill__wave"
          {...(realVoice ? { 'data-real': '', 'data-motion-speaking': talker.userId } : {})}
        />
      )}
    </span>
  );

  // A DM call has no listening in: that is for server voice channels (§7).
  const listenButton = target.isDm ? null : (
    <GlassButton
      variant="glass"
      tone="amber"
      pressed={listening}
      className="glass-pill__listen"
      aria-label={listening ? `Stop listening in to ${target.channelName}` : `Listen in to ${target.channelName}`}
      aria-disabled={busy || (!listening && Boolean(blockReason)) ? true : undefined}
      aria-busy={busy || undefined}
      title={listenTitle}
      onClick={onListen}
    >
      <ListenGlyph size={stacked ? 18 : 17} />
      <span className="glass-pill__label">{listening ? 'Listening' : 'Listen'}</span>
    </GlassButton>
  );

  const watchButton = canWatch && watchLabel && (
    <GlassButton
      variant="text"
      className="glass-pill__watch"
      aria-label={`Watch ${watchLabel}`}
      title={`Watch ${watchLabel} beside the chat`}
      onClick={onWatch}
    >
      <WatchGlyph className="glass-pill__watch-icon" size={17} />
      <span className="glass-pill__label">Watch</span>
    </GlassButton>
  );

  const showCallButton = canShowCall && (
    <GlassButton
      variant="text"
      className="glass-pill__watch glass-pill__show-call"
      aria-label="Show the call"
      title="Show the call: cameras, screen sharing and the call's controls"
      onClick={onShowCall}
    >
      <WatchGlyph className="glass-pill__watch-icon" size={17} />
      <span className="glass-pill__label">Show call</span>
    </GlassButton>
  );

  const muteCircle = (
    <GlassButton
      variant="icon"
      className="glass-pill__mute"
      pressed={!muted}
      aria-label="Microphone on when you join"
      title={muted ? "You'll join muted" : 'Your microphone will be on when you join'}
      onClick={() => void toggleJoinMute(listening)}
    >
      {muted ? <MicOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Mic size={16} strokeWidth={1.8} aria-hidden="true" />}
    </GlassButton>
  );

  const micButton = (
    <GlassButton
      variant="icon"
      className="glass-pill__mic"
      pressed={!selfMute}
      aria-label="Microphone"
      title={selfMute ? 'Unmute' : 'Mute'}
      onClick={() => void toggleMic()}
    >
      {selfMute ? <MicOff size={16} strokeWidth={1.8} aria-hidden="true" /> : <Mic size={16} strokeWidth={1.8} aria-hidden="true" />}
    </GlassButton>
  );

  const joinButton = (
    <JoinButton
      className="glass-pill__join"
      aria-label={`Join ${target.title}`}
      aria-disabled={busy ? true : undefined}
      onClick={onJoin}
    >
      Join
    </JoinButton>
  );

  const leaveButton = (
    <GlassButton
      variant="text"
      className="glass-pill__leave"
      aria-label={`Leave ${target.title}`}
      aria-disabled={busy ? true : undefined}
      onClick={() => void leaveCall()}
    >
      Leave
    </GlassButton>
  );

  const bodyNode = expanded && (
    <div id={bodyId} className="glass-pill__body">
      {streamer && watchLabel && (
        <PillPreview target={target} streamerId={streamer.userId} label={watchLabel} onWatch={onWatch} />
      )}
      <PillRoster
        channelName={target.channelName}
        occupants={target.occupants}
        listeningNote={listening ? `Everyone in ${target.channelName} can see you're listening in.` : null}
      />
    </div>
  );

  const regionLabel = target.isDm ? `${target.title}, voice call` : `${target.title}, live voice channel`;

  return (
    <section
      ref={rootRef}
      className="glass-pill"
      aria-label={regionLabel}
      data-layout={layout}
      data-phase={phase}
      data-collapse={stacked ? undefined : collapse}
      data-relation={relation}
      data-note={listening ? 'true' : undefined}
      data-cross-server={target.crossServer ? 'true' : undefined}
      style={{ '--pill-fade': `${prefersReducedMotion() ? PILL_FADE_REDUCED_MS : PILL_FADE_MS}ms` } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <span ref={glowRef} className="glass-pill__glow" aria-hidden="true" />
      <span ref={surfaceRef} className="glass-pill__surface" aria-hidden="true" />

      {stacked ? (
        <>
          <div className="glass-pill__top">
            <button
              ref={whoRef}
              type="button"
              className="glass-pill__who glass-focusable"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              aria-label={`Show who's in ${target.title}`}
              onClick={() => setExpanded(!(phase === 'expanded'))}
            >
              <FaceStack faces={shownFaces} size={24} overlap={7} className="glass-pill__faces" />
              {moreFaces > 0 && <span className="glass-pill__more">+{moreFaces}</span>}
              <span className="glass-pill__lines">
                <span className="glass-pill__title">
                  <span className="glass-pill__name" title={target.title}>{target.title}</span>
                  {wave}
                </span>
                {line && <span className="glass-pill__sub">{line}</span>}
              </span>
            </button>
          </div>
          <div className="glass-pill__actions">
            {joined ? (
              <>
                {!target.audience && micButton}
                {watchButton}
                {showCallButton}
                {leaveButton}
              </>
            ) : (
              <>
                {listenButton}
                {watchButton}
                {muteCircle}
                {joinButton}
              </>
            )}
          </div>
          {bodyNode}
        </>
      ) : (
        <>
          <div ref={barRef} className="glass-pill__bar">
            <button
              ref={whoRef}
              type="button"
              className="glass-pill__who glass-focusable"
              aria-expanded={expanded}
              aria-controls={expanded ? bodyId : undefined}
              aria-label={`Show who's in ${target.title}`}
              onClick={() => setExpanded(phase !== 'expanded')}
            >
              <FaceStack faces={shownFaces} size={24} overlap={7} className="glass-pill__faces" />
              {moreFaces > 0 && <span className="glass-pill__more">+{moreFaces}</span>}
              <span className="glass-pill__name" title={target.title}>{target.title}</span>
              {wave}
              {(expanded || target.reconnecting) && line && <span className="glass-pill__sub">{line}</span>}
            </button>
            <div className="glass-pill__controls">
              {joined ? (
                <>
                  {!target.audience && micButton}
                  {watchButton}
                  {showCallButton}
                  {leaveButton}
                </>
              ) : (
                <>
                  {listenButton}
                  {watchButton}
                  {muteCircle}
                  {joinButton}
                </>
              )}
            </div>
          </div>
          {bodyNode}
        </>
      )}

      <span className="sr-only" role="status">
        {announcement}
      </span>
    </section>
  );
}
