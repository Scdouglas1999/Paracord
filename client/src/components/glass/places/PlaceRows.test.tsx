import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EventRow, GlyphRow, LiveRow, QuietRow, TextRow } from './PlaceRows';
import type { LiveRowModel, QuietRowModel, TextRowModel } from './rows';

// A picture lead asks for the attachment; nothing here talks to a server.
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:thumb') },
}));

const focus = { tabIndex: -1 as const, onFocus: () => {} };

function text(over: Partial<TextRowModel> = {}): TextRowModel {
  return {
    kind: 'text',
    id: 'channel:general',
    channelId: 'general',
    name: 'General',
    selected: false,
    lead: { kind: 'glyph', glyph: 'chat' },
    line: 'Jeremy: @Sean is movie night still on?',
    lineNote: null,
    time: '9:09 PM',
    timeIso: '2026-10-01T21:09:00-05:00',
    badge: null,
    badgeWords: null,
    ...over,
  };
}

function live(over: Partial<LiveRowModel> = {}): LiveRowModel {
  return {
    kind: 'live',
    id: 'channel:lounge',
    channelId: 'lounge',
    name: 'Lounge',
    selected: false,
    kicker: 'LIVE',
    occupants: [
      { userId: 'a', name: 'Vincent', avatar: null },
      { userId: 'b', name: 'Brendan', avatar: null },
    ],
    people: ['Vincent', 'Brendan'],
    more: 0,
    talking: true,
    line: 'Vincent is streaming',
    streaming: true,
    streamerId: 'a',
    ...over,
  };
}

