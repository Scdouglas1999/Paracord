import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { gateway } from '../../../gateway/manager';
import { useServerListStore } from '../../../stores/serverListStore';
import { useUIStore } from '../../../stores/uiStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { useAuthStore } from '../../../stores/authStore';
import { ConnectionStatusBar } from '../../ConnectionStatusBar';
import { RestartBanner } from '../../RestartBanner';
import { BannerStrip } from './BannerStrip';

/**
 * The banner strip (docs/index-spec.md §6.8): a 36px strip in the card's color with
 * its words and at most one text action; never amber.
 */
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('BannerStrip', () => {
  it('says its words, with one text action and a way to put it away', async () => {
    const press = vi.fn();
    const away = vi.fn();
    render(
      <BannerStrip action={{ label: 'Restart to update', onPress: press }} onDismiss={away} dismissLabel="Update later">
        Paracord 3.4.0 is ready to install.
      </BannerStrip>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Paracord 3.4.0 is ready to install.');
    await userEvent.click(screen.getByRole('button', { name: 'Restart to update' }));
    await userEvent.click(screen.getByRole('button', { name: 'Update later' }));
    expect(press).toHaveBeenCalledTimes(1);
    expect(away).toHaveBeenCalledTimes(1);
  });

  it('an error is the danger ink and speaks at once; a plain strip waits its turn', () => {
    const { rerender } = render(<BannerStrip tone="danger" role="alert">It did not finish.</BannerStrip>);
    expect(screen.getByRole('alert')).toHaveAttribute('data-tone', 'danger');
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive');
    rerender(<BannerStrip>Fine.</BannerStrip>);
    expect(screen.getByRole('status')).toHaveAttribute('data-tone', 'plain');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('has no action or dismiss unless it is given one', () => {
    render(<BannerStrip>Only words.</BannerStrip>);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('the instance restarting', () => {
  it('is a strip with its words and nothing to press', () => {
    useUIStore.setState({ serverRestarting: true });
    render(<RestartBanner />);
    expect(screen.getByTestId('ix-banner-restart')).toHaveTextContent('The instance is restarting. You’ll reconnect automatically.');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    cleanup();
    useUIStore.setState({ serverRestarting: false });
    render(<RestartBanner />);
    expect(screen.queryByTestId('ix-banner-restart')).not.toBeInTheDocument();
  });
});

describe('the connection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'sean' } as never });
    useServerListStore.setState({ activeServerId: null, servers: [] });
    useVoiceStore.setState({ connected: false });
    useUIStore.setState({ connectionStatus: 'connected' });
  });

  it('says "Connection lost" after four seconds and offers "Retry now", which reconnects', async () => {
    const connect = vi.spyOn(gateway, 'connectAll').mockResolvedValue(undefined as never);
    render(<ConnectionStatusBar />);
    act(() => useUIStore.setState({ connectionStatus: 'disconnected' }));
    expect(screen.queryByTestId('ix-banner-connection')).not.toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(4100));
    expect(screen.getByTestId('ix-banner-connection')).toHaveTextContent('Connection lost, retrying automatically');
    act(() => void screen.getByRole('button', { name: 'Retry now' }).click());
    expect(connect).toHaveBeenCalled();
  });

  it('says "Reconnecting to the instance…" with no action, and "Back online" for two seconds', () => {
    render(<ConnectionStatusBar />);
    act(() => useUIStore.setState({ connectionStatus: 'reconnecting' }));
    act(() => void vi.advanceTimersByTime(4100));
    expect(screen.getByTestId('ix-banner-connection')).toHaveTextContent('Reconnecting to the instance…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    act(() => useUIStore.setState({ connectionStatus: 'connected' }));
    expect(screen.getByTestId('ix-banner-connection')).toHaveTextContent('Back online');
    expect(screen.getByTestId('ix-banner-connection')).toHaveAttribute('data-tone', 'plain');
  });
});
