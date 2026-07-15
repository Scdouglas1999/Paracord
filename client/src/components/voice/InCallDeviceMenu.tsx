import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, ChevronUp, Mic, Volume2, X } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useMediaDevices } from '../../hooks/useMediaDevices';
import {
  buildDevicePickerOptions,
  systemDefaultOptionLabel,
} from '../../lib/media/deviceLabels';
import { cn } from '../../lib/utils';
import { useAuthStore } from '../../stores/authStore';
import { toast } from '../../stores/toastStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { Select } from '../ui/Input';

interface InCallDeviceMenuProps {
  micLevel: number;
  micMuted: boolean;
  micInputActive: boolean;
  micUplinkState: string;
  isPttMode: boolean;
  pttEngaged: boolean;
}

function micStatus({
  micMuted,
  micInputActive,
  micUplinkState,
  isPttMode,
  pttEngaged,
}: Omit<InCallDeviceMenuProps, 'micLevel'>): {
  label: string;
  detail: string;
  warning: boolean;
} {
  if (micMuted) {
    return { label: 'Microphone muted', detail: 'Unmute to check your level.', warning: false };
  }
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
  if (micInputActive) {
    return { label: 'Microphone is working', detail: 'Your voice is being sent to the call.', warning: false };
  }
  return { label: 'Listening for your voice', detail: 'Speak to confirm your input level.', warning: false };
}

const PANEL_WIDTH = 320;

