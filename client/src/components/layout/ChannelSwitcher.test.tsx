import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';
import { ChannelType, type Channel } from '../../types';
import { ChannelSwitcher } from './ChannelSwitcher';

function channel(id: string, name: string, type: ChannelType, position: number): Channel {
  return {
    id,
    name,
    type,
    position,
    nsfw: false,
    created_at: '2026-01-01T00:00:00Z',
  };
}

const channels = [
  channel('general', 'general', ChannelType.Text, 0),
  channel('ideas', 'project-ideas', ChannelType.Forum, 1),
  channel('lounge', 'Lounge', ChannelType.Voice, 2),
  channel('stage', 'Town Hall', ChannelType.Stage, 3),
];

function LocationProbe() {
  return <div data-testid="pathname">{useLocation().pathname}</div>;
}

function renderSwitcher() {
  return render(
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/general']}>
      <ChannelSwitcher
        guildId="g1"
        guildName="Emerald HQ"
        channelId="general"
        channelName="general"
        channelType={ChannelType.Text}
        channels={channels}
      />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('ChannelSwitcher', () => {
  it('opens a grouped room menu with Rooms home and the active channel', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    const trigger = screen.getByRole('button', { name: 'Switch room, current: general' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);

    const dialog = screen.getByRole('dialog', { name: 'Switch room in Emerald HQ' });
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(within(dialog).getByRole('button', { name: 'Rooms home' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'general' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(dialog).getByText('Text Channels')).toBeInTheDocument();
    expect(within(dialog).getByText('Voice Channels')).toBeInTheDocument();
  });

  it('filters by room name and navigates without returning to the space map', async () => {
    const user = userEvent.setup();
    renderSwitcher();

    await user.click(screen.getByRole('button', { name: 'Switch room, current: general' }));
    await user.type(screen.getByPlaceholderText('Find a room'), 'project');

    expect(screen.getByRole('button', { name: 'project-ideas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Lounge' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'project-ideas' }));

    expect(screen.getByTestId('pathname')).toHaveTextContent(
      '/app/guilds/g1/channels/ideas',
    );
    expect(screen.queryByRole('dialog', { name: 'Switch room in Emerald HQ' })).not.toBeInTheDocument();
  });

  it('supports ArrowDown from search and closes with Escape', () => {
    renderSwitcher();
    fireEvent.click(screen.getByRole('button', { name: 'Switch room, current: general' }));
    const search = screen.getByPlaceholderText('Find a room');

    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getByRole('button', { name: 'Rooms home' })).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch room in Emerald HQ' })).not.toBeInTheDocument();
  });

  it('marks the room menu as a modal dialog so shell Escape defers to it', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch room, current: general' }));

    const dialog = screen.getByRole('dialog', { name: 'Switch room in Emerald HQ' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('closes with Escape even when focus has left the popover', async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByRole('button', { name: 'Switch room, current: general' }));
    expect(screen.getByRole('dialog', { name: 'Switch room in Emerald HQ' })).toBeInTheDocument();

    // Simulate focus escaping the popover (e.g. Tab into the members panel).
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    document.body.appendChild(outside);
    outside.focus();
    expect(outside).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Switch room in Emerald HQ' })).not.toBeInTheDocument();
    outside.remove();
  });

  // A button sizes to its content rather than filling a block parent, so without
  // `w-full` the trigger keeps its natural width while the header squeezes the
  // wrapper — and the room name spills out over the channel topic beside it
  // instead of ellipsizing. The floor keeps the name legible once a context
  // panel narrows the header, since the icon and chevron cannot shrink.
  it('keeps the room name inside its own box when the header is squeezed', () => {
    renderSwitcher();
    const trigger = screen.getByRole('button', { name: 'Switch room, current: general' });

    expect(trigger.className).toContain('w-full');
    expect(trigger.className).toContain('min-w-0');

    const wrapper = trigger.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper!.className).toMatch(/min-w-\[\d/);

    const label = within(trigger).getByText('general');
    expect(label.className).toContain('truncate');
  });
});
