import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';

import { createTogetherApi } from '../../../api/together';
import { gateway } from '../../../gateway/manager';
import { currentItem } from '../../../lib/together/model';
import { setActivitySource } from '../../../lib/presenceActivities';
import { togetherActivity } from '../../../lib/together/presence';
import { useTogetherStore } from '../../../stores/togetherStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { TogetherPlayer, type PlayerStatus } from './TogetherPlayer';

/**
 * Where the shared player should appear. The Stage (watch) or the now-playing
 * bar (listen) puts a {@link TogetherSlot} in its layout; the one player lives
 * in {@link TogetherHost} and is laid over whichever slot is mounted.
 *
 * The player is not rendered inside the slot because moving a YouTube iframe
 * in the DOM reloads it: walking from the call to a text channel and back must
 * not restart the video, and the music must keep playing while you read chat.
 */
interface SlotState {
  element: HTMLElement | null;
  variant: 'stage' | 'bar';
  attach: (element: HTMLElement, variant: 'stage' | 'bar') => void;
  detach: (element: HTMLElement) => void;
}

const useTogetherSlot = create<SlotState>()((set, get) => ({
  element: null,
  variant: 'stage',
  attach: (element, variant) => set({ element, variant }),
  detach: (element) => {
    if (get().element === element) set({ element: null });
  },
}));

export function TogetherSlot({ variant, className }: { variant: 'stage' | 'bar'; className?: string }) {
  const previous = useRef<HTMLElement | null>(null);
  const ref = useCallback(
    (element: HTMLDivElement | null) => {
      const slot = useTogetherSlot.getState();
      if (previous.current && previous.current !== element) slot.detach(previous.current);
      previous.current = element;
      if (element) slot.attach(element, variant);
    },
    [variant],
  );
  return <div ref={ref} className={className} data-together-slot={variant} />;
}

/** Off screen but alive: audio keeps playing while you are elsewhere in the app. */
const PARKED = { left: -10_000, top: 0, width: 320, height: 180 };

/**
 * The one shared player of the call you are in, mounted once for the whole app.
 * It also keeps the call's session fresh (on joining, and after every gateway
 * snapshot, which is what a reconnect delivers) and hands the "Watching …"
 * presence activity to the shared activity composer while a session plays.
 */
