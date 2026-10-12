import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProtectedSheet } from './ProtectedSheet';
import { useAuthStore } from '../../stores/authStore';
import type { UserSettings } from '../../types';

const baseSettings: UserSettings = {
  user_id: '1',
  theme: 'dark',
  locale: 'en-US',
  message_display_compact: false,
  status: 'online',
  crypto_auth_enabled: false,
  link_previews: true,
  link_previews_available: true,
  notifications: {},
};

function setSettings(settings: UserSettings, updateSettings = vi.fn()) {
  useAuthStore.setState({ settings, hasFetchedSettings: true, updateSettings });
  return updateSettings;
}

describe('ProtectedSheet', () => {
  beforeEach(() => setSettings(baseSettings));
  afterEach(cleanup);

  it('lists the always-on rows and only the account rows for a non-host', () => {
    render(<ProtectedSheet open onClose={() => {}} />);
    expect(screen.getByText('Private messages')).toBeTruthy();
    expect(screen.getByText('Voice, video and screen share')).toBeTruthy();
    expect(screen.getAllByText('Always on')).toHaveLength(2);
    expect(screen.queryByText('Stored messages and files')).toBeNull();
    expect(screen.queryByText('Daily backups')).toBeNull();
  });

  it('shows "Show what I\'m playing" off for someone who never chose, and link previews on', () => {
    render(<ProtectedSheet open onClose={() => {}} />);
    expect(screen.getByRole('switch', { name: "Show what I'm playing" }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByRole('switch', { name: 'Link previews' }).getAttribute('aria-checked')).toBe('true');
  });

  it('keeps activity on for someone who explicitly turned it on', () => {
    setSettings({ ...baseSettings, notifications: { activityDetectionEnabled: true } });
    render(<ProtectedSheet open onClose={() => {}} />);
    expect(screen.getByRole('switch', { name: "Show what I'm playing" }).getAttribute('aria-checked')).toBe('true');
  });

  it('saves a switch at once, merging into the existing notifications', async () => {
    const update = setSettings({ ...baseSettings, notifications: { lowBandwidthMode: true } }, vi.fn().mockResolvedValue(undefined));
    render(<ProtectedSheet open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: "Show what I'm playing" }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith({
        notifications: { lowBandwidthMode: true, activityDetectionEnabled: true },
      }),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'Link previews' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith({ link_previews: false }));
  });

  it('reverts and says why when the server refuses', async () => {
    setSettings(baseSettings, vi.fn().mockRejectedValue(new Error('nope')));
    render(<ProtectedSheet open onClose={() => {}} />);
    fireEvent.click(screen.getByRole('switch', { name: 'Link previews' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('switch', { name: 'Link previews' }).getAttribute('aria-checked')).toBe('true');
  });

  it('disables link previews with the reason when the server has them off', () => {
    setSettings({ ...baseSettings, link_previews_available: false });
    render(<ProtectedSheet open onClose={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Link previews' }) as HTMLButtonElement;
    expect(sw.disabled).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Turned off on this server.')).toBeTruthy();
  });

  it('shows the host rows and reverts a refused backup toggle', async () => {
    const onChange = vi.fn().mockRejectedValue(new Error('disk is read-only'));
    render(
      <ProtectedSheet
        open
        onClose={() => {}}
        host={{
          storageCopy: "Encrypted on this computer's disk.",
          storageOn: true,
          inviteOnly: true,
          backups: { enabled: true, days: 14, onChange },
        }}
      />,
    );
    expect(screen.getByText('Invite only')).toBeTruthy();
    expect(screen.getByText('Kept on this computer for 14 days.')).toBeTruthy();
    fireEvent.click(screen.getByRole('switch', { name: 'Daily backups' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(false));
    expect((await screen.findByRole('alert')).textContent).toContain('disk is read-only');
    expect(screen.getByRole('switch', { name: 'Daily backups' }).getAttribute('aria-checked')).toBe('true');
  });

  it('Done closes', () => {
    const onClose = vi.fn();
    render(<ProtectedSheet open onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(onClose).toHaveBeenCalled();
  });
});
