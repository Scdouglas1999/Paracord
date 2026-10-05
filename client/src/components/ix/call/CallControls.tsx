import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { AudioLines, Clapperboard, Hand, MonitorUp, SlidersHorizontal, Stethoscope, UserPlus, Volume2 } from 'lucide-react';

import { usePermissions } from '../../../hooks/usePermissions';
import { toggleVoiceVideo } from '../../../hooks/useVoice';
import { useClip } from '../../../lib/media/clips/useClip';
import { useLingering } from '../../../lib/motion';
import { cn } from '../../../lib/utils';
import { isStreamTarget, type StageTarget } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { hasPermission, Permissions } from '../../../types';
import { InviteModal } from '../../guild/InviteModal';
import { joinCall, leaveCall, toggleMic, voiceGuildOf } from '../../glass/pill/pillActions';
import type { StageModel } from '../../glass/stage/stageModel';
import { shareQualityLabel, useShareQualityStore, useShareScreen } from '../../glass/stage/useShareScreen';
import { useStageChannel } from '../../glass/stage/useStageChannel';
import { ScreenSharePickerModal } from '../../voice/ScreenSharePickerModal';
import { SoundboardPopover } from '../../voice/SoundboardPopover';
import { useAnchoredOverlayCoords, useOverlayDismiss } from '../../voice/streamOverlayPortal';
import { TogetherSheetFor } from '../../voice/together/TogetherButton';
import { useTogether } from '../../voice/together/useTogether';
import { VoiceConnectionCheck } from '../../voice/VoiceConnectionCheck';
import { IxGlyph } from '../glyphs';
import { DeviceMenu, MoreMenu, ShareQualityMenu, usePushToTalk, type MoreItem } from './CallMenus';
import { controlSet } from './callModel';

/**
 * The call view's controls (docs/index-spec.md §7.2, §3.1): centered capsule
 * buttons, 46 tall, radius 23.
 *
 *   joined     mic (right-click, Shift+F10 or a long press: the device menu
 *              with Deafen), camera, screen ("Stop sharing" while you share),
 *              then Clip while a stream is in focus, More, and Leave.
 *   audience   a stage channel's audience: Request to speak in place of the
 *              mic, camera and screen.
 *   watching   not in the call: Clip, then Join (cream).
 *
 * More: Soundboard, Watch together, Invite people, Share quality, Microphone
 * and speaker, Stream volume and quality (a stream in focus), Connection
 * check. Every action is the one the Glass stage's control row used (the
 * pill's `joinCall` / `leaveCall` / `toggleMic`, `toggleVoiceVideo`,
 * `useShareScreen`, `useClip`, `useStageChannel`); only the look is new.
 *
 * There are no stream reactions (flame, heart): the owner removed them in
 * 1bc00a09 and IX-19 deleted the route, the event and the code (index-spec §7.2).
 */

const LONG_PRESS_MS = 520;

export interface CallControlsProps {
  target: StageTarget;
  model: StageModel;
  /** A stream is in focus: Clip, and More's stream volume and quality. */
  streamFocused: boolean;
  /** Opens the stream overlay's sound and quality panel. */
  onStreamSound: () => void;
}

