import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ReactionBite, reactionLabel, type ReactionTally } from './ReactionBite';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
}));

vi.mock('../../../api/reminders', () => ({
  reactionUsersApi: { list: mocks.list },
}));
vi.mock('../../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

const flame: ReactionTally = { emoji: '\u{1F525}', count: 5, me: false };
const heart: ReactionTally = { emoji: '\u{1F90D}', count: 3, me: false };
const thumbs: ReactionTally = { emoji: '\u{1F44D}', count: 2, me: true };

function renderBite(reactions: ReactionTally[], over: Partial<Parameters<typeof ReactionBite>[0]> = {}) {
  const onToggle = vi.fn();
  render(
    <ReactionBite reactions={reactions} guildId="g1" channelId="c1" messageId="m1" onToggle={onToggle} {...over} />,
  );
  return { onToggle };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ReactionBite', () => {
  it('is one chip with an icon and a count for each reaction', () => {
    renderBite([flame, heart, thumbs]);
    const chip = screen.getByRole('group', { name: 'Reactions' });
    expect(within(chip).getAllByRole('button')).toHaveLength(3);
    expect(chip).toHaveAttribute('data-placement', 'media');
  });

  it('draws the flame and the heart as Paracord’s line marks and every other reaction as itself', () => {
    renderBite([flame, heart, thumbs]);
    const [flameButton, heartButton, thumbsButton] = screen.getAllByRole('button');
    expect(flameButton.querySelector('[data-glyph="flame"]')).not.toBeNull();
    expect(heartButton.querySelector('svg')).not.toBeNull();
    expect(heartButton).not.toHaveTextContent('\u{1F90D}');
    expect(thumbsButton).toHaveTextContent('\u{1F44D}');
  });

  it('marks the reactions that are yours, in words and in state', () => {
    renderBite([flame, thumbs]);
    const [flameButton, thumbsButton] = screen.getAllByRole('button');
    expect(flameButton).toHaveAttribute('aria-pressed', 'false');
    expect(thumbsButton).toHaveAttribute('aria-pressed', 'true');
    expect(thumbsButton).toHaveAttribute('aria-label', reactionLabel(thumbs));
    expect(reactionLabel(thumbs)).toBe('\u{1F44D}, 2 reactions, including yours');
    expect(reactionLabel({ ...flame, count: 1 })).toBe('\u{1F525}, 1 reaction');
  });

  it('toggles the reaction that was pressed', () => {
    const { onToggle } = renderBite([flame, thumbs]);
    fireEvent.click(screen.getByRole('button', { name: /2 reactions, including yours/ }));
    expect(onToggle).toHaveBeenCalledWith('m1', thumbs);
  });

  it('is the same chip in the flow for a message with nothing to bite', () => {
    renderBite([thumbs], { placement: 'inline' });
    expect(screen.getByRole('group', { name: 'Reactions' })).toHaveAttribute('data-placement', 'inline');
  });

  it('says who reacted on a right-click, and still toggles on a click', async () => {
    mocks.list.mockResolvedValue({
      data: [
        { id: '101', username: 'brendan', display_name: 'Brendan', avatar_hash: null },
        { id: '102', username: 'nick', display_name: null, avatar_hash: null },
      ],
    });
    const { onToggle } = renderBite([flame]);
    fireEvent.contextMenu(screen.getByRole('button', { name: /5 reactions/ }));
    expect(await screen.findByText('Brendan')).toBeInTheDocument();
    expect(screen.getByText('nick')).toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledWith('c1', 'm1', flame.emoji, 100);
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('shows the failure when the list cannot be read', async () => {
    mocks.list.mockRejectedValue(new Error('offline'));
    renderBite([thumbs]);
    fireEvent.contextMenu(screen.getByRole('button', { name: /2 reactions/ }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
  });
});
