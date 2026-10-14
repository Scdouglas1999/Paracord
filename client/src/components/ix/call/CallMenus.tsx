import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Check, Headphones, HeadphoneOff } from 'lucide-react';

import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useMediaDevices } from '../../../hooks/useMediaDevices';
import { toggleVoiceDeaf } from '../../../hooks/useVoice';
import { buildDevicePickerOptions, systemDefaultOptionLabel } from '../../../lib/media/deviceLabels';
import { useAuthStore } from '../../../stores/authStore';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { SHARE_QUALITIES, SHARE_QUALITY_HINT, shareQualitySameAs, useShareQualityStore } from '../../glass/stage/useShareScreen';
import { useShareSourceStore } from '../../../lib/media/shareSource';
import { StreamOverlayPortal, useAnchoredOverlayCoords, useOverlayDismiss } from '../../voice/streamOverlayPortal';

/**
 * The call's popovers (docs/index-spec.md §7.2, §8.5; ported from the Glass
 * stage's `StageMenus`, behavior unchanged):
 *
 *   - `DeviceMenu`: the microphone's menu (right-click, Shift+F10 or a long
 *     press on the mic, in the call view and on the room card; "Microphone and
 *     speaker" in More): the microphone check, Deafen, the microphone and the
 *     speaker.
 *   - `MoreMenu`: the call's other actions (soundboard, Watch together, invite,
 *     share quality, devices, stream volume and quality, connection check).
 *   - `ShareQualityMenu`: what your screen share sends.
 *
 * All sit on `document.body` through `StreamOverlayPortal`, so over the
 * desktop's native video they are drawn near-solid above the hole (nothing can
 * blur a surface under the webview) and never count as covering the video.
 */

const DEVICE_PANEL_W = 300;
const MORE_PANEL_W = 256;
const SHARE_PANEL_W = 280;

/* ---- The microphone's menu ---------------------------------------------------- */

export function DeviceMenu({
  open,
  anchorRef,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const coords = useAnchoredOverlayCoords(open, anchorRef, 'above-start', DEVICE_PANEL_W, 10);
  const inside = useCallback(
    (target: Node) => Boolean(panelRef.current?.contains(target) || anchorRef.current?.contains(target)),
    [anchorRef],
  );
  // Escape is the focus trap's (it returns focus to the trigger); a press outside closes.
  useOverlayDismiss(open, onClose, inside, { escape: false });
  useFocusTrap(panelRef, open && coords !== null, onClose);
  if (!open || !coords) return null;
  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="dialog"
      aria-label="Microphone and speaker"
      className="ix-call-pop ix-call-pop--devices"
      style={{ ...coords, width: DEVICE_PANEL_W }}
    >
      <DeviceMenuBody />
    </StreamOverlayPortal>
  );
}

/**
 * How the microphone is doing, in words: muted, push to talk waiting for its
 * key, not reaching the call, working, or waiting to hear you.
 */
export function micStatus({
  micMuted,
  micInputActive,
  micUplinkState,
  isPttMode,
  pttEngaged,
}: {
  micMuted: boolean;
  micInputActive: boolean;
  micUplinkState: string;
  isPttMode: boolean;
  pttEngaged: boolean;
}): { label: string; detail: string; warning: boolean } {
  if (micMuted) return { label: 'Microphone muted', detail: 'Unmute to check your level.', warning: false };
  if (isPttMode && !pttEngaged) {
    return { label: 'Push to talk ready', detail: 'Hold your shortcut to test your microphone.', warning: false };
  }
  if (micUplinkState === 'stalled' || micUplinkState === 'recovering' || micUplinkState === 'no_track') {
    return {
      label: micUplinkState === 'recovering' ? 'Restoring microphone' : 'Microphone needs attention',
      detail: micUplinkState === 'no_track'
        ? 'No microphone track is reaching the call.'
        : 'Your microphone is detected locally, but audio is not reaching the call reliably.',
      warning: true,
    };
  }
  if (micInputActive) return { label: 'Microphone is working', detail: 'Your voice is being sent to the call.', warning: false };
  return { label: 'Listening for your voice', detail: 'Speak to confirm your input level.', warning: false };
}

/** Push to talk, from the account's voice settings. */
export function usePushToTalk(): { isPttMode: boolean; pttEngaged: boolean } {
  const mode = useAuthStore((state) => (state.settings?.notifications as Record<string, unknown> | undefined)?.voiceInputMode);
  const pttEngaged = useVoiceStore((state) => state.pttEngaged);
  return { isPttMode: (mode ?? 'voice_activity') === 'push_to_talk', pttEngaged };
}

