import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  AudioLines,
  Clapperboard,
  Hand,
  Heart,
  Mic,
  MicOff,
  MonitorOff,
  MonitorUp,
  MoreHorizontal,
  SlidersHorizontal,
  Stethoscope,
  UserPlus,
  Video,
} from 'lucide-react';

import { usePermissions } from '../../../hooks/usePermissions';
import { toggleVoiceVideo } from '../../../hooks/useVoice';
import { useLingering } from '../../../lib/motion';
import { useClip } from '../../../lib/media/clips/useClip';
import { isStreamTarget, type StageTarget } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { hasPermission, Permissions } from '../../../types';
import { InviteModal } from '../../guild/InviteModal';
import { ScreenSharePickerModal } from '../../voice/ScreenSharePickerModal';
import { SoundboardPopover } from '../../voice/SoundboardPopover';
import { useAnchoredOverlayCoords, useOverlayDismiss } from '../../voice/streamOverlayPortal';
import { TogetherSheetFor } from '../../voice/together/TogetherButton';
import { useTogether } from '../../voice/together/useTogether';
import { VoiceConnectionCheck } from '../../voice/VoiceConnectionCheck';
import { useJoinMuteStore } from '../pill/muteStore';
import { joinCall, leaveCall, toggleJoinMute, toggleMic, voiceGuildOf } from '../pill/pillActions';
import { ClipGlyph, FlameGlyph, GlassButton, JoinButton } from '../primitives';
import { DeviceMenu, MoreMenu, ShareQualityMenu, usePushToTalk, type MoreItem } from './StageMenus';
import type { ControlsFit, StageModel } from './stageModel';
import { useStreamReactions, type StreamReactionKind } from './StreamReactionsLayer';
import { shareQualityLabel, useShareQualityStore, useShareScreen } from './useShareScreen';
import { useStageChannel } from './useStageChannel';

/**
 * The stage's control row, centered at the bottom (docs/glass-spec.md §6.1):
 *
 *   not joined   flame, heart, Clip | mute preference, Join
 *   joined       mic, camera, share | flame, heart, Clip | More, Leave
 *
 * Join (cream) is the one filled button. Leave is a text decision and the only
 * way out of a call; the stage never leaves a call on its own. Deafen lives in
 * the microphone's menu (right-click, Shift+F10 or a long press); More holds
 * the soundboard, Watch together, invite, devices and the connection check
 * (owner decisions, glass-plan §8.4).
 *
 * Flame, heart and Clip call the contracts WP-G17 and WP-G16 fill
 * (`useStreamReactions`, `useClip`). Until they do, each says it is not
 * available yet (`aria-disabled`, the reason as its tooltip and as a toast on
 * a press): nothing pretends to work.
 */

const LONG_PRESS_MS = 520;

export interface StageControlsProps {
  target: StageTarget;
  model: StageModel;
  fit: ControlsFit;
}