export function InCallDeviceMenu(props: InCallDeviceMenuProps) {
  const [open, setOpen] = useState(false);
  const [switching, setSwitching] = useState<'input' | 'output' | null>(null);
  const [coords, setCoords] = useState<{ bottom: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const {
    audioInputDevices,
    audioOutputDevices,
    selectedAudioInput,
    selectedAudioOutput,
    selectAudioInput,
    selectAudioOutput,
    enumerate,
  } = useMediaDevices();
  const settings = useAuthStore((s) => s.settings);
  const updateSettings = useAuthStore((s) => s.updateSettings);
  const applyAudioInputDevice = useVoiceStore((s) => s.applyAudioInputDevice);
  const applyAudioOutputDevice = useVoiceStore((s) => s.applyAudioOutputDevice);
  const notifications = (settings?.notifications ?? {}) as Record<string, unknown>;

  const close = useCallback(() => setOpen(false), []);

  const inputOptions = useMemo(
    () => buildDevicePickerOptions(audioInputDevices, {
      selectedDeviceId: selectedAudioInput,
      fallbackNoun: 'Microphone',
    }),
    [audioInputDevices, selectedAudioInput],
  );
  const outputOptions = useMemo(
    () => buildDevicePickerOptions(audioOutputDevices, {
      selectedDeviceId: selectedAudioOutput,
      fallbackNoun: 'Speaker',
    }),
    [audioOutputDevices, selectedAudioOutput],
  );
  const status = micStatus(props);
  const levelPercent = Math.round(Math.min(1, Math.max(0, props.micLevel)) * 100);

  useEffect(() => {
    const input = typeof notifications.audioInputDeviceId === 'string'
      ? notifications.audioInputDeviceId
      : '';
    const output = typeof notifications.audioOutputDeviceId === 'string'
      ? notifications.audioOutputDeviceId
      : '';
    selectAudioInput(input);
    selectAudioOutput(output);
  }, [notifications.audioInputDeviceId, notifications.audioOutputDeviceId, selectAudioInput, selectAudioOutput]);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8),
    );
    setCoords({
      bottom: Math.max(8, window.innerHeight - rect.top + 8),
      left,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  // Click-outside must include both the trigger and the portaled panel. A full
  // opaque backdrop would steal mousedown from native <select> popups.
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [open]);

  // Mount the panel whenever open so useFocusTrap can bind to panelRef on the
  // same commit (gating on coords left the trap inactive and Escape broken).
  useFocusTrap(panelRef, open, close);

  const persistDevice = async (key: 'audioInputDeviceId' | 'audioOutputDeviceId', value: string) => {
    try {
      await updateSettings({
        notifications: {
          ...notifications,
          [key]: value || null,
        },
      });
    } catch {
      toast.warning('Device switched for this call, but the preference could not be saved.');
    }
  };

  const changeInput = async (value: string) => {
    const previous = selectedAudioInput ?? '';
    selectAudioInput(value);
    setSwitching('input');
    try {
      const ok = await applyAudioInputDevice(value || null);
      if (!ok) {
        selectAudioInput(previous);
        toast.error('Could not switch microphone. It may be in use or unavailable.');
        return;
      }
      await persistDevice('audioInputDeviceId', value);
    } finally {
      setSwitching(null);
    }
  };

  const changeOutput = async (value: string) => {
    const previous = selectedAudioOutput ?? '';
    selectAudioOutput(value);
    setSwitching('output');
    try {
      const ok = await applyAudioOutputDevice(value || null);
      if (!ok) {
        selectAudioOutput(previous);
        toast.error('Could not switch speaker. It may be unavailable.');
        return;
      }
      await persistDevice('audioOutputDeviceId', value);
    } finally {
      setSwitching(null);
    }
  };

  const toggleOpen = () => {
    if (open) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
    void enumerate();
  };

  return (
    <div className="relative flex self-stretch">
      {/* Native title instead of Tooltip: the portaled tooltip sits at z-[9999]
          over the menu, and wrapping/unwrapping the trigger on open remounted
          the button mid-interaction. */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={open ? 'Hide audio devices' : 'Choose audio devices'}
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Audio devices"
        onClick={toggleOpen}
        className="flex h-11 w-7 items-center justify-center rounded-r-sm text-text-muted outline-none transition-colors hover:bg-bg-mod-subtle hover:text-interactive-hover focus-visible:shadow-[var(--focus-ring)]"
      >
        <ChevronUp size={14} className={cn('transition-transform', open && 'rotate-180')} />
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          role="dialog"
          aria-modal="true"
          aria-label="Audio devices and microphone check"
          tabIndex={-1}
          data-native-overlay-occlude=""
          className="fixed z-[80] w-[min(20rem,calc(100vw-1rem))] rounded-md border border-border-subtle bg-bg-secondary p-3 shadow-lg outline-none"
          style={{
            bottom: coords?.bottom ?? 72,
            left: coords?.left ?? 8,
          }}
        >
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-section uppercase text-text-muted">Audio devices</div>
              <p className="mt-1 text-meta text-text-secondary">
                Changes apply immediately and carry into your next call.
              </p>
            </div>
            <button
              type="button"
              aria-label="Close audio devices"
              onClick={close}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-text-muted outline-none transition-colors hover:bg-bg-mod-subtle hover:text-text-primary focus-visible:shadow-[var(--focus-ring)]"
            >
              <X size={16} />
            </button>
          </div>

          <div className={cn(
            'rounded-sm border px-3 py-2.5',
            status.warning ? 'border-accent-warning/40 bg-warning-tint' : 'border-border-subtle bg-bg-tertiary',
          )}>
            <div className="flex items-start gap-2.5">
              {status.warning
                ? <AlertTriangle size={17} className="mt-0.5 shrink-0 text-accent-warning" />
                : <Mic size={17} className="mt-0.5 shrink-0 text-accent-primary" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3 text-label">
                  <span className="font-semibold text-text-primary">{status.label}</span>
                  <span className="tabular-nums text-text-muted">{levelPercent}%</span>
                </div>
                <div
                  role="meter"
                  aria-label="Microphone input level"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={levelPercent}
                  className="mt-2 h-1.5 overflow-hidden rounded-full bg-bg-mod-strong"
                >
                  <div
                    className={cn('h-full rounded-full transition-[width] duration-100', status.warning ? 'bg-accent-warning' : 'bg-accent-primary')}
                    style={{ width: `${levelPercent}%` }}
                  />
                </div>
                <p className="mt-1.5 text-meta leading-snug text-text-secondary">{status.detail}</p>
              </div>
            </div>
          </div>

          <label className="mt-3 block text-label text-text-primary" htmlFor="in-call-audio-input">
            <span className="flex items-center gap-1.5"><Mic size={14} /> Microphone</span>
          </label>
          <Select
            id="in-call-audio-input"
            className="mt-1.5"
            value={selectedAudioInput ?? ''}
            disabled={switching !== null}
            onChange={(event) => void changeInput(event.target.value)}
          >
            <option value="">{systemDefaultOptionLabel('audioinput')}</option>
            {inputOptions.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.isSystemDefault ? `${device.label} (system default)` : device.label}
              </option>
            ))}
          </Select>

          <label className="mt-3 block text-label text-text-primary" htmlFor="in-call-audio-output">
            <span className="flex items-center gap-1.5"><Volume2 size={14} /> Speaker</span>
          </label>
          <Select
            id="in-call-audio-output"
            className="mt-1.5"
            value={selectedAudioOutput ?? ''}
            disabled={switching !== null}
            onChange={(event) => void changeOutput(event.target.value)}
          >
            <option value="">{systemDefaultOptionLabel('audiooutput')}</option>
            {outputOptions.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.isSystemDefault ? `${device.label} (system default)` : device.label}
              </option>
            ))}
          </Select>
        </div>,
        document.body,
      )}
    </div>
  );
}
