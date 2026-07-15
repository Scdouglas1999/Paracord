import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InCallDeviceMenu } from './InCallDeviceMenu';

const mediaDevices = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));
const authState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const voiceState = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
const toastMock = vi.hoisted(() => ({ error: vi.fn(), warning: vi.fn() }));

vi.mock('../../hooks/useMediaDevices', () => ({
  useMediaDevices: () => mediaDevices.current,
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: (selector: (state: Record<string, unknown>) => unknown) => selector(authState.current),
}));
vi.mock('../../stores/voiceStore', () => ({
  useVoiceStore: (selector: (state: Record<string, unknown>) => unknown) => selector(voiceState.current),
}));
vi.mock('../../stores/toastStore', () => ({ toast: toastMock }));

const baseProps = {
  micLevel: 0.42,
  micMuted: false,
  micInputActive: true,
  micUplinkState: 'sending',
  isPttMode: false,
  pttEngaged: false,
};

describe('InCallDeviceMenu', () => {
  beforeEach(() => {
    mediaDevices.current = {
      audioInputDevices: [
        { deviceId: 'mic-1', label: 'Focusrite Scarlett Solo USB', kind: 'audioinput', groupId: '' },
      ],
      audioOutputDevices: [
        { deviceId: 'speaker-1', label: 'Studio Speakers', kind: 'audiooutput', groupId: '' },
      ],
      selectedAudioInput: null,
      selectedAudioOutput: null,
      selectAudioInput: vi.fn(),
      selectAudioOutput: vi.fn(),
      enumerate: vi.fn().mockResolvedValue(undefined),
    };
    authState.current = {
      settings: { notifications: {} },
      updateSettings: vi.fn().mockResolvedValue(undefined),
    };
    voiceState.current = {
      applyAudioInputDevice: vi.fn().mockResolvedValue(true),
      applyAudioOutputDevice: vi.fn().mockResolvedValue(true),
    };
    toastMock.error.mockReset();
    toastMock.warning.mockReset();
  });

  it('shows input health and enumerates devices when opened', () => {
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));

    expect(mediaDevices.current.enumerate).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Microphone is working')).toBeInTheDocument();
    expect(screen.getByRole('meter', { name: 'Microphone input level' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByRole('option', { name: 'Focusrite Scarlett Solo USB' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Studio Speakers' })).toBeInTheDocument();
  });

  it('closes via the explicit close button', () => {
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    expect(screen.getByRole('dialog', { name: 'Audio devices and microphone check' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close audio devices' }));
    expect(screen.queryByRole('dialog', { name: 'Audio devices and microphone check' })).toBeNull();
  });

  it('closes when the toggle is pressed again', () => {
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    expect(screen.getByRole('dialog', { name: 'Audio devices and microphone check' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Hide audio devices' }));
    expect(screen.queryByRole('dialog', { name: 'Audio devices and microphone check' })).toBeNull();
  });

  it('closes on Escape', () => {
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    expect(screen.getByRole('dialog', { name: 'Audio devices and microphone check' })).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Audio devices and microphone check' })).toBeNull();
  });

  it('closes on pointerdown outside the panel', () => {
    render(
      <div>
        <InCallDeviceMenu {...baseProps} />
        <button type="button">Outside</button>
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    expect(screen.getByRole('dialog', { name: 'Audio devices and microphone check' })).toBeInTheDocument();

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog', { name: 'Audio devices and microphone check' })).toBeNull();
  });

  it('applies and persists a microphone change', async () => {
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    fireEvent.change(screen.getByLabelText('Microphone'), { target: { value: 'mic-1' } });

    await waitFor(() => {
      expect(voiceState.current.applyAudioInputDevice).toHaveBeenCalledWith('mic-1');
      expect(authState.current.updateSettings).toHaveBeenCalledWith({
        notifications: { audioInputDeviceId: 'mic-1' },
      });
    });
  });

  it('warns when an output device cannot be applied', async () => {
    (voiceState.current.applyAudioOutputDevice as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    render(<InCallDeviceMenu {...baseProps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    fireEvent.change(screen.getByLabelText('Speaker'), { target: { value: 'speaker-1' } });

    await waitFor(() => {
      expect(toastMock.error).toHaveBeenCalledWith('Could not switch speaker. It may be unavailable.');
    });
    expect(authState.current.updateSettings).not.toHaveBeenCalled();
  });

  it('distinguishes a stalled uplink from local microphone activity', () => {
    render(<InCallDeviceMenu {...baseProps} micUplinkState="stalled" />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose audio devices' }));
    expect(screen.getByText('Microphone needs attention')).toBeInTheDocument();
    expect(screen.getByText(/detected locally, but audio is not reaching the call reliably/i)).toBeInTheDocument();
  });
});