export function CallControls({ target, model, streamFocused, onStreamSound }: CallControlsProps) {
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfVideo = useVoiceStore((state) => state.selfVideo);
  const modeSwitching = useVoiceStore((state) => state.modeSwitching);
  const set = controlSet(model);

  const stream = streamFocused && isStreamTarget(target) ? target : null;
  const clip = useClip(stream ? { ...stream, streamerName: model.streamerName } : null);
  const share = useShareScreen();
  const stageSession = useStageChannel(model.stageChannel ? target.channelId : null);
  const { isPttMode, pttEngaged } = usePushToTalk();

  const micRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [deviceMenu, setDeviceMenu] = useState<'mic' | 'more' | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dialog, setDialog] = useState<'invite' | 'check' | 'together' | 'soundboard' | 'quality' | null>(null);
  const shareQuality = useShareQualityStore((state) => state.quality);

  const busy = model.busy || modeSwitching;
  const action = { serverId: target.serverId, guildId: voiceGuildOf(target.guildId), channelId: target.channelId, title: model.channelName };

  const onClip = () => {
    if (!clip.available) {
      toast.info(clip.unavailableReason ?? 'Clips are not available.');
      return;
    }
    clip.clip().catch((error: unknown) => {
      toast.error(error instanceof Error ? error.message : 'The clip could not be saved.');
    });
  };

  /* ---- The microphone's menu: right-click, Shift+F10, long press ---------------- */
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const onMicPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') return;
    longPressed.current = false;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setDeviceMenu('mic');
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const closeDevices = useCallback(() => setDeviceMenu(null), []);

  /* ---- More ------------------------------------------------------------------ */
  const closeMore = useCallback((returnFocus: boolean) => {
    setMoreOpen(false);
    if (returnFocus) moreRef.current?.focus();
  }, []);
  const guildScope = target.guildId;
  const { permissions, isAdmin } = usePermissions(guildScope);
  const canSoundboard = Boolean(guildScope) && (isAdmin || hasPermission(permissions, Permissions.USE_SOUNDBOARD));
  const canInvite = Boolean(guildScope) && (isAdmin || hasPermission(permissions, Permissions.CREATE_INSTANT_INVITE));
  const together = useTogether();

  const moreItems: MoreItem[] = [];
  if (canSoundboard) moreItems.push({ id: 'soundboard', label: 'Soundboard', icon: <AudioLines size={18} />, onSelect: () => setDialog('soundboard') });
  if (together) {
    moreItems.push({
      id: 'together',
      label: together.session ? 'Add to what is playing' : 'Watch together',
      icon: <Clapperboard size={18} />,
      onSelect: () => setDialog('together'),
    });
  }
  if (canInvite) moreItems.push({ id: 'invite', label: 'Invite people', icon: <UserPlus size={18} />, onSelect: () => setDialog('invite') });
  if (set === 'joined') {
    moreItems.push({
      id: 'quality',
      label: `Share quality: ${shareQualityLabel(shareQuality)}`,
      icon: <MonitorUp size={18} />,
      onSelect: () => setDialog('quality'),
    });
  }
  moreItems.push({ id: 'devices', label: 'Microphone and speaker', icon: <SlidersHorizontal size={18} />, onSelect: () => setDeviceMenu('more') });
  if (stream) moreItems.push({ id: 'stream', label: 'Stream volume and quality', icon: <Volume2 size={18} />, onSelect: onStreamSound });
  moreItems.push({ id: 'check', label: 'Connection check', icon: <Stethoscope size={18} />, onSelect: () => setDialog('check') });

  /* ---- Soundboard (anchored to More) ---------------------------------------------- */
  const soundboardLayer = useLingering(dialog === 'soundboard');
  const soundboardPanelRef = useRef<HTMLDivElement | null>(null);
  const soundboardCoords = useAnchoredOverlayCoords(dialog === 'soundboard', moreRef, 'above-end', 300);
  const closeSoundboard = useCallback(() => setDialog((open) => (open === 'soundboard' ? null : open)), []);
  const insideSoundboard = useCallback(
    (node: Node) => Boolean(soundboardPanelRef.current?.contains(node) || moreRef.current?.contains(node)),
    [],
  );
  useOverlayDismiss(dialog === 'soundboard', closeSoundboard, insideSoundboard);

  /* ---- The row ------------------------------------------------------------------ */
  const clipButton = stream && (
    <button
      type="button"
      className="ix-call-btn"
      aria-disabled={!clip.available || clip.saving || undefined}
      aria-keyshortcuts="C"
      title={clip.available ? 'Clip the last 30 seconds (C)' : clip.unavailableReason ?? undefined}
      onClick={onClip}
    >
      <IxGlyph name="clip" size={18} />
      <span>Clip</span>
    </button>
  );
  const moreButton = (
    <button
      ref={moreRef}
      type="button"
      className="ix-call-btn ix-call-btn--icon"
      aria-label="More call actions"
      aria-haspopup="menu"
      aria-expanded={moreOpen}
      title="More"
      onClick={() => setMoreOpen((open) => !open)}
    >
      <IxGlyph name="dots" size={18} />
    </button>
  );
  const leaveButton = (
    <button
      type="button"
      className="ix-call-btn ix-call-btn--danger"
      data-testid="ix-call-leave"
      aria-label={`Leave ${model.channelName}`}
      title="Leave the call"
      onClick={() => void leaveCall()}
    >
      Leave
    </button>
  );

  return (
    <div className="ix-call-controls" role="group" aria-label="Call controls" data-set={set}>
      {set === 'joined' && (
        <>
          <CallMicButton
            micRef={micRef}
            selfMute={selfMute}
            isPttMode={isPttMode}
            pttEngaged={pttEngaged}
            menuOpen={deviceMenu === 'mic'}
            onToggle={() => {
              if (longPressed.current) {
                longPressed.current = false;
                return;
              }
              void toggleMic();
            }}
            onMenu={() => setDeviceMenu('mic')}
            onPointerDown={onMicPointerDown}
            onPointerEnd={cancelPress}
          />
          <button
            type="button"
            className="ix-call-btn ix-call-btn--icon"
            aria-label="Camera"
            aria-pressed={selfVideo}
            title={selfVideo ? 'Turn off camera' : 'Turn on camera'}
            onClick={() => {
              toggleVoiceVideo().catch((error: unknown) => {
                toast.error(`Could not ${selfVideo ? 'turn off' : 'turn on'} your camera: ${error instanceof Error ? error.message : 'try again.'}`);
              });
            }}
          >
            <IxGlyph name="camera" size={18} />
          </button>
          <button
            type="button"
            className={cn('ix-call-btn', !share.sharing && 'ix-call-btn--icon')}
            aria-label={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            aria-pressed={share.sharing}
            aria-busy={share.starting || undefined}
            title={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            onClick={share.toggle}
          >
            <IxGlyph name="screen" size={18} />
            {share.sharing && <span>Stop sharing</span>}
          </button>
          {clipButton}
          {moreButton}
          {leaveButton}
        </>
      )}
      {set === 'audience' && (
        <>
          <button
            type="button"
            className="ix-call-btn"
            aria-pressed={model.handRaised}
            aria-disabled={stageSession.requestBusy || !stageSession.instance || undefined}
            aria-busy={stageSession.requestBusy || undefined}
            title={
              !stageSession.instance
                ? 'Nobody has opened the stage yet.'
                : model.handRaised
                  ? 'Lower your hand'
                  : 'Ask the stage moderators to invite you to speak'
            }
            onClick={() => {
              if (stageSession.requestBusy || !stageSession.instance) return;
              stageSession.toggleRequest(model.handRaised);
            }}
          >
            <Hand size={18} strokeWidth={1.8} aria-hidden="true" />
            <span>{model.handRaised ? 'Request sent' : 'Request to speak'}</span>
          </button>
          {clipButton}
          {moreButton}
          {leaveButton}
        </>
      )}
      {set === 'watching' && (
        <>
          {clipButton}
          <button
            type="button"
            className="ix-call-btn ix-call-btn--cream"
            aria-label={`Join ${model.channelName}`}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (busy) return;
              void joinCall(action);
            }}
          >
            {model.busy ? 'Joining…' : 'Join'}
          </button>
        </>
      )}

      <MoreMenu open={moreOpen} anchorRef={moreRef} items={moreItems} onClose={closeMore} />
      <DeviceMenu open={deviceMenu !== null} anchorRef={deviceMenu === 'more' ? moreRef : micRef} onClose={closeDevices} />
      {soundboardLayer.value && guildScope && (
        <SoundboardPopover
          guildId={guildScope}
          channelId={target.channelId}
          coords={soundboardCoords}
          panelRef={soundboardPanelRef}
          leaving={soundboardLayer.leaving}
        />
      )}
      <TogetherSheetFor anchor={moreRef} open={dialog === 'together'} onClose={() => setDialog(null)} />
      {dialog === 'invite' && (
        <InviteModal guildName={model.guildName ?? model.place} channelId={target.channelId} onClose={() => setDialog(null)} />
      )}
      <VoiceConnectionCheck open={dialog === 'check'} onClose={() => setDialog(null)} />
      <ShareQualityMenu open={dialog === 'quality'} anchorRef={moreRef} onClose={() => setDialog(null)} />
      {share.pickerOpen && !share.sharing && (
        <ScreenSharePickerModal
          sources={share.sources}
          loading={share.sourcesLoading}
          error={share.error}
          loadThumbnail={share.loadThumbnail}
          onClose={share.closePicker}
          onRefresh={share.refreshSources}
          onSelect={share.pick}
        />
      )}
    </div>
  );
}