export function TogetherHost() {
  const connected = useVoiceStore((s) => s.connected);
  const channelId = useVoiceStore((s) => (s.connected ? s.channelId : null));
  const guildId = useVoiceStore((s) => s.guildId);
  const serverId = useVoiceStore((s) => s.callScope?.serverId ?? null);
  const snapshotSeq = useVoiceStore((s) => s.voiceSnapshotSeq);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const session = useTogetherStore((s) => (channelId ? s.calls[channelId]?.session ?? null : null));
  const volume = useTogetherStore((s) => s.volume);
  const slot = useTogetherSlot((s) => s.element);
  const variant = useTogetherSlot((s) => s.variant);
  const boxRef = useRef<HTMLDivElement>(null);
  const inServerCall = connected && guildId != null && guildId !== 'dm';
  const api = useMemo(() => (serverId ? createTogetherApi(serverId) : null), [serverId]);

  // Fetch the call's session when you join and after every reconnect.
  useEffect(() => {
    if (!inServerCall || !api || !channelId || !serverId) return;
    let canceled = false;
    gateway.sampleServerClock(serverId);
    api
      .get(channelId)
      .then((update) => {
        if (!canceled) useTogetherStore.getState().applySessionUpdate({ ...update, action: null }, null);
      })
      .catch(() => {
        // An older server has no Together routes; the sheet says so when used.
      });
    return () => {
      canceled = true;
    };
  }, [inServerCall, api, channelId, serverId, snapshotSeq]);

  // Leaving the call forgets its session: the server stops sending it.
  const lastChannel = useRef<string | null>(null);
  useEffect(() => {
    const previous = lastChannel.current;
    lastChannel.current = channelId;
    if (previous && previous !== channelId) useTogetherStore.getState().forgetCall(previous);
  }, [channelId]);

  // A fresh clock sample whenever a new session starts in this call.
  const sessionId = session?.session_id ?? null;
  useEffect(() => {
    if (sessionId && serverId) gateway.sampleServerClock(serverId);
  }, [sessionId, serverId]);

  // "Watching …" / "Listening to …" wins over any detected activity while it
  // lasts. The shared activity composer sends it (Now playing workstream).
  const activity = togetherActivity(inServerCall ? session : null);
  const activityKey = activity ? `${activity.type}|${activity.details}` : '';
  const activityRef = useRef(activity);
  activityRef.current = activity;
  useEffect(() => {
    setActivitySource('together', activityRef.current);
  }, [activityKey]);
  useEffect(() => () => setActivitySource('together', null), []);

  // Lay the player over the slot, following it through layout changes and the
  // Stage's own entrance motion.
  //
  // It follows in BURSTS, not forever: a frame loop that reads the slot's box
  // on every frame keeps the main thread awake on a screen where nothing moves
  // (the motion law: an idle screen runs nothing). A burst of frame-by-frame
  // following starts whenever something could have moved the slot — it
  // resized, the window resized or scrolled, or an animation or transition
  // started anywhere (the Stage entering, a panel easing in) — and stops once
  // the slot has held still for a little while. The box moves by transform, so
  // following a moving slot is a compositor job rather than a relayout.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let frame = 0;
    let last = '';
    let stillFrames = 0;
    const place = () => {
      const rect = slot?.getBoundingClientRect();
      const visible = rect && rect.width > 0 && rect.height > 0;
      const next = visible
        ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        : PARKED;
      const key = `${next.left}|${next.top}|${next.width}|${next.height}`;
      if (key !== last) {
        const sized = !last.endsWith(`|${next.width}|${next.height}`);
        last = key;
        stillFrames = 0;
        box.style.left = '0px';
        box.style.top = '0px';
        box.style.transform = `translate3d(${next.left}px, ${next.top}px, 0)`;
        if (sized) {
          box.style.width = `${next.width}px`;
          box.style.height = `${next.height}px`;
        }
        box.style.opacity = visible ? '1' : '0';
        box.style.pointerEvents = visible ? 'auto' : 'none';
        box.setAttribute('aria-hidden', visible ? 'false' : 'true');
      } else {
        stillFrames += 1;
      }
      // Half a second of stillness ends the burst.
      frame = slot && stillFrames < 30 ? window.requestAnimationFrame(place) : 0;
    };
    const follow = () => {
      stillFrames = 0;
      if (!frame) frame = window.requestAnimationFrame(place);
    };
    place();
    const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(follow) : null;
    if (slot && resize) resize.observe(slot);
    window.addEventListener('resize', follow);
    document.addEventListener('scroll', follow, true);
    document.addEventListener('animationstart', follow, true);
    document.addEventListener('transitionrun', follow, true);
    return () => {
      window.cancelAnimationFrame(frame);
      resize?.disconnect();
      window.removeEventListener('resize', follow);
      document.removeEventListener('scroll', follow, true);
      document.removeEventListener('animationstart', follow, true);
      document.removeEventListener('transitionrun', follow, true);
    };
  }, [slot, session != null]);

  const onStatus = useCallback(
    (status: PlayerStatus) => {
      useTogetherStore.getState().setPlayerStatus({ ...status, itemId: currentItem(session)?.id ?? null });
    },
    [session],
  );

  if (!inServerCall || !session || !serverId || !api) return null;

  return createPortal(
    <div
      ref={boxRef}
      data-together-host=""
      className="fixed z-[5] overflow-hidden"
      style={{
        left: 0,
        top: 0,
        width: PARKED.width,
        height: PARKED.height,
        transform: `translate3d(${PARKED.left}px, ${PARKED.top}px, 0)`,
        borderRadius: variant === 'stage' ? 'var(--radius-card)' : 'var(--radius-control)',
      }}
    >
      <TogetherPlayer
        session={session}
        serverId={serverId}
        api={api}
        variant={variant}
        volume={volume}
        muted={selfDeaf}
        onStatus={onStatus}
      />
    </div>,
    document.body,
  );
}
