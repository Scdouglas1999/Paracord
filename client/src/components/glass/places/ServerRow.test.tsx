import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ADD_ID, HOME_ID, ServerRow, serverIdOf, type ServerCircle, type ServerRowProps } from './ServerRow';

const SCOPE = { serverId: 'srv', userId: 'u1' };

function circle(over: Partial<ServerCircle> & Pick<ServerCircle, 'guildId' | 'name'>): ServerCircle {
  return {
    key: `k-${over.guildId}`,
    scope: SCOPE,
    icon: null,
    current: false,
    live: false,
    mentions: 0,
    unreadChannels: 0,
    ...over,
  };
}

const GAME = circle({ guildId: '1', name: 'Game Night', current: true });
const CAMP = circle({ guildId: '2', name: 'Basecamp' });
const LEAGUE = circle({ guildId: '3', name: 'Sunday League', live: true, mentions: 2 });

function renderRow(over: Partial<ServerRowProps> = {}) {
  const props: ServerRowProps = {
    circles: [GAME, CAMP, LEAGUE],
    homeActive: false,
    homeUnread: 0,
    stopId: serverIdOf(GAME),
    onStop: () => {},
    onOpenHome: () => {},
    onOpenServer: () => {},
    onAdd: () => {},
    ...over,
  };
  return { ...render(<ServerRow {...props} />), props };
}

