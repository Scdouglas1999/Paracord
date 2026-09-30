import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { Headphones, HeadphoneOff } from 'lucide-react';

import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useMediaDevices } from '../../../hooks/useMediaDevices';
import { buildDevicePickerOptions, systemDefaultOptionLabel } from '../../../lib/media/deviceLabels';
import { useAuthStore } from '../../../stores/authStore';
import { toast } from '../../../stores/toastStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import {
  StreamOverlayPortal,
  useAnchoredOverlayCoords,
  useOverlayDismiss,
} from '../../voice/streamOverlayPortal';

/**
 * The two popovers of the stage's control row (glass-plan §1.3, §8.4):
 *
 *   - The microphone's menu (right-click, Shift+F10 or a long press on the
 *     mic, or "Devices" in More): Deafen, and the microphone and speaker.
 *   - More (joined only): soundboard, Watch together, invite, devices,
 *     connection check.
 *
 * Both sit on `document.body` through `StreamOverlayPortal`, so on the desktop's
 * native video route they are drawn above the hole with a near-solid fill (no
 * blur can reach a surface under the webview), and they never count as covering
 * the video.
 */

const DEVICE_PANEL_W = 300;
const MORE_PANEL_W = 248;

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
  // The panel mounts once it has coordinates; the trap binds to it then.
  useFocusTrap(panelRef, open && coords !== null, onClose);
  if (!open || !coords) return null;
  return (
    <StreamOverlayPortal
      panelRef={panelRef}
      role="dialog"
      aria-label="Microphone and speaker"
      className="glass-stage-popover glass-stage-popover--devices"
      style={{ ...coords, width: DEVICE_PANEL_W }}
    >
      <DeviceMenuBody />
    </StreamOverlayPortal>
  );
}

function DeviceMenuBody() {
  const selfDeaf = useVoiceStore((state) => state.selfDeaf);
  const toggleDeaf = useVoiceStore((state) => state.toggleDeaf);
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
    <div className="glass-stage-popover__body">
      <button
        type="button"
        className="glass-stage-popover__row glass-focusable"
        aria-pressed={selfDeaf}
        onClick={() => void toggleDeaf()}
      >
        {selfDeaf ? <HeadphoneOff size={18} aria-hidden="true" /> : <Headphones size={18} aria-hidden="true" />}
        <span className="glass-stage-popover__label">Deafen</span>
        <span className="glass-stage-popover__hint">{selfDeaf ? "You can't hear the call" : 'Stop hearing the call'}</span>
      </button>
      <label className="glass-stage-popover__field">
        <span className="glass-stage-popover__kicker">Microphone</span>
        <select
          className="glass-stage-popover__select glass-focusable"
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
      <label className="glass-stage-popover__field">
        <span className="glass-stage-popover__kicker">Speaker</span>
        <select
          className="glass-stage-popover__select glass-focusable"
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
      className="glass-stage-popover glass-stage-popover--menu"
      style={{ ...coords, width: MORE_PANEL_W }}
    >
      {/* Key handling lives on the list, not the portal host. */}
      <div className="glass-stage-popover__body" onKeyDown={onKeyDown} role="none">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="glass-stage-popover__row glass-focusable"
            onClick={() => {
              onClose(false);
              item.onSelect();
            }}
          >
            <span className="glass-stage-popover__icon" aria-hidden="true">{item.icon}</span>
            <span className="glass-stage-popover__label">{item.label}</span>
          </button>
        ))}
      </div>
    </StreamOverlayPortal>
  );
}
