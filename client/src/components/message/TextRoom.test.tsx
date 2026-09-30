import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DayDivider, MessageActions, ReplyChip, RoomLitEventRow, ThreadRow, TimelineAvatar, dayDividerLabel, isToday, timelineTime, typingSentence } from './TimelineParts';
import { composerPlaceholder } from './MessageInput';
import { personLight } from '../../lib/attention/light';

/**
 * The text room's small shapes (docs/glass-spec.md §3.2).
 *
 * Three things, each checked against the words the spec puts on the surface
 * rather than against a class name:
 *
 *   1. a message's face and its hover actions (docs/glass-spec.md §3.2);
 *   2. a room that lights up while you are reading appears in the timeline as
 *      an event, and disappears again when it empties;
 *   3. the composer says where the message goes: "Message #general"
 *      (docs/server-home-spec.md, "Plain words").
 *
 * The header a room wears is the Glass conversation header, and what it offers
 * is held in `components/glass/conversation/ConversationPane.test.tsx`.
 */

/* ---------------------------------------------------------------------------
 * 1. A message's face and actions (docs/glass-spec.md §3.2)
 * ------------------------------------------------------------------------- */

describe('a message author in the Glass timeline', () => {
  it('draws a plain 32px face with the author\'s initials when there is no photo', () => {
    const { container } = render(<TimelineAvatar userId="u1" name="Mara Okonkwo" />);
    const face = container.querySelector('.glass-tl-avatar') as HTMLElement;
    expect(face).toHaveTextContent('MO');
    expect(face.style.width).toBe('32px');
    // The reference draws no presence ring on a timeline face.
    expect(face.className).not.toMatch(/pc-lit|pc-speaking|pc-dim/);
  });

  it('offers react, reply and more as named buttons, and says when more is open', () => {
    const onReact = vi.fn();
    const onReply = vi.fn();
    const onMore = vi.fn();
    render(<MessageActions authorName="Brendan" onReact={onReact} onReply={onReply} onMore={onMore} moreExpanded />);
    screen.getByRole('button', { name: 'React to Brendan' }).click();
    screen.getByRole('button', { name: 'Reply to Brendan' }).click();
    const more = screen.getByRole('button', { name: 'More actions' });
    more.click();
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(onReact).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onMore).toHaveBeenCalledTimes(1);
  });

  it('leaves out the actions the reader may not take', () => {
    render(<MessageActions authorName="Brendan" onMore={vi.fn()} moreExpanded={false} />);
    expect(screen.queryByRole('button', { name: /React to/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Reply to/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'More actions' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('says who is typing in words', () => {
    expect(typingSentence(['Eric'])).toBe('Eric is typing');
    expect(typingSentence(['Eric', 'Nick'])).toBe('Eric and Nick are typing');
    expect(typingSentence(['Eric', 'Nick', 'Luke'])).toBe('Eric, Nick, and Luke are typing');
    expect(typingSentence(['a', 'b', 'c', 'd'])).toBe('4 people are typing');
    expect(typingSentence([])).toBe('');
  });

  it('writes the time in the locale\'s own form', () => {
    const iso = '2026-10-01T21:02:00';
    const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
    expect(timelineTime(iso)).toBe(expected);
    expect(timelineTime('not a date')).toBe('not a date');
  });
});

/* ---------------------------------------------------------------------------
 * 2. A room lighting up, in the timeline
 * ------------------------------------------------------------------------- */

describe('a room lighting up, in the timeline (§7.4)', () => {
  it('draws the event as a lit window, a sentence and one action', () => {
    const onJoin = vi.fn();
    render(
      <RoomLitEventRow
        event={{
          key: 'k',
          channelId: 'voice-1',
          guildId: 'guild-1',
          roomName: 'Shop floor',
          headline: 'Shop floor lit up',
          detail: 'Mara, Priya and Ren are in there now',
          atMs: 0,
        }}
        onJoin={onJoin}
      />,
    );
    const event = screen.getByTestId('room-lit-event');
    expect(event).toHaveTextContent('Shop floor lit up · Mara, Priya and Ren are in there now');
    screen.getByRole('button', { name: 'Join' }).click();
    expect(onJoin).toHaveBeenCalledTimes(1);
  });
});

/* ---------------------------------------------------------------------------
 * 3. The composer's copy, and the rest of the timeline's small shapes
 * ------------------------------------------------------------------------- */

describe('the composer says where the message goes (plain words)', () => {
  it('names the channel, the group or the person', () => {
    expect(composerPlaceholder('general')).toBe('Message general');
    expect(composerPlaceholder('Ade, Jonas', 'group')).toBe('Message Ade, Jonas');
    expect(composerPlaceholder('Mara', 'person')).toBe('Message Mara');
  });

  it('has a phone form that drops a name too long to fit', () => {
    expect(composerPlaceholder('build-log', 'channel', true)).toBe('Message build-log');
    // A channel name can be any length, so past what fits the name is dropped.
    expect(composerPlaceholder('a-very-long-channel-name-indeed', 'channel', true)).toBe('Write a message');
    for (const name of ['general', 'build-log', 'a-very-long-channel-name-indeed']) {
      expect(composerPlaceholder(name, 'channel', true).length).toBeLessThanOrEqual(26);
    }
  });

  it('asks for a message when it has no name to give', () => {
    expect(composerPlaceholder()).toBe('Write a message');
    expect(composerPlaceholder(null, 'person')).toBe('Write a message');
  });

  it('never counts who is reading', () => {
    for (const copy of [composerPlaceholder('build-log'), composerPlaceholder('Mara', 'person'), composerPlaceholder()]) {
      expect(copy).not.toMatch(/reading|people|person/);
    }
  });
});

describe('the timeline’s small shapes (§7.4)', () => {
  it('labels a day divider with a word where there is one', () => {
    const now = new Date('2026-05-17T12:00:00.000Z').getTime();
    expect(dayDividerLabel('2026-05-17T09:00:00.000Z', now)).toBe('Today');
    expect(dayDividerLabel('2026-05-16T09:00:00.000Z', now)).toBe('Yesterday');
    expect(dayDividerLabel('2026-01-02T09:00:00.000Z', now)).toMatch(/January/);
  });

  it('knows today from any other day', () => {
    const now = new Date('2026-05-17T12:00:00').getTime();
    expect(isToday('2026-05-17T00:30:00', now)).toBe(true);
    expect(isToday('2026-05-16T23:30:00', now)).toBe(false);
    expect(isToday('garbage', now)).toBe(false);
  });

  it('renders the day as a centered kicker that names itself', () => {
    render(<DayDivider label="Today" />);
    expect(screen.getByText('Today')).toBeVisible();
    expect(screen.getByRole('separator', { name: 'Today' })).toBeInTheDocument();
  });

  it('names who is being answered on a reply chip', () => {
    const onJump = vi.fn();
    render(<ReplyChip author="Mara" preview="Driver board v3 came back…" onJump={onJump} />);
    screen.getByRole('button', { name: /Mara/ }).click();
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('puts a thread’s faces, name and reply count on one row', () => {
    const { container } = render(
      <ThreadRow
        name="Firmware flash sequence"
        meta="4 replies · 12 min ago"
        people={[personLight({ userId: 'u1', name: 'Tomas', status: 'online' })]}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.getByText('Firmware flash sequence')).toBeVisible();
    expect(screen.getByText('4 replies · 12 min ago')).toBeVisible();
    expect(screen.getByText('Open thread')).toBeVisible();
    // The face is drawn, not read; one sentence says who is in the thread.
    expect(container.querySelector('.glass-face')).toHaveTextContent('T');
    expect(screen.getByText('Tomas in Firmware flash sequence')).toBeInTheDocument();
  });
});
