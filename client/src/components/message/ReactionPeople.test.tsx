import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReactionChip } from './ReactionPeople';

/**
 * The feed's reaction chip says who reacted with the same behavior and the same
 * list as the timeline's (`ReactionBite`): rest on it or right-click for the
 * people, click to toggle yours. The list's faces are the plain Glass ones.
 */

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('../../api/reminders', () => ({ reactionUsersApi: { list: mocks.list } }));
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const person = (id: string, name: string | null, username = name ?? `user${id}`) => ({
  id,
  username,
  display_name: name,
  avatar_hash: null,
});

function renderChip(over: Partial<React.ComponentProps<typeof ReactionChip>> = {}) {
  const onToggle = vi.fn();
  render(
    <ReactionChip
      emoji="🔥"
      count={2}
      me={false}
      glyph={<span>🔥</span>}
      channelId="c1"
      messageId="m1"
      onToggle={onToggle}
      {...over}
    />,
  );
  return { onToggle };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ReactionChip', () => {
  it('toggles your reaction when it is pressed', () => {
    const { onToggle } = renderChip();
    fireEvent.click(screen.getByRole('button', { name: /2/ }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('lists who reacted on a right-click, with a plain face and the name for each', async () => {
    mocks.list.mockResolvedValue({ data: [person('101', 'Brendan'), person('102', null, 'nick')] });
    const { onToggle } = renderChip();
    fireEvent.contextMenu(screen.getByRole('button', { name: /2/ }));
    const dialog = await screen.findByRole('dialog', { name: 'People who reacted with 🔥' });
    expect(await within(dialog).findByText('Brendan')).toBeInTheDocument();
    expect(within(dialog).getByText('nick')).toBeInTheDocument();
    expect(within(dialog).getByText('2 people')).toBeInTheDocument();
    // Faces are the timeline's own: initials on an identity color, no presence ring.
    const faces = dialog.querySelectorAll('.glass-tl-avatar');
    expect(faces).toHaveLength(2);
    expect(faces[0]).toHaveTextContent('B');
    expect(mocks.list).toHaveBeenCalledWith('c1', 'm1', '🔥', 100);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('says why the list could not load', async () => {
    mocks.list.mockRejectedValue(new Error('Nope'));
    renderChip();
    fireEvent.contextMenu(screen.getByRole('button', { name: /2/ }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('opens a short list after resting on it, and shows the rest a click away', async () => {
    const many = Array.from({ length: 14 }, (_, index) => person(String(200 + index), `Person ${index}`));
    mocks.list.mockResolvedValue({ data: many });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderChip({ count: 14 });
    fireEvent.pointerEnter(screen.getByRole('button', { name: /14/ }).parentElement as HTMLElement, { pointerType: 'mouse' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    const dialog = await screen.findByRole('dialog', { name: 'People who reacted with 🔥' });
    await waitFor(() => expect(within(dialog).getAllByRole('listitem')).toHaveLength(12));
    fireEvent.click(within(dialog).getByRole('button', { name: 'and 2 more' }));
    expect(within(dialog).getAllByRole('listitem')).toHaveLength(14);
  });

  it('does not toggle when a long press on touch only opened the list', async () => {
    mocks.list.mockResolvedValue({ data: [person('101', 'Brendan')] });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { onToggle } = renderChip();
    const button = screen.getByRole('button', { name: /2/ });
    fireEvent.pointerDown(button.parentElement as HTMLElement, { pointerType: 'touch' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(450);
    });
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
    // The next click is an ordinary one.
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