export function StageControls({ target, model, fit }: StageControlsProps) {
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfVideo = useVoiceStore((state) => state.selfVideo);
  const joinMuted = useJoinMuteStore((state) => state.joinMuted);
  const modeSwitching = useVoiceStore((state) => state.modeSwitching);

  // The call itself (no stream) has nothing to react to and nothing to clip.
  const stream = model.view === 'stream' && isStreamTarget(target) ? target : null;
  const reactions = useStreamReactions(stream);
  const clip = useClip(stream ? { ...stream, streamerName: model.streamerName } : null);
  const share = useShareScreen();
  // A stage channel's audience asks to speak instead of opening a microphone.
  const stageSession = useStageChannel(model.stageChannel ? target.channelId : null);


  const micRef = useRef<HTMLButtonElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const [deviceMenu, setDeviceMenu] = useState<'mic' | 'more' | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [dialog, setDialog] = useState<'invite' | 'check' | 'together' | 'soundboard' | 'quality' | null>(null);
  const shareQuality = useShareQualityStore((state) => state.quality);
  const { isPttMode, pttEngaged } = usePushToTalk();

  const joined = model.controls === 'joined';
  const busy = model.busy || modeSwitching;
  const action = { serverId: target.serverId, guildId: voiceGuildOf(target.guildId), channelId: target.channelId, title: model.channelName };

  /* ---- Reactions and Clip (G17, G16) ------------------------------------------ */
  const react = (kind: StreamReactionKind) => {
    if (!reactions.available) {
      toast.info(reactions.unavailableReason ?? 'Reactions are not available.');
      return;
    }
    reactions.send(kind);
  };
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
  if (stream && fit >= 2) {
    moreItems.push(
      { id: 'fire', label: 'React with fire', icon: <FlameGlyph size={18} />, onSelect: () => react('fire') },
      { id: 'heart', label: 'React with a heart', icon: <Heart size={18} />, onSelect: () => react('heart') },
    );
  }
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
  // What the next share sends (a server voice channel or a DM call).
  if (!model.audience && !share.sharing) {
    moreItems.push({
      id: 'quality',
      label: `Share quality: ${shareQualityLabel(shareQuality)}`,
      icon: <MonitorUp size={18} />,
      onSelect: () => setDialog('quality'),
    });
  }
  moreItems.push(
    { id: 'devices', label: 'Microphone and speaker', icon: <SlidersHorizontal size={18} />, onSelect: () => setDeviceMenu('more') },
    { id: 'check', label: 'Connection check', icon: <Stethoscope size={18} />, onSelect: () => setDialog('check') },
  );

  /* ---- Soundboard (anchored to More, like the Lantern bar's) -------------------- */
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
  const reactionTitle = reactions.available ? undefined : reactions.unavailableReason ?? undefined;
  const reactionButtons = stream && fit < 2 && (
    <>
      <GlassButton
        variant="icon"
        size="md"
        className="glass-stage__ctl glass-stage__ctl--flame"
        aria-label="React with fire"
        aria-disabled={!reactions.available || undefined}
        title={reactionTitle ?? 'React with fire'}
        onClick={() => react('fire')}
      >
        <FlameGlyph size={19} />
      </GlassButton>
      <GlassButton
        variant="icon"
        size="md"
        className="glass-stage__ctl"
        aria-label="React with a heart"
        aria-disabled={!reactions.available || undefined}
        title={reactionTitle ?? 'React with a heart'}
        onClick={() => react('heart')}
      >
        <Heart size={19} strokeWidth={1.8} aria-hidden="true" />
      </GlassButton>
    </>
  );
  const clipButton = stream && (
    <GlassButton
      variant="glass"
      size="md"
      className="glass-stage__ctl glass-stage__clip"
      data-fit={fit}
      aria-label={fit >= 1 ? 'Clip the last 30 seconds' : undefined}
      aria-disabled={!clip.available || clip.saving || undefined}
      aria-keyshortcuts="C"
      title={clip.available ? 'Clip the last 30 seconds (C)' : clip.unavailableReason ?? undefined}
      onClick={onClip}
    >
      <ClipGlyph size={19} />
      {fit < 1 && <span>Clip</span>}
    </GlassButton>
  );
  const divider = <span className="glass-stage__divider" aria-hidden="true" />;
  const requestButton = (
    <GlassButton
      variant="text"
      size="md"
      className="glass-stage__request"
      pressed={model.handRaised}
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
    </GlassButton>
  );

  return (
    <div className="glass-stage__controls" role="group" aria-label="Call controls">
      {joined ? (
        <>
          {model.audience ? (
            requestButton
          ) : (
            <>
              <GlassButton
                ref={micRef}
                variant="icon"
                size="md"
                className="glass-stage__ctl glass-stage__mic"
                aria-label="Microphone"
                pressed={isPttMode ? !selfMute && pttEngaged : !selfMute}
                aria-haspopup="dialog"
                aria-expanded={deviceMenu === 'mic'}
                aria-keyshortcuts="Shift+F10"
                data-ptt={isPttMode ? (pttEngaged ? 'talking' : 'ready') : undefined}
                title={
                  isPttMode
                    ? `${selfMute ? 'Muted: push to talk is off' : pttEngaged ? 'Transmitting (push to talk)' : 'Push to talk: hold your shortcut'} (right-click for devices and deafen)`
                    : selfMute ? 'Unmute (right-click for devices and deafen)' : 'Mute (right-click for devices and deafen)'
                }
                onClick={() => {
                  if (longPressed.current) {
                    longPressed.current = false;
                    return;
                  }
                  void toggleMic();
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setDeviceMenu('mic');
                }}
                onPointerDown={onMicPointerDown}
                onPointerUp={cancelPress}
                onPointerLeave={cancelPress}
                onPointerCancel={cancelPress}
              >
                {selfMute ? <MicOff size={19} strokeWidth={1.8} aria-hidden="true" /> : <Mic size={19} strokeWidth={1.8} aria-hidden="true" />}
              </GlassButton>
              <GlassButton
                variant="icon"
                size="md"
                className="glass-stage__ctl"
                aria-label="Camera"
                pressed={selfVideo}
                title={selfVideo ? 'Turn off camera' : 'Turn on camera'}
                onClick={() => {
                  toggleVoiceVideo().catch((error: unknown) => {
                    toast.error(`Could not ${selfVideo ? 'turn off' : 'turn on'} your camera: ${error instanceof Error ? error.message : 'try again.'}`);
                  });
                }}
              >
                {/* One glyph; on and off is the fill (aria-pressed), as in screens/04. */}
                <Video size={19} strokeWidth={1.7} aria-hidden="true" />
              </GlassButton>
              {/* Server voice channels and DM calls alike (docs/design/glass-fix-dm-calls.md). */}
              <GlassButton
                variant="icon"
                size="md"
                className="glass-stage__ctl"
                aria-label={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
                pressed={share.sharing}
                aria-busy={share.starting || undefined}
                title={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
                onClick={share.toggle}
              >
                {share.sharing ? <MonitorOff size={19} strokeWidth={1.7} aria-hidden="true" /> : <MonitorUp size={19} strokeWidth={1.7} aria-hidden="true" />}
              </GlassButton>
            </>
          )}
          {divider}
          {stream && (
            <>
              {reactionButtons}
              {clipButton}
              {divider}
            </>
          )}
          <GlassButton
            ref={moreRef}
            variant="icon"
            size="md"
            className="glass-stage__ctl"
            aria-label="More call actions"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <MoreHorizontal size={19} aria-hidden="true" />
          </GlassButton>
          <GlassButton
            variant="text"
            size="md"
            className="glass-stage__leave"
            aria-label={`Leave ${model.channelName}`}
            onClick={() => void leaveCall()}
          >
            Leave
          </GlassButton>
        </>
      ) : (
        <>
          {reactionButtons}
          {clipButton}
          {stream && fit >= 2 && (
            <GlassButton
              ref={moreRef}
              variant="icon"
              size="md"
              className="glass-stage__ctl"
              aria-label="More call actions"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <MoreHorizontal size={19} aria-hidden="true" />
            </GlassButton>
          )}
          {stream && divider}
          <GlassButton
            variant="icon"
            size="md"
            className="glass-stage__ctl glass-stage__mute-pref"
            aria-label="Microphone on when you join"
            pressed={!joinMuted}
            aria-disabled={busy || undefined}
            title={joinMuted ? "You'll join muted" : 'Mic on when you join'}
            onClick={() => {
              if (busy) return;
              void toggleJoinMute(model.listening);
            }}
          >
            {joinMuted ? <MicOff size={18} strokeWidth={1.8} aria-hidden="true" /> : <Mic size={18} strokeWidth={1.8} aria-hidden="true" />}
          </GlassButton>
          <JoinButton
            size="md"
            className="glass-stage__join"
            aria-label={`Join ${model.channelName}`}
            aria-disabled={busy || undefined}
            aria-busy={busy || undefined}
            onClick={() => {
              if (busy) return;
              void joinCall(action);
            }}
          >
            Join
          </JoinButton>
        </>
      )}

      <MoreMenu
        open={moreOpen}
        anchorRef={moreRef}
        items={joined ? moreItems : moreItems.filter((item) => item.id === 'fire' || item.id === 'heart')}
        onClose={closeMore}
      />
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
