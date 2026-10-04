import { forwardRef, useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { toggleVoiceVideo } from '../../../hooks/useVoice';
import { useGlassStore } from '../../../stores/glassStore';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import {
  joinCall,
  leaveCall,
  listenBlockReason,
  showCall,
  toggleListen,
  toggleMic,
  useListenBlockStore,
  watchStream,
  type PillActionTarget,
} from '../../glass/pill/pillActions';
import { DeviceMenu } from '../call/CallMenus';
import { useShareScreen } from '../../glass/stage/useShareScreen';
import { ScreenSharePickerModal } from '../../voice/ScreenSharePickerModal';
import { IxGlyph } from '../glyphs';
import { Control, CreamButton, WideControl } from '../primitives';
import { useListenInAllowed } from './listenIn';
import type { RoomCardModel } from './model';

/**
 * The card's actions row (docs/index-spec.md §3.1 "Card actions", §4.3).
 *
 *   live        [listen] + Join (cream)
 *   streaming   Join (wide) + Watch <name> (cream)
 *   listening   [listen, on] + Join (cream)
 *   yours       mic, camera, screen + Open call / Back to chat (wide) + leave
 *
 * Every action is the existing voice action (`glass/pill/pillActions.ts`):
 * Listen never sends, Join applies Settings › Join calls muted and upgrades a
 * listen in place, Watch opens the call view on the stream without joining,
 * Leave is one click. A DM or stage room has no Listen; a stage audience has
 * no microphone (it asks to speak in the call view).
 */

const LONG_PRESS_MS = 520;

export interface CardActionsProps {
  card: RoomCardModel;
}

/** The call view is open on this room. */
function useCallViewOpen(channelId: string): boolean {
  return useGlassStore((state) => state.stage.mode !== 'none' && state.stage.channelId === channelId);
}

export const CardActions = forwardRef<HTMLDivElement, CardActionsProps>(function CardActions({ card }, ref) {
  const modeSwitching = useVoiceStore((state) => state.modeSwitching);
  const blocked = useListenBlockStore((state) => state.blocked);
  const action = useMemo<PillActionTarget>(
    () => ({ serverId: card.serverId, guildId: card.guildId, channelId: card.channelId, title: card.title }),
    [card.serverId, card.guildId, card.channelId, card.title],
  );
  const busy = card.relation === 'joining' || modeSwitching;
  const offersListen = !card.isDm && !card.stage && (card.state === 'live' || card.state === 'listening');
  const listenAllowed = useListenInAllowed(card.serverId, card.channelId, offersListen && card.state === 'live');
  const blockReason = listenBlockReason(blocked, action);

  if (card.state === 'yours') return <YoursActions ref={ref} card={card} action={action} />;

  const onJoin = () => {
    if (!busy) void joinCall(action);
  };
  const join = (wide: boolean) =>
    wide ? (
      <WideControl data-testid="ix-card-join" aria-busy={busy || undefined} aria-label={`Join ${card.title}`} onClick={onJoin}>
        Join
      </WideControl>
    ) : (
      <CreamButton grow data-testid="ix-card-join" aria-busy={busy || undefined} aria-label={`Join ${card.title}`} onClick={onJoin}>
        Join
      </CreamButton>
    );

  if (card.state === 'streaming' && card.watchTarget) {
    const streamer = card.watchTarget;
    return (
      <div ref={ref} className="ix-card-actions">
        {join(true)}
        <CreamButton grow data-testid="ix-card-watch" onClick={() => watchStream(action, streamer.userId)}>
          Watch {streamer.name}
        </CreamButton>
      </div>
    );
  }

  const listening = card.state === 'listening';
  const showListen = offersListen && (listening || listenAllowed);
  return (
    <div ref={ref} className="ix-card-actions">
      {showListen && (
        <Control
          label={listening ? `Stop listening to ${card.title}` : `Listen in to ${card.title}`}
          title={blockReason ?? (listening ? 'Stop listening' : 'Listen in: hear everyone without joining. They can see you’re listening.')}
          pressed={listening}
          aria-disabled={busy || (!listening && Boolean(blockReason)) || undefined}
          aria-busy={busy || undefined}
          data-testid="ix-card-listen"
          onClick={() => {
            if (busy || (!listening && blockReason)) return;
            void toggleListen(action, listening);
          }}
        >
          <IxGlyph name="listen" size={16} />
        </Control>
      )}
      {join(false)}
    </div>
  );
});

const YoursActions = forwardRef<HTMLDivElement, { card: RoomCardModel; action: PillActionTarget }>(function YoursActions(
  { card, action },
  ref,
) {
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfVideo = useVoiceStore((state) => state.selfVideo);
  const share = useShareScreen();
  const callOpen = useCallViewOpen(card.channelId);
  const micRef = useRef<HTMLButtonElement | null>(null);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const closeDevices = useCallback(() => setDevicesOpen(false), []);

  // The mic's device menu: right-click, Shift+F10 (the context-menu key), or a long press.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressed = useRef(false);
  const onMicPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType !== 'touch') return;
    longPressed.current = false;
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      setDevicesOpen(true);
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };

  const toggleCallView = () => {
    if (callOpen) useGlassStore.getState().closeStage();
    else showCall(action);
  };

  return (
    <div ref={ref} className="ix-card-actions">
      {!card.audience && (
        <>
          <Control
            ref={micRef}
            label={selfMute ? 'Unmute' : 'Mute'}
            title={`${selfMute ? 'Unmute' : 'Mute'} (right-click for devices and deafen)`}
            aria-haspopup="dialog"
            aria-expanded={devicesOpen}
            aria-keyshortcuts="Shift+F10"
            data-testid="ix-card-mic"
            data-muted={selfMute ? 'true' : 'false'}
            onClick={() => {
              if (longPressed.current) {
                longPressed.current = false;
                return;
              }
              void toggleMic();
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              setDevicesOpen(true);
            }}
            onPointerDown={onMicPointerDown}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
          >
            <IxGlyph name={selfMute ? 'micOff' : 'mic'} size={16} />
          </Control>
          <Control
            label={selfVideo ? 'Turn off camera' : 'Turn on camera'}
            title={selfVideo ? 'Turn off camera' : 'Turn on camera'}
            pressed={selfVideo}
            data-testid="ix-card-camera"
            onClick={() => {
              toggleVoiceVideo().catch((error: unknown) => {
                toast.error(`Could not ${selfVideo ? 'turn off' : 'turn on'} your camera: ${error instanceof Error ? error.message : 'try again.'}`);
              });
            }}
          >
            <IxGlyph name="camera" size={16} />
          </Control>
          <Control
            label={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            title={share.sharing ? 'Stop sharing your screen' : 'Share your screen'}
            pressed={share.sharing}
            aria-busy={share.starting || undefined}
            data-testid="ix-card-screen"
            onClick={share.toggle}
          >
            <IxGlyph name="screen" size={16} />
          </Control>
        </>
      )}
      <WideControl
        data-testid="ix-card-open-call"
        aria-label={callOpen ? 'Back to chat' : 'Open call'}
        title={callOpen ? 'Back to chat' : 'Open call'}
        aria-expanded={callOpen}
        onClick={toggleCallView}
      >
        <span className="ix-swap" aria-hidden="true">
          <span data-on={callOpen ? undefined : ''}>Open call</span>
          <span data-on={callOpen ? '' : undefined}>Back to chat</span>
        </span>
      </WideControl>
      <Control label={`Leave ${card.title}`} title="Leave" tone="danger" data-testid="ix-card-leave" onClick={() => void leaveCall()}>
        <IxGlyph name="x" size={16} />
      </Control>
      <DeviceMenu open={devicesOpen} anchorRef={micRef} onClose={closeDevices} />
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
});
