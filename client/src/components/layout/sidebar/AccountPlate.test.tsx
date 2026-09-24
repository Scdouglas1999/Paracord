import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountPlate, accountCaption } from './AccountPlate';
import { useAuthStore } from '../../../stores/authStore';
import { useUIStore } from '../../../stores/uiStore';

/**
 * The account plate (docs/lantern-stage-spec.md §7.1, §8).
 *
 * It replaced `UserPanel`, so the test's job is to prove nothing that panel
 * could do was lost on the way: the status picker, a custom status, copy
 * username, the microphone and headphone toggles, the admin entry and user
 * settings — now one plate and one menu.
 */

const user = { id: 'u1', username: 'sam.douglas', display_name: null, avatar_hash: null, flags: 0 };

const props = {
  user,
  navigate: vi.fn(),
  muted: false,
  deafened: false,
  onToggleMute: vi.fn(),
  onToggleDeaf: vi.fn(),
  showAdminDashboard: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({
    settings: { status: 'online', custom_status: null } as never,
    updateSettings: vi.fn().mockResolvedValue(undefined) as never,
  });
  useUIStore.setState({ userSettingsOpen: false });
});

describe('accountCaption', () => {
  it('says the status in words, and what is switched off', () => {
    expect(accountCaption('online', null, false, false)).toBe('Online');
    expect(accountCaption('idle', null, false, false)).toBe('Away');
    expect(accountCaption('invisible', null, false, false)).toBe('Invisible');
    expect(accountCaption('online', null, true, false)).toBe('Online · muted');
    expect(accountCaption('online', null, true, true)).toBe('Online · deafened');
    expect(accountCaption('online', 'On the bench', false, false)).toBe('On the bench');
  });
});

describe('AccountPlate', () => {
  it('shows the name and the light, and opens user settings', () => {
    render(<AccountPlate {...props} />);
    expect(screen.getByText('sam.douglas')).toBeInTheDocument();
    expect(screen.getByText('Online')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open user settings' }));
    expect(useUIStore.getState().userSettingsOpen).toBe(true);
  });

  it('carries every user-panel action into one menu', () => {
    render(<AccountPlate {...props} showAdminDashboard />);
    fireEvent.click(screen.getByRole('button', { name: /Open account menu/ }));

    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(within(menu).getByRole('menuitemradio', { name: /Online/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(menu).getByRole('menuitemradio', { name: /Do not disturb/ })).toBeInTheDocument();
    expect(within(menu).getByText('Copy username')).toBeInTheDocument();
    expect(within(menu).getByText('Admin dashboard')).toBeInTheDocument();
    expect(within(menu).getByLabelText('Custom status')).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /Microphone/ }));
    expect(props.onToggleMute).toHaveBeenCalled();
  });

  it('changes the status through the auth store, not by guessing', () => {
    render(<AccountPlate {...props} />);
    fireEvent.click(screen.getByRole('button', { name: /Open account menu/ }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Away/ }));
    expect(useAuthStore.getState().updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'idle' }),
    );
  });

  it('spends no literal color', () => {
    const { container } = render(<AccountPlate {...props} muted />);
    expect(container.innerHTML).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(container.innerHTML).not.toMatch(/\brgba?\(\s*\d/);
  });
});