describe('ServerRow', () => {
  it('is the tray, a hairline, a circle per server and the add button, in that order', () => {
    const { container } = renderRow();
    const buttons = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(buttons).toEqual(['Home and direct messages', 'Game Night', 'Basecamp', 'Sunday League, live, 2 mentions', 'Add or join a server']);
    expect(container.querySelector('.glass-places-servers__rule')).not.toBeNull();
    expect(screen.getByRole('navigation', { name: 'Servers' })).toBeInTheDocument();
  });

  it('gives the server you are in a bar, and marks it current', () => {
    const { container } = renderRow();
    expect(container.querySelectorAll('.glass-server__bar')).toHaveLength(1);
    const current = screen.getByRole('button', { name: 'Game Night' });
    expect(current).toHaveAttribute('aria-current', 'true');
    expect(current.querySelector('.glass-server__bar')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Basecamp' })).not.toHaveAttribute('aria-current');
  });

  it('gives the tray the bar in Home, and the servers none', () => {
    const { container } = renderRow({ circles: [CAMP, LEAGUE], homeActive: true, stopId: HOME_ID });
    expect(container.querySelectorAll('.glass-server__bar')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Home and direct messages' })).toHaveAttribute('aria-current', 'true');
  });

  it('marks a live server for the amber ring, and only that one', () => {
    renderRow();
    expect(screen.getByRole('button', { name: /Sunday League/ })).toHaveAttribute('data-live');
    expect(screen.getByRole('button', { name: 'Basecamp' })).not.toHaveAttribute('data-live');
  });

  it('draws mentions as white chips, and unread channels as count chips', () => {
    renderRow({ circles: [GAME, circle({ guildId: '2', name: 'Basecamp', unreadChannels: 3 }), LEAGUE, circle({ guildId: '4', name: 'Lone', mentions: 1 })] });
    expect(screen.getByText('@2')).toHaveAttribute('data-tone', 'mention');
    expect(screen.getByText('@')).toHaveAttribute('data-tone', 'mention');
    expect(screen.getByText('3')).toHaveAttribute('data-tone', 'count');
  });

  it('gives the server you are in no badge: its own rows carry them', () => {
    renderRow({ circles: [circle({ guildId: '1', name: 'Game Night', current: true, mentions: 4, unreadChannels: 2 })] });
    expect(screen.queryByText('@4')).toBeNull();
    expect(screen.queryByText('2')).toBeNull();
  });

  it('counts unread conversations on the tray, and names them', () => {
    renderRow({ homeUnread: 2 });
    expect(screen.getByRole('button', { name: 'Home and direct messages, 2 unread' })).toBeInTheDocument();
    expect(screen.getByText('2')).toHaveAttribute('data-tone', 'count');
  });

  it('draws the icon when a server has one, and its initials when it does not', () => {
    const png = 'data:image/png;base64,AAAA';
    const { container } = renderRow({ circles: [circle({ guildId: '1', name: 'Game Night', icon: png }), circle({ guildId: '2', name: 'Base Camp' })] });
    expect(container.querySelector('.glass-server__icon img')).toHaveAttribute('src', png);
    expect(screen.getByRole('button', { name: 'Base Camp' })).toHaveTextContent('BC');
  });

  it('opens Home, a server and the add flow', () => {
    const onOpenHome = vi.fn();
    const onOpenServer = vi.fn();
    const onAdd = vi.fn();
    renderRow({ onOpenHome, onOpenServer, onAdd });
    fireEvent.click(screen.getByRole('button', { name: 'Home and direct messages' }));
    fireEvent.click(screen.getByRole('button', { name: 'Basecamp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add or join a server' }));
    expect(onOpenHome).toHaveBeenCalledTimes(1);
    expect(onOpenServer).toHaveBeenCalledWith(expect.objectContaining({ guildId: '2' }));
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it('opens the server menu on a right click', () => {
    const onServerMenu = vi.fn();
    renderRow({ onServerMenu });
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Basecamp' }));
    expect(onServerMenu).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ guildId: '2' }));
  });

  it('is one Tab stop: the one it was told, -1 for the rest', () => {
    renderRow({ stopId: serverIdOf(CAMP) });
    const stops = screen.getAllByRole('button').filter((button) => button.getAttribute('tabindex') === '0');
    expect(stops).toHaveLength(1);
    expect(stops[0]).toHaveAccessibleName('Basecamp');
  });

  it('reports the button that took focus, so the stop follows it', () => {
    const onStop = vi.fn();
    renderRow({ onStop });
    fireEvent.focus(screen.getByRole('button', { name: 'Add or join a server' }));
    expect(onStop).toHaveBeenCalledWith(ADD_ID);
  });

  it('moves along the row with the arrow keys, wrapping, and to the ends with Home and End', () => {
    renderRow();
    const buttons = screen.getAllByRole('button');
    buttons[1].focus();
    fireEvent.keyDown(buttons[1], { key: 'ArrowRight' });
    expect(buttons[2]).toHaveFocus();
    fireEvent.keyDown(buttons[2], { key: 'ArrowLeft' });
    expect(buttons[1]).toHaveFocus();
    fireEvent.keyDown(buttons[1], { key: 'End' });
    expect(buttons[buttons.length - 1]).toHaveFocus();
    fireEvent.keyDown(buttons[buttons.length - 1], { key: 'ArrowRight' });
    expect(buttons[0]).toHaveFocus();
    fireEvent.keyDown(buttons[0], { key: 'ArrowLeft' });
    expect(buttons[buttons.length - 1]).toHaveFocus();
    fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Home' });
    expect(buttons[0]).toHaveFocus();
  });

  it('fades the edge that has more, when the row overflows', () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(600);
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    try {
      const { container } = renderRow();
      const nav = container.querySelector('.glass-places-servers') as HTMLElement;
      expect(nav).toHaveAttribute('data-fade-end');
      expect(nav).not.toHaveAttribute('data-fade-start');
      const scroller = container.querySelector('.glass-places-servers__scroll') as HTMLElement;
      scroller.scrollLeft = 120;
      fireEvent.scroll(scroller);
      expect(nav).toHaveAttribute('data-fade-start');
      expect(nav).toHaveAttribute('data-fade-end');
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
    }
  });

  it('has no fades when everything fits', () => {
    const { container } = renderRow();
    const nav = container.querySelector('.glass-places-servers') as HTMLElement;
    expect(nav).not.toHaveAttribute('data-fade-start');
    expect(nav).not.toHaveAttribute('data-fade-end');
  });

  it('keeps the current server in view', () => {
    const scrollIntoView = vi.fn();
    const original = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    try {
      renderRow();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', inline: 'nearest' });
    } finally {
      HTMLElement.prototype.scrollIntoView = original;
    }
  });
});
