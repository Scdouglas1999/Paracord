import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { GlassPage, PageBar, PageNote, PageScroll, PageSection } from './GlassPage';
import { PagePerson, PageRow, RowBadge, RowTime } from './PageRow';
import { badgeFor } from '../glass/places/model';

// Your face at the pane's right edge reads you and the download ticket; neither is the subject here.
vi.mock('../glass/conversation/HeaderAvatar', () => ({ HeaderAvatar: () => <button type="button">Your profile</button> }));
vi.mock('../../hooks/useDownloadTicket', () => ({ useDownloadTicket: () => null }));

describe('the page scaffold', () => {
  it('has one h1 with the line under it, and your face at the pane edge', () => {
    render(
      <GlassPage label="Friends">
        <PageBar title="Friends" line="5 of 6 online" actions={<button type="button">Add friend</button>} />
        <PageScroll>content</PageScroll>
      </GlassPage>,
    );
    expect(screen.getByRole('region', { name: 'Friends' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Friends' })).toBeInTheDocument();
    expect(screen.getByText('5 of 6 online')).toHaveClass('glass-page__sub');
    expect(screen.getByRole('button', { name: 'Add friend' }).closest('.glass-page__actions')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Your profile' }).closest('.glass-page__tools')).not.toBeNull();
  });

  it('can leave your face out', () => {
    render(<PageBar title="Overview" avatar={false} />);
    expect(screen.queryByRole('button', { name: 'Your profile' })).not.toBeInTheDocument();
  });

  it('names a section by its kicker and counts in the instrument cut', () => {
    render(
      <PageSection kicker="For you" count={3}>
        <li>row</li>
      </PageSection>,
    );
    const section = screen.getByRole('region', { name: 'For you' });
    expect(within(section).getByRole('heading', { level: 2, name: 'For you' })).toBeInTheDocument();
    expect(within(section).getByText('3')).toHaveClass('glass-instrument');
    expect(within(section).getByRole('list')).toBeInTheDocument();
  });

  it('draws amber only for what is live, and no count when there is none', () => {
    render(
      <PageSection kicker="Live now" tone="amber" count={null}>
        <li>row</li>
      </PageSection>,
    );
    const kicker = screen.getByRole('heading', { name: 'Live now' });
    expect(kicker).toHaveStyle({ color: 'var(--amber)' });
    expect(kicker.parentElement?.querySelector('.glass-sec__count')).toBeNull();
  });

  it('puts a footer after the rows and a note where there are none', () => {
    render(
      <PageSection kicker="Requests" list={false} footer={<button type="button">Show more</button>}>
        <PageNote role="status">Nothing waiting.</PageNote>
      </PageSection>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('Nothing waiting.');
    expect(screen.getByRole('button', { name: 'Show more' })).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });
});

describe('a page row', () => {
  const face = { userId: '1', name: 'Mara', avatar: null };

  it('opens from its body, and its decisions are siblings of the body, not children', async () => {
    const onOpen = vi.fn();
    const onAccept = vi.fn();
    render(
      <ul>
        <PageRow
          lead={<PagePerson face={face} />}
          title="Mara"
          line="wants to be friends"
          onOpen={onOpen}
          label="Open Mara"
          actions={<button type="button" onClick={onAccept}>Accept</button>}
        />
      </ul>,
    );
    const body = screen.getByRole('button', { name: 'Open Mara' });
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(body.contains(accept)).toBe(false);
    await userEvent.click(body);
    expect(onOpen).toHaveBeenCalledTimes(1);
    // The body hands over itself, for a card that anchors to it.
    expect(onOpen).toHaveBeenCalledWith(body);
    await userEvent.click(accept);
    expect(onAccept).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('is plain text with no wash when nothing opens it', () => {
    render(
      <ul>
        <PageRow lead={<PagePerson face={face} />} title="Mara" line="Away" />
      </ul>,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByRole('listitem')).not.toHaveAttribute('data-pressable');
  });

  it('is a real link when it has an address, and leaves a modified click to the browser', async () => {
    const onOpen = vi.fn();
    render(
      <ul>
        <PageRow lead={<PagePerson face={face} />} title="Mara" href="/app/dms/1" onOpen={onOpen} />
      </ul>,
    );
    const user = userEvent.setup();
    const link = screen.getByRole('link', { name: /Mara/ });
    expect(link).toHaveAttribute('href', '/app/dms/1');
    await user.click(link);
    expect(onOpen).toHaveBeenCalledTimes(1);
    await user.keyboard('{Control>}');
    await user.click(link);
    await user.keyboard('{/Control}');
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('lets a description point at the row’s own words', () => {
    render(
      <ul>
        <PageRow
          lead={<PagePerson face={face} />}
          title="Mara mentioned you"
          titleId="t"
          line="General · hello"
          lineId="l"
          describedBy="t l"
          label="Reply Mara"
          onOpen={() => {}}
        />
      </ul>,
    );
    expect(screen.getByRole('button', { name: 'Reply Mara' })).toHaveAccessibleDescription('Mara mentioned you General · hello');
  });

  it('marks its state as attributes: selected, quiet, offline', () => {
    render(
      <ul>
        <PageRow lead={<PagePerson face={face} />} title="a" selected quiet offline onOpen={() => {}} />
      </ul>,
    );
    const item = screen.getByRole('listitem');
    expect(item).toHaveAttribute('data-selected');
    expect(item).toHaveAttribute('data-quiet');
    expect(item).toHaveAttribute('data-offline');
  });

  it('draws presence as ink: a mark per state, amber only when live', () => {
    const { container, rerender } = render(<PagePerson face={face} status="online" />);
    expect(container.querySelector('.glass-presence')).toHaveAttribute('data-status', 'online');
    expect(container.querySelector('[data-live]')).toBeNull();
    rerender(<PagePerson face={face} status="dnd" />);
    expect(container.querySelector('.glass-presence')).toHaveAttribute('data-status', 'dnd');
    rerender(<PagePerson face={face} status="idle" live />);
    expect(container.querySelector('.glass-presence')).toHaveAttribute('data-live');
    rerender(<PagePerson face={face} />);
    expect(container.querySelector('.glass-presence')).toBeNull();
  });

  it('badges as the places panel does: white for a mention, gray for a count, a dot for unread', () => {
    const { container, rerender } = render(<RowBadge badge={badgeFor({ muted: false, mentions: 2, unread: true, unreadCount: null })} />);
    expect(container.querySelector('.glass-chip--mention')).toHaveTextContent('@2');
    expect(screen.getByText('2 mentions')).toHaveClass('sr-only');
    rerender(<RowBadge badge={badgeFor({ muted: false, mentions: 0, unread: true, unreadCount: 4 })} />);
    expect(container.querySelector('.glass-chip--count')).toHaveTextContent('4');
    rerender(<RowBadge badge={badgeFor({ muted: false, mentions: 0, unread: true, unreadCount: null })} />);
    expect(container.querySelector('.glass-place-dot')).not.toBeNull();
    rerender(<RowBadge badge={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('writes times in the instrument cut', () => {
    render(<RowTime dateTime="2026-10-01T21:00:00Z">9:00 PM</RowTime>);
    expect(screen.getByText('9:00 PM')).toHaveClass('glass-instrument');
  });
});