/** The microphone check: its state in words and its input level (in the call only). */
function MicCheck() {
  const selfMute = useVoiceStore((state) => state.selfMute);
  const selfDeaf = useVoiceStore((state) => state.selfDeaf);
  const micInputActive = useVoiceStore((state) => state.micInputActive);
  const micInputLevel = useVoiceStore((state) => state.micInputLevel);
  const micUplinkState = useVoiceStore((state) => state.micUplinkState);
  const { isPttMode, pttEngaged } = usePushToTalk();
  const status = micStatus({ micMuted: selfMute || selfDeaf, micInputActive, micUplinkState, isPttMode, pttEngaged });
  const level = Math.min(1, Math.max(0, micInputLevel));
  const percent = Math.round(level * 100);
  return (
    <div className="ix-call-pop__check" data-warning={status.warning ? 'true' : undefined}>
      <span className="ix-call-pop__check-head">
        <span className="ix-call-pop__label">{status.label}</span>
        <span className="ix-call-pop__hint ix-call-pop__num">{percent}%</span>
      </span>
      <span
        role="meter"
        aria-label="Microphone input level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        className="ix-call-pop__meter"
      >
        {/* A composited scale, never a width: the level changes many times a second. */}
        <span className="ix-call-pop__meter-fill" style={{ transform: `scaleX(${level.toFixed(3)})` }} />
      </span>
      <span className="ix-call-pop__hint">{status.detail}</span>
    </div>
  );
}

