import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceStore } from '../../../stores/voiceStore';
import { DmCallButton } from './DmCallButton';

/**
 * The toolbar's DM call button (docs/index-spec.md §4.9, §7.5): it starts the call
 * with the card's own join, and while the call runs it is active and opens the call
 * view.
 */
const actions = vi.hoisted(() => ({ joinCall: vi.fn(), showCall: vi.fn() }));
vi.mock('../../glass/pill/pillActions', () => actions);
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => ({ serverId: 'srv', userId: 'me' }),
}));

beforeEach(() => {
  actions.joinCall.mockReset();
  actions.showCall.mockReset();
  useVoiceStore.setState({ connected: false, channelId: null, joining: false, joiningChannelId: null });
});
afterEach(cleanup);

describe('DmCallButton', () => {
  it('starts a direct message call through the card’s join, as a DM call', async () => {
    render(<DmCallButton channelId="dm1" title="Jeremy" allowed reason={null} />);
    const button = screen.getByRole('button', { name: 'Start a call' });
    expect(button).not.toHaveAttribute('data-active');
    await userEvent.click(button);
    expect(actions.joinCall).toHaveBeenCalledWith({ serverId: 'srv', guildId: 'dm', channelId: 'dm1', title: 'Jeremy' });
    expect(actions.showCall).not.toHaveBeenCalled();
  });

  it('while the call runs it is active and opens the call view instead of starting another', async () => {
    useVoiceStore.setState({ connected: true, channelId: 'dm1' });
    render(<DmCallButton channelId="dm1" title="Jeremy" allowed reason={null} />);
    const button = screen.getByRole('button', { name: 'Open the call' });
    expect(button).toHaveAttribute('data-active', 'true');
    await userEvent.click(button);
    expect(actions.showCall).toHaveBeenCalledWith({ serverId: 'srv', guildId: 'dm', channelId: 'dm1', title: 'Jeremy' });
    expect(actions.joinCall).not.toHaveBeenCalled();
  });

  it('a call in another conversation does not make this one active', () => {
    useVoiceStore.setState({ connected: true, channelId: 'other' });
    render(<DmCallButton channelId="dm1" title="Jeremy" allowed reason={null} />);
    expect(screen.getByRole('button', { name: 'Start a call' })).not.toHaveAttribute('data-active');
  });

  it('is disabled when the server refuses, and says why in its title', () => {
    render(<DmCallButton channelId="dm1" title="Jeremy" allowed={false} reason="You blocked this person." />);
    const button = screen.getByRole('button', { name: 'Start a call' });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'You blocked this person.');
  });

  it('waits while the call is being joined', () => {
    useVoiceStore.setState({ joining: true, joiningChannelId: 'dm1' });
    render(<DmCallButton channelId="dm1" title="Jeremy" allowed reason={null} />);
    expect(screen.getByRole('button', { name: 'Start a call' })).toBeDisabled();
    act(() => useVoiceStore.setState({ joining: false, joiningChannelId: null }));
    expect(screen.getByRole('button', { name: 'Start a call' })).toBeEnabled();
  });
});
