import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const authState = vi.hoisted(() => ({
  current: { user: { username: 'ada', display_name: 'Ada Lovelace' } } as Record<string, unknown>,
}));
vi.mock('../../stores/authStore', () => ({
  useAuthStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(authState.current),
    { getState: () => authState.current },
  ),
}));
// The real adapters reach for the API client; the panel under test is always
// driven by injected fakes, so stub the module rather than the network.
vi.mock('../../api/activeClient', () => ({ getApi: () => ({ get: vi.fn() }) }));

import { VoiceConnectionCheck } from './VoiceConnectionCheck';
import type {
  DiagnosticsAdapters,
  MediaTransportConfig,
  TransportProbeOutcome,
} from '../../lib/media/diagnostics';

const PIN = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

function config(): MediaTransportConfig {
  return {
    transport: 'native',
    voiceAvailable: true,
    mediaEndpoint: 'https://chat.example.com:8443/media',
    mediaEndpointCandidates: [],
    mediaUdpPort: 8443,
    certificatePinSha256: PIN,
    certificateSource: 'server-generated-self-signed',
    livekitAvailable: false,
    e2eeRequired: true,
    maxParticipants: 50,
  };
}

interface FakeArgs {
  probe?: Partial<TransportProbeOutcome>;
  onLevel?: number;
  heardTone?: boolean;
  useOwnAsk?: boolean;
}

function fakeAdapters(args: FakeArgs = {}): DiagnosticsAdapters {
  let tick = 0;
  return {
    environment: {
      read: () => ({
        engine: 'browser',
        isSecureContext: true,
        protocol: 'https:',
        host: 'chat.example.com',
        userAgent: 'Mozilla/5.0 Chrome/130.0.0.0',
        language: 'en-GB',
      }),
    },
    capabilities: {
      hasWebTransport: () => true,
      supportsCertificatePinning: () => true,
      hasMediaDevices: () => true,
      hasAudioWorklet: () => true,
      supportsOpus: async () => true,
      supportsVp9: async () => true,
    },
    devices: {
      permission: async () => 'granted',
      enumerate: async () => [
        { deviceId: 'mic-1', kind: 'audioinput', label: 'Headset mic' },
        { deviceId: 'out-1', kind: 'audiooutput', label: 'Headset' },
      ],
      measureMicrophone: async (request) => {
        request.onLevel?.(args.onLevel ?? 0.6);
        return { peak: 0.6, rms: 0.3, sampledMs: request.durationMs, deviceLabel: 'Headset mic' };
      },
      playTestTone: async () => ({ routedToSelectedDevice: true }),
      openCamera: async () => ({ label: 'Webcam' }),
    },
    server: { fetchTransportConfig: async () => config() },
    transport: {
      probe: async () => ({
        ok: true,
        rttMs: 19,
        streamOpened: true,
        failure: null,
        detail: null,
        ...args.probe,
      }),
    },
    now: () => (tick += 3),
    ask: args.useOwnAsk ? undefined : async () => args.heardTone ?? true,
  };
}