function DeviceMenuBody() {
  const inCall = useVoiceStore((state) => state.connected);
  const selfDeaf = useVoiceStore((state) => state.selfDeaf);
  const applyAudioInputDevice = useVoiceStore((state) => state.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((state) => state.applyAudioOutputDevice);
  const settings = useAuthStore((state) => state.settings);
  const updateSettings = useAuthStore((state) => state.updateSettings);
  const notifications = useMemo(() => (settings?.notifications ?? {}) as Record<string, unknown>, [settings?.notifications]);
  const {
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectAudioInput,
    selectAudioOutput,
  } = useMediaDevices();
  const [switching, setSwitching] = useState<'input' | 'output' | null>(null);

  useEffect(() => {
    selectAudioInput(typeof notifications.audioInputDeviceId === 'string' ? notifications.audioInputDeviceId : '');
    selectAudioOutput(typeof notifications.audioOutputDeviceId === 'string' ? notifications.audioOutputDeviceId : '');
  }, [notifications.audioInputDeviceId, notifications.audioOutputDeviceId, selectAudioInput, selectAudioOutput]);

  const inputs = useMemo(
    () => buildDevicePickerOptions(audioInputDevices, { selectedDeviceId: selectedAudioInput, fallbackNoun: 'Microphone' }),
    [audioInputDevices, selectedAudioInput],
  );
  const outputs = useMemo(
    () => buildDevicePickerOptions(audioOutputDevices, { selectedDeviceId: selectedAudioOutput, fallbackNoun: 'Speaker' }),
    [audioOutputDevices, selectedAudioOutput],
  );

  const persist = async (key: 'audioInputDeviceId' | 'audioOutputDeviceId', value: string) => {
    try {
      await updateSettings({ notifications: { ...notifications, [key]: value || null } });
    } catch {
      toast.warning('Device switched for this call, but the preference could not be saved.');
    }
  };

  const change = async (kind: 'input' | 'output', value: string) => {
    const previous = (kind === 'input' ? selectedAudioInput : selectedAudioOutput) ?? '';
    (kind === 'input' ? selectAudioInput : selectAudioOutput)(value);
    setSwitching(kind);
    try {
      const ok = await (kind === 'input' ? applyAudioInputDevice : applyAudioOutputDevice)(value || null);
      if (!ok) {
        (kind === 'input' ? selectAudioInput : selectAudioOutput)(previous);
        toast.error(kind === 'input'
          ? 'Could not switch microphone. It may be in use or unavailable.'
          : 'Could not switch speaker. It may be unavailable.');
        return;
      }
      await persist(kind === 'input' ? 'audioInputDeviceId' : 'audioOutputDeviceId', value);
    } finally {
      setSwitching(null);
    }
  };

  return (
    <div className="ix-call-pop__body">
      {inCall && <MicCheck />}
      <button
        type="button"
        className="ix-call-pop__row"
        aria-pressed={selfDeaf}
        onClick={() => void toggleVoiceDeaf()}
      >
        {selfDeaf ? <HeadphoneOff size={18} aria-hidden="true" /> : <Headphones size={18} aria-hidden="true" />}
        <span className="ix-call-pop__label">Deafen</span>
        <span className="ix-call-pop__hint">{selfDeaf ? "You can't hear the call" : 'Stop hearing the call'}</span>
      </button>
      <label className="ix-call-pop__field">
        <span className="ix-call-pop__kicker">Microphone</span>
        <select
          className="ix-call-pop__select"
          value={selectedAudioInput ?? ''}
          disabled={switching === 'input'}
          onChange={(event) => void change('input', event.target.value)}
        >
          <option value="">{systemDefaultOptionLabel('audioinput')}</option>
          {inputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
      <label className="ix-call-pop__field">
        <span className="ix-call-pop__kicker">Speaker</span>
        <select
          className="ix-call-pop__select"
          value={selectedAudioOutput ?? ''}
          disabled={switching === 'output'}
          onChange={(event) => void change('output', event.target.value)}
        >
          <option value="">{systemDefaultOptionLabel('audiooutput')}</option>
          {outputs.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

/* ---- More --------------------------------------------------------------------- */

export interface MoreItem {
  id: string;
  label: string;
  icon: ReactNode;
  onSelect: () => void;
}

export function MoreMenu({
  open,
  anchorRef,
  items,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  items: readonly MoreItem[];
  onClose: (returnFocus: boolean) => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const coords = useAnchoredOverlayCoords(open, anchorRef, 'above-end', MORE_PANEL_W, 10);
  const inside = useCallback(
    (target: Node) => Boolean(panelRef.current?.contains(target) || anchorRef.current?.contains(target)),
    [anchorRef],
  );
  const closeOutside = useCallback(() => onClose(false), [onClose]);
  useOverlayDismiss(open, closeOutside, inside, { escape: false });

  // The first item takes the focus when the menu opens (a menu button's contract).
  useEffect(() => {
    if (!open || !coords) return;
    const first = panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]');
    first?.focus();
  }, [open, coords]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const entries = [...(panelRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      event.preventDefault();
      entries[(to + entries.length) % entries.length]?.focus();
    };
    switch (event.key) {
      case 'ArrowDown': move(at + 1); break;
      case 'ArrowUp': move(at - 1); break;
      case 'Home': move(0); break;
      case 'End': move(entries.length - 1); break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose(true);
        break;
      case 'Tab':
        onClose(false);
        break;
      default:
    }
  };

  if (!open || !coords) return null;
  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="menu"
      aria-label="More call actions"
      className="ix-call-pop ix-call-pop--menu"
      style={{ ...coords, width: MORE_PANEL_W }}
    >
      {/* Key handling lives on the list, not the portal host. */}
      <div className="ix-call-pop__body" onKeyDown={onKeyDown} role="none">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="ix-call-pop__row"
            onClick={() => {
              onClose(false);
              item.onSelect();
            }}
          >
            <span className="ix-call-pop__icon" aria-hidden="true">{item.icon}</span>
            <span className="ix-call-pop__label">{item.label}</span>
          </button>
        ))}
      </div>
    </StreamOverlayPortal>
  );
}

/* ---- Share quality -------------------------------------------------------------- */

/** The display this window is on, in device pixels (what a share of it captures). */
function displaySize(): { width: number; height: number } | null {
  if (typeof window === 'undefined' || !window.screen) return null;
  const scale = window.devicePixelRatio || 1;
  const width = Math.round(window.screen.width * scale);
  const height = Math.round(window.screen.height * scale);
  return width > 0 && height > 0 ? { width, height } : null;
}

/** The quality you send when you share your screen; during a share it updates the encoder in place. */
export function ShareQualityMenu({
  open,
  anchorRef,
  onClose,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const coords = useAnchoredOverlayCoords(open, anchorRef, 'above-end', SHARE_PANEL_W, 10);
  const quality = useShareQualityStore((state) => state.quality);
  const setQuality = useShareQualityStore((state) => state.setQuality);
  const [changing, setChanging] = useState(false);
  const sharing = useVoiceStore((state) => state.selfStream);
  const sharedSource = useShareSourceStore((state) => state.size);
  const inside = useCallback(
    (target: Node) => Boolean(panelRef.current?.contains(target) || anchorRef.current?.contains(target)),
    [anchorRef],
  );
  useOverlayDismiss(open, onClose, inside, { escape: false });
  useFocusTrap(panelRef, open && coords !== null, onClose);
  if (!open || !coords) return null;
  // The screen the presets are judged on: the one being shared, else the one
  // this window is on (where a share most often starts).
  const screenSize = sharing && sharedSource ? sharedSource : displaySize();
  const where = sharing && sharedSource ? 'the shared screen' : 'this screen';
  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="dialog"
      aria-label="Share quality"
      className="ix-call-pop"
      style={{ ...coords, width: SHARE_PANEL_W }}
    >
      <div className="ix-call-pop__body">
        <span className="ix-call-pop__kicker">Share quality</span>
        <span className="ix-call-pop__hint">Sets the quality you send. Viewers can adapt playback for their connection.</span>
        <span className="ix-call-pop__hint">{SHARE_QUALITY_HINT}</span>
        {SHARE_QUALITIES.map((option) => (
          <button
            key={option.value}
            type="button"
            className="ix-call-pop__row"
            aria-pressed={quality === option.value}
            disabled={changing}
            onClick={() => {
              if (!useVoiceStore.getState().selfStream) {
                setQuality(option.value);
                onClose();
                return;
              }
              setChanging(true);
              void useVoiceStore.getState().changeStreamQuality(option.value).then(() => {
                setQuality(option.value);
                onClose();
              }).catch((error: unknown) => {
                toast.error(`Could not change stream quality: ${error instanceof Error ? error.message : String(error)}`);
              }).finally(() => setChanging(false));
            }}
          >
            <span className="ix-call-pop__label">
              {option.label}
              {(() => {
                const sameAs = screenSize ? shareQualitySameAs(option.value, screenSize.width, screenSize.height) : null;
                return sameAs ? <span className="ix-call-pop__sub">Same as {sameAs} on {where}</span> : null;
              })()}
            </span>
            {quality === option.value && <Check size={16} aria-hidden="true" />}
          </button>
        ))}
      </div>
    </StreamOverlayPortal>
  );
}
