import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Search, Users, Pin } from 'lucide-react';
import { ConversationHeaderActions, attentionDescription } from './ConversationHeaderActions';

const primary = [
  { label: 'Search messages', icon: Search, onClick: vi.fn(), controlsPanel: true },
  { label: 'Member List', icon: Users, onClick: vi.fn(), controlsPanel: true },
];
const items = [{ label: 'Pinned messages', action: vi.fn() }, { label: 'Inbox', action: vi.fn() }];

describe('conversation header hierarchy', () => {
  it('keeps only frequent actions visible until the labeled menu is opened', async () => {
    const user = userEvent.setup();
    render(<ConversationHeaderActions primary={primary} items={items} unread={0} mentions={0} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Search messages' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Member List' })).toBeVisible();
    expect(screen.queryByText('Pinned messages')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More channel actions' }));
    expect(screen.getByRole('menu', { name: 'Channel actions' })).toHaveFocus();
    expect(screen.getByRole('menuitem', { name: 'Pinned messages' })).toBeVisible();
  });

  it('returns focus after Escape and leaves focus with the selected destination', async () => {
    const user = userEvent.setup();
    let focusDuringSelection: Element | null = null;
    const selected = vi.fn(() => { focusDuringSelection = document.activeElement; });
    render(<ConversationHeaderActions primary={primary} items={[{ label: 'Open panel', action: selected }]} unread={0} mentions={0} />);
    const more = screen.getByRole('button', { name: 'More channel actions' });
    more.focus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(more).toHaveFocus();
    await user.keyboard('{ArrowDown}{Home}{Enter}');
    expect(selected).toHaveBeenCalledOnce();
    expect(focusDuringSelection).toBe(more);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps an open secondary panel visible and closes it without losing focus', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return <ConversationHeaderActions primary={primary} items={items} unread={0} mentions={0}
        activeSurface={open ? { label: 'Pinned messages', icon: Pin, onClose: () => setOpen(false) } : undefined} />;
    }
    const user = userEvent.setup();
    render(<Harness />);
    const close = screen.getByRole('button', { name: 'Close Pinned messages' });
    expect(close).toHaveAttribute('aria-expanded', 'true');
    await user.click(close);
    expect(screen.queryByRole('button', { name: 'Close Pinned messages' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More channel actions' })).toHaveFocus();
  });

  it('distinguishes ordinary unread activity from mentions in shape, text and accessible description', () => {
    const view = render(<ConversationHeaderActions primary={primary} items={items} unread={4} mentions={0} />);
    const more = screen.getByRole('button', { name: 'More channel actions' });
    expect(more).toHaveAccessibleDescription('4 unread conversations');
    expect(more.querySelector('[data-attention-kind="unread"]')).not.toBeNull();
    expect(more.querySelector('[data-attention-kind="mentions"]')).toBeNull();
    view.rerender(<ConversationHeaderActions primary={primary} items={items} unread={4} mentions={3} />);
    expect(more).toHaveAccessibleDescription('3 mentions in 4 unread conversations');
    expect(more.querySelector('[data-attention-kind="unread"]')).toBeNull();
    expect(more.querySelector('[data-attention-kind="mentions"]')).toHaveTextContent('@3');
    view.rerender(<ConversationHeaderActions primary={primary} items={items} unread={0} mentions={0} />);
    expect(more.querySelector('[data-attention-kind]')).toBeNull();
    expect(more).toHaveAccessibleDescription('No unread conversations');
  });

  it('preserves primary button identity and focus across realtime count changes', () => {
    const view = render(<ConversationHeaderActions primary={primary} items={items} unread={0} mentions={0} />);
    const search = screen.getByRole('button', { name: 'Search messages' });
    act(() => search.focus());
    view.rerender(<ConversationHeaderActions primary={primary.map(item => ({ ...item }))} items={items} unread={9} mentions={120} />);
    expect(screen.getByRole('button', { name: 'Search messages' })).toBe(search);
    expect(search).toHaveFocus();
    expect(screen.getByText('@99+')).toBeVisible();
  });

  it('dismisses the menu when a keyboard shortcut opens a different panel', () => {
    const view = render(<ConversationHeaderActions primary={primary} items={items} unread={0} mentions={0} />);
    fireEvent.click(screen.getByRole('button', { name: 'More channel actions' }));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    view.rerender(<ConversationHeaderActions primary={primary.map(item => ({ ...item, active: item.label === 'Search messages' }))} items={items} unread={0} mentions={0} />);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('uses explicit singular count descriptions', () => {
    expect(attentionDescription(1, 1)).toBe('1 mention in 1 unread conversation');
    expect(attentionDescription(1, 0)).toBe('1 unread conversation');
  });
});