describe('VoiceConnectionCheck', () => {
  it('lists every step before anything runs and explains it never joins a call', () => {
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={fakeAdapters()} />);
    expect(screen.getByText('Voice connection check')).toBeInTheDocument();
    expect(screen.getByText(/never joins a call/i)).toBeInTheDocument();
    expect(screen.getByTestId('voice-check-step-transport')).toHaveAttribute('data-status', 'pending');
    expect(screen.getByRole('button', { name: /run check/i })).toBeInTheDocument();
  });

  it('stacks above the settings overlay so its controls stay clickable', () => {
    // Settings is a windowed overlay at z-[150]. A lower stacking order left the
    // panel behind that backdrop, where every click was swallowed.
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={fakeAdapters()} />);
    const backdrop = document.querySelector('.modal-backdrop');
    expect(backdrop?.className).toContain('z-[160]');
  });

  it('runs the check and reports a healthy result', async () => {
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={fakeAdapters()} />);
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    await waitFor(() =>
      expect(screen.getByTestId('voice-check-step-transport')).toHaveAttribute('data-status', 'pass'),
    );
    expect(screen.getByText(/Everything needed for a call is working/i)).toBeInTheDocument();
    expect(screen.getByText(/Opened a media connection/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /run again/i })).toBeInTheDocument();
  });

  it('shows a blocked UDP path as a precise, actionable transport failure', async () => {
    render(
      <VoiceConnectionCheck
        open
        onClose={() => {}}
        adapters={fakeAdapters({
          probe: { ok: false, rttMs: null, streamOpened: false, failure: 'timeout', detail: 'no reply' },
        })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    await waitFor(() =>
      expect(screen.getByTestId('voice-check-step-transport')).toHaveAttribute('data-status', 'fail'),
    );
    expect(screen.getByText(/forward UDP port 8443/i)).toBeInTheDocument();
    expect(screen.getByText('TRANSPORT_TIMEOUT')).toBeInTheDocument();
    // The failure must not imply chat is broken too.
    expect(screen.getByText(/Chat is unaffected/i)).toBeInTheDocument();
  });

  it('asks whether the test tone was heard and honours the answer', async () => {
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={fakeAdapters({ useOwnAsk: true })} />);
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    const no = await screen.findByRole('button', { name: /No, nothing played/i });
    fireEvent.click(no);
    await waitFor(() =>
      expect(screen.getByTestId('voice-check-step-speaker')).toHaveAttribute('data-status', 'fail'),
    );
    expect(screen.getByText(/did not hear the test tone/i)).toBeInTheDocument();
  });

  it('shows a live input level meter while the microphone is measured', async () => {
    const gate: { release: () => void } = { release: () => {} };
    const adapters = fakeAdapters();
    adapters.devices.measureMicrophone = async (request) => {
      request.onLevel?.(0.5);
      await new Promise<void>((resolve) => {
        gate.release = resolve;
      });
      return { peak: 0.5, rms: 0.2, sampledMs: 100, deviceLabel: 'Headset mic' };
    };
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={adapters} />);
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    const meter = await screen.findByRole('meter', { name: /microphone input level/i });
    expect(meter).toHaveAttribute('aria-valuenow', '50');
    gate.release();
  });

  it('offers the diagnostics export only once there is a report to export', async () => {
    render(<VoiceConnectionCheck open onClose={() => {}} adapters={fakeAdapters()} />);
    const exportButton = screen.getByRole('button', { name: /export diagnostics/i });
    expect(exportButton).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    await waitFor(() => expect(exportButton).not.toBeDisabled());
  });

  it('exports a redacted report with no credentials in it', async () => {
    const createObjectURL = vi.fn().mockReturnValue('blob:fake');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL, revokeObjectURL });
    const adapters = fakeAdapters();
    adapters.server.fetchTransportConfig = async () => ({
      ...config(),
      mediaEndpoint: 'https://ada:hunter2@chat.example.com:8443/media',
    });

    render(<VoiceConnectionCheck open onClose={() => {}} adapters={adapters} />);
    fireEvent.click(screen.getByRole('button', { name: /run check/i }));
    const exportButton = screen.getByRole('button', { name: /export diagnostics/i });
    await waitFor(() => expect(exportButton).not.toBeDisabled());
    fireEvent.click(exportButton);

    expect(createObjectURL).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    const text = await blob.text();
    expect(text).not.toContain('hunter2');
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('TRANSPORT_OK');
    vi.unstubAllGlobals();
  });

  it('closes without touching the call the user is in', async () => {
    const onClose = vi.fn();
    const adapters = fakeAdapters();
    const probe = vi.fn();
    adapters.transport.probe = probe;
    const { rerender } = render(
      <VoiceConnectionCheck open onClose={onClose} adapters={adapters} />,
    );
    // The footer action, not the header's icon-only close button.
    fireEvent.click(screen.getByText('Close'));
    expect(onClose).toHaveBeenCalledOnce();
    rerender(<VoiceConnectionCheck open={false} onClose={onClose} adapters={adapters} />);
    expect(probe).not.toHaveBeenCalled();
    // AnimatePresence keeps the panel mounted for its exit transition.
    await waitFor(() =>
      expect(screen.queryByText('Voice connection check')).not.toBeInTheDocument(),
    );
  });

  it('starts on its own when opened from a join failure', async () => {
    render(<VoiceConnectionCheck open autoStart onClose={() => {}} adapters={fakeAdapters()} />);
    await waitFor(() =>
      expect(screen.getByTestId('voice-check-step-transport')).toHaveAttribute('data-status', 'pass'),
    );
  });
});