function CallMicButton({
  micRef,
  selfMute,
  isPttMode,
  pttEngaged,
  menuOpen,
  onToggle,
  onMenu,
  onPointerDown,
  onPointerEnd,
}: {
  micRef: RefObject<HTMLButtonElement | null>;
  selfMute: boolean;
  isPttMode: boolean;
  pttEngaged: boolean;
  menuOpen: boolean;
  onToggle: () => void;
  onMenu: () => void;
  onPointerDown: (event: ReactPointerEvent<HTMLButtonElement>) => void;
  onPointerEnd: () => void;
}) {
  return (
    <button
      ref={micRef}
      type="button"
      className="ix-call-btn ix-call-btn--icon"
      aria-label="Microphone"
      aria-pressed={isPttMode ? !selfMute && pttEngaged : !selfMute}
      aria-haspopup="dialog"
      aria-expanded={menuOpen}
      aria-keyshortcuts="Shift+F10"
      data-muted={selfMute ? 'true' : 'false'}
      data-ptt={isPttMode ? (pttEngaged ? 'talking' : 'ready') : undefined}
      title={
        isPttMode
          ? `${selfMute ? 'Muted: push to talk is off' : pttEngaged ? 'Transmitting (push to talk)' : 'Push to talk: hold your shortcut'} (right-click for devices and deafen)`
          : selfMute ? 'Unmute (right-click for devices and deafen)' : 'Mute (right-click for devices and deafen)'
      }
      onClick={onToggle}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu();
      }}
      onKeyDown={(event) => {
        if (event.key === 'F10' && event.shiftKey) {
          event.preventDefault();
          onMenu();
        }
      }}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerEnd}
      onPointerLeave={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <IxGlyph name={selfMute ? 'micOff' : 'mic'} size={18} />
    </button>
  );
}