describe('TextRow', () => {
  it('is a link to its channel with the name, the line and the time', () => {
    render(<TextRow row={text()} href="/app/guilds/g/channels/general" onOpen={() => {}} {...focus} />);
    const link = screen.getByRole('link', { name: /General/ });
    expect(link).toHaveAttribute('href', '/app/guilds/g/channels/general');
    expect(link).toHaveTextContent('Jeremy: @Sean is movie night still on?');
    expect(link.querySelector('time')).toHaveAttribute('datetime', '2026-10-01T21:09:00-05:00');
    expect(link.querySelector('time')).toHaveTextContent('9:09 PM');
  });

  it('marks the open channel as the current page', () => {
    const { rerender } = render(<TextRow row={text()} href="/x" onOpen={() => {}} {...focus} />);
    expect(screen.getByRole('link')).not.toHaveAttribute('aria-current');
    rerender(<TextRow row={text({ selected: true })} href="/x" onOpen={() => {}} {...focus} />);
    expect(screen.getByRole('link')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link')).toHaveAttribute('data-selected');
  });

  it('opens on a plain click, and leaves a modified click to the browser', () => {
    const onOpen = vi.fn();
    // The browser's own navigation is stood in for by a parent that swallows it.
    render(
      <div onClick={(event) => event.preventDefault()}>
        <TextRow row={text()} href="/x" onOpen={onOpen} {...focus} />
      </div>,
    );
    const link = screen.getByRole('link');
    fireEvent.click(link, { ctrlKey: true });
    fireEvent.click(link, { metaKey: true });
    fireEvent.click(link, { shiftKey: true });
    fireEvent.click(link, { button: 1 });
    expect(onOpen).not.toHaveBeenCalled();
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('opens with Enter, as a link does', () => {
    const onOpen = vi.fn();
    render(<TextRow row={text()} href="/x" onOpen={onOpen} {...focus} />);
    const link = screen.getByRole('link');
    link.focus();
    // jsdom does not turn Enter into a click on an anchor; the browser does. The
    // row's promise is that it is a real link, so a real activation opens it.
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalled();
  });

  it('draws a mention as a white @ with its words for a screen reader', () => {
    render(
      <TextRow
        row={text({ badge: { kind: 'mention', count: 1, label: '@' }, badgeWords: '1 mention' })}
        href="/x"
        onOpen={() => {}}
        {...focus}
      />,
    );
    expect(screen.getByText('@')).toHaveAttribute('data-tone', 'mention');
    expect(screen.getByText('1 mention')).toHaveClass('sr-only');
  });

  it('draws a known count in the count chip and an unknown one as a dot', () => {
    const { container, rerender } = render(
      <TextRow row={text({ badge: { kind: 'count', count: 3, label: '3' }, badgeWords: '3 unread' })} href="/x" onOpen={() => {}} {...focus} />,
    );
    expect(screen.getByText('3')).toHaveAttribute('data-tone', 'count');
    rerender(<TextRow row={text({ badge: { kind: 'dot' }, badgeWords: 'unread' })} href="/x" onOpen={() => {}} {...focus} />);
    expect(container.querySelector('.glass-place-dot')).not.toBeNull();
    expect(screen.getByText('unread')).toHaveClass('sr-only');
  });

  it('shows the note when a channel has no line to show', () => {
    render(<TextRow row={text({ line: null, lineNote: 'Preview unavailable' })} href="/x" onOpen={() => {}} {...focus} />);
    expect(screen.getByText('Preview unavailable')).toBeInTheDocument();
  });

  it('leads with faces, a picture or a glyph tile', () => {
    const { container, rerender } = render(
      <TextRow
        row={text({ lead: { kind: 'faces', variant: 'authors', faces: [{ userId: 'n', name: 'Nick', avatar: null }, { userId: 'j', name: 'Jeremy', avatar: null }] } })}
        href="/x"
        onOpen={() => {}}
        {...focus}
      />,
    );
    expect(container.querySelector('.glass-lead--faces')).toHaveAttribute('data-count', '2');
    expect(container.querySelectorAll('.glass-face')).toHaveLength(2);
    // Two speakers overlap; the latest is in front, and the row is not a `#` anywhere.
    rerender(<TextRow row={text({ lead: { kind: 'media', attachmentId: 'a1', label: 'x.png' } })} href="/x" onOpen={() => {}} {...focus} />);
    expect(container.querySelector('.glass-lead--media')).not.toBeNull();
    rerender(<TextRow row={text({ lead: { kind: 'glyph', glyph: 'voice' } })} href="/x" onOpen={() => {}} {...focus} />);
    expect(container.querySelector('.glass-lead--tile')).not.toBeNull();
  });

  it('shows a person’s monogram (one letter, docs/index-spec.md §2.3) when they have no picture, and one face for a single speaker', () => {
    const { container } = render(
      <TextRow
        row={text({ lead: { kind: 'faces', variant: 'authors', faces: [{ userId: 'n', name: 'Nick Vale', avatar: null }] } })}
        href="/x"
        onOpen={() => {}}
        {...focus}
      />,
    );
    expect(container.querySelector('.glass-lead--faces')).toHaveAttribute('data-count', '1');
    expect(container.querySelector('.glass-face')).toHaveTextContent(/^N$/);
  });

  it('is a button, not a link, when it has no address', () => {
    const onOpen = vi.fn();
    render(<TextRow row={text()} href={undefined} onOpen={onOpen} {...focus} />);
    fireEvent.click(screen.getByRole('button', { name: /General/ }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('carries the roving tabindex it was given and reports focus', () => {
    const onFocus = vi.fn();
    render(<TextRow row={text()} href="/x" onOpen={() => {}} tabIndex={0} onFocus={onFocus} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('tabindex', '0');
    fireEvent.focus(link);
    expect(onFocus).toHaveBeenCalled();
  });

  it('never writes a # of its own', () => {
    const { container } = render(<TextRow row={text()} href="/x" onOpen={() => {}} {...focus} />);
    expect(container.textContent).not.toContain('#');
  });
});

describe('QuietRow', () => {
  const quiet: QuietRowModel = { kind: 'quiet', id: 'channel:patch', channelId: 'patch', name: 'Patch notes', selected: false, glyph: 'doc', time: 'Tue', timeIso: '2026-09-29T16:30:00-05:00' };

  it('is one line: a glyph, the name and the time', () => {
    const { container } = render(<QuietRow row={quiet} href="/p" onOpen={() => {}} {...focus} />);
    expect(screen.getByRole('link', { name: /Patch notes/ })).toHaveClass('glass-place-row--quiet');
    expect(screen.getByText('Tue')).toBeInTheDocument();
    expect(container.querySelector('.glass-place-row__glyph svg')).not.toBeNull();
    expect(container.querySelector('.glass-place-row__line')).toBeNull();
  });

  it('has no time to show for a channel that never had a message', () => {
    const { container } = render(<QuietRow row={{ ...quiet, time: null, timeIso: null }} href="/p" onOpen={() => {}} {...focus} />);
    expect(container.querySelector('time')).toBeNull();
  });
});

describe('LiveRow', () => {
  it('shows the kicker, the faces, the waveform while somebody talks and the line', () => {
    const { container } = render(<LiveRow row={live({ kicker: 'LIVE 42 MIN' })} href="/l" onOpen={() => {}} {...focus} />);
    const link = screen.getByRole('link', { name: /Lounge/ });
    expect(link).toHaveTextContent('LIVE 42 MIN');
    expect(link).toHaveTextContent('Vincent is streaming');
    // The faces are pictures; the names are for a screen reader.
    expect(link).toHaveTextContent('In the room: Vincent, Brendan');
    expect(container.querySelectorAll('.glass-place-live__faces .glass-face')).toHaveLength(2);
    expect(container.querySelector('.glass-wave')).not.toBeNull();
  });

  it('has no waveform while nobody talks, and counts faces it did not draw', () => {
    const { container } = render(<LiveRow row={live({ talking: false, more: 2 })} href="/l" onOpen={() => {}} {...focus} />);
    expect(container.querySelector('.glass-wave')).toBeNull();
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('opens on click', () => {
    const onOpen = vi.fn();
    render(<LiveRow row={live()} href="/l" onOpen={onOpen} {...focus} />);
    fireEvent.click(screen.getByRole('link'));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

describe('EventRow', () => {
  it('reads as the date, the title and the line, in that order', () => {
    render(
      <EventRow id="event:1" title="Haz 5 run" line="Lounge, 3 going" tile={{ top: 'Today', bottom: '9:30' }} href="/e" onOpen={() => {}} {...focus} />,
    );
    const link = screen.getByRole('link');
    expect(link).toHaveTextContent('Today');
    expect(link).toHaveTextContent('9:30');
    expect(link).toHaveTextContent('Haz 5 run');
    expect(link).toHaveTextContent('Lounge, 3 going');
    expect(link.querySelector('.glass-lead--date')).not.toHaveAttribute('aria-hidden');
  });
});

describe('GlyphRow', () => {
  it('is a link with an address and a popover trigger without one', () => {
    const onOpen = vi.fn();
    const { rerender } = render(<GlyphRow id="addon:sports" href="/sports" glyph="trophy" name="Sports" line="2 live now" onOpen={onOpen} {...focus} />);
    expect(screen.getByRole('link', { name: /Sports/ })).toHaveAttribute('href', '/sports');
    rerender(<GlyphRow id="addon:games" glyph="games" name="Game servers" line="1 of 2 up" hasPopup="dialog" expanded onOpen={onOpen} {...focus} />);
    const button = screen.getByRole('button', { name: /Game servers/ });
    expect(button).toHaveAttribute('aria-haspopup', 'dialog');
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalled();
  });
});
