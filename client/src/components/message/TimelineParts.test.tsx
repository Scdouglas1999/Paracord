import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  EncryptedBubbleText,
  HistorySkeleton,
  JumpToLatest,
  MessageActions,
  NewDivider,
  ReplyLine,
  SystemLine,
  ThreadLine,
  TimeDivider,
  TimelineAvatar,
  TypingRow,
  timelineTime,
  typingSentence,
} from './TimelineParts';

/**
 * The Index timeline's small shapes (docs/index-spec.md §3.1, §4.11), checked
 * against the words the spec puts on the surface.
 */

describe('a message author', () => {
  it('draws the Index avatar: one letter on the person’s hue, 30px in a group', () => {
    const { container } = render(<TimelineAvatar userId="101" name="Mara Okonkwo" />);
    const face = container.querySelector('.ix-av') as HTMLElement;
    expect(face).toHaveTextContent(/^M$/);
    expect(face.style.width).toBe('30px');
  });

  it('writes the time in the locale’s own form', () => {
    const iso = '2026-10-01T21:02:00';
    const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    expect(timelineTime(iso)).toBe(expected);
    expect(timelineTime('not a date')).toBe('not a date');
  });
});

describe('the action capsule (§4.11)', () => {
  it('offers react, reply, thread and more as named buttons, and says when more is open', () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    const onThread = vi.fn();
    const onMore = vi.fn();
    render(
      <MessageActions authorName="Brendan" onReact={onReact} onReply={onReply} onThread={onThread} onMore={onMore} moreExpanded />,
    );
    const capsule = screen.getByRole('toolbar', { name: 'Actions for Brendan’s message' });
    expect(capsule).toHaveClass('ix-capsule');
    screen.getByRole('button', { name: 'React to Brendan' }).click();
    screen.getByRole('button', { name: 'Reply to Brendan' }).click();
    screen.getByRole('button', { name: 'Start a thread' }).click();
    const more = screen.getByRole('button', { name: 'More actions' });
    more.click();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(more).toHaveAttribute('aria-haspopup', 'menu');
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onThread).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('leaves out the actions the reader may not take', () => {
    render(<MessageActions authorName="Brendan" onMore={vi.fn()} moreExpanded={false} />);
    expect(screen.queryByRole('button', { name: /React to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /thread/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'false');
  });
});

describe('lines that are not bubbles', () => {
  it('a time divider says the day in bold and the clock: "Today 9:41 PM"', () => {
    const now = new Date(2026, 9, 1, 22, 0).getTime();
    render(<TimeDivider at={new Date(2026, 9, 1, 21, 41).toISOString()} nowMs={now} />);
    const divider = screen.getByRole('separator');
    expect(divider).toHaveAccessibleName(/^Today 9:41\s?PM$/);
    expect(divider.querySelector('b')).toHaveTextContent('Today');
  });

  it('the New divider says "New" and offers Mark read', () => {
    const onMarkRead = vi.fn();
    render(<NewDivider onMarkRead={onMarkRead} />);
    expect(screen.getByRole('group', { name: 'New messages' })).toHaveTextContent('New');
    fireEvent.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(onMarkRead).toHaveBeenCalledTimes(1);
  });

  it('a system line is a sentence with a glyph, amber only for voice (by its kind)', () => {
    render(<SystemLine glyph="voice" text="You joined General" />);
    const line = screen.getByText('You joined General').parentElement as HTMLElement;
    expect(line).toHaveClass('ix-tl-system');
    expect(line).toHaveAttribute('data-glyph', 'voice');
    expect(line.querySelector('svg')).not.toBeNull();
  });

  it('the reply line names who is answered and what they said, and jumps there', () => {
    const onJump = vi.fn();
    render(<ReplyLine author="Jeremy" preview="who’s up for a run tonight?" onJump={onJump} />);
    const line = screen.getByRole('button', { name: /^Reply to Jeremy: who’s up for a run tonight\?/ });
    expect(line).toHaveTextContent('Jeremy: who’s up for a run tonight?');
    expect(line).toHaveClass('glass-tl-reply');
    line.click();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('the thread line reads "3 replies · 9:41 PM" and opens the thread', () => {
    const onOpen = vi.fn();
    render(<ThreadLine name="haz runs" replies={3} time="9:41 PM" onOpen={onOpen} />);
    const line = screen.getByRole('button', { name: 'haz runs: 3 replies · 9:41 PM. Open thread' });
    expect(line).toHaveTextContent('3 replies · 9:41 PM');
    line.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    render(<ThreadLine name="one" replies={1} time={null} archived onOpen={vi.fn()} />);
    expect(screen.getByText('1 reply · archived')).toBeInTheDocument();
  });

  it('history still loading is three static skeleton bubbles', () => {
    const { container } = render(<HistorySkeleton />);
    expect(screen.getByRole('status', { name: 'Loading older messages' })).toBeInTheDocument();
    expect(container.querySelectorAll('.ix-tl-skeleton__bubble')).toHaveLength(3);
  });

  it('a sealed message reads "Encrypted message" with the lock', () => {
    const { container } = render(<EncryptedBubbleText />);
    expect(screen.getByText('Encrypted message')).toBeInTheDocument();
    expect(container.querySelector('[data-glyph="lock"], svg')).not.toBeNull();
  });
});

describe('typing (§4.11)', () => {
  it('says who is typing in words', () => {
    expect(typingSentence(['Eric'])).toBe('Eric is typing');
    expect(typingSentence(['Eric', 'Nick'])).toBe('Eric and Nick are typing');
    expect(typingSentence(['Eric', 'Nick', 'Luke'])).toBe('Eric, Nick, and Luke are typing');
    expect(typingSentence(['a', 'b', 'c', 'd'])).toBe('4 people are typing');
    expect(typingSentence([])).toBe('');
  });

  it('one typist: the dots beside their face; two: faces overlapped and both names', () => {
    const { container, rerender } = render(<TypingRow typists={[{ id: '102', name: 'Nick', avatar: null }]} />);
    expect(container.querySelectorAll('.ix-av')).toHaveLength(1);
    expect(container.querySelector('.ix-typing__bubble')?.children).toHaveLength(3);
    expect(container.querySelector('.ix-typing__words')).toBeNull();
    rerender(
      <TypingRow
        typists={[
          { id: '102', name: 'Nick', avatar: null },
          { id: '350', name: 'Maya', avatar: null },
        ]}
      />,
    );
    expect(container.querySelectorAll('.ix-faces .ix-av')).toHaveLength(2);
    expect(container.querySelector('.ix-typing__words')).toHaveTextContent('Nick and Maya are typing');
  });
});

describe('jump to latest (§4.11)', () => {
  it('reads "↓ 12 new", or "↓ Latest" with nothing new', () => {
    const onJump = vi.fn();
    const { rerender } = render(<JumpToLatest count={12} onJump={onJump} />);
    const capsule = screen.getByRole('button', { name: 'Jump to the 12 new messages' });
    expect(capsule).toHaveTextContent('12 new');
    capsule.click();
    expect(onJump).toHaveBeenCalledTimes(1);
    rerender(<JumpToLatest count={0} onJump={onJump} />);
    expect(screen.getByRole('button', { name: 'Jump to the latest message' })).toHaveTextContent('Latest');
  });
});
