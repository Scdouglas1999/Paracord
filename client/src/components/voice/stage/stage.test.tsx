import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import {
  RoomChatRibbon,
  SpeakerGrid,
  StageControlBar,
  StageHeader,
  StageLayout,
  StageNotice,
  StageStatus,
  StageTile,
  callTransport,
  speakerColumns,
  stageStatusDetail,
  stageStatusMessage,
  transportReadout,
} from './index';
import { personLight } from '../../../lib/attention/light';

const MARA = personLight({
  userId: '101',
  name: 'Mara Okafor',
  status: 'online',
  speaking: true,
  inRoom: true,
  roomName: 'Shop floor',
});
const REN = personLight({ userId: '103', name: 'Ren Ito', status: 'online', inRoom: true, roomName: 'Shop floor' });

describe('StageTile', () => {
  it('names the person on the tag and says the camera is off in the DOM', () => {
    render(<StageTile person={REN} name="Ren Ito" />);
    expect(screen.getByText('Ren Ito')).toBeInTheDocument();
    expect(screen.getByText('Ren Ito’s camera is off')).toBeInTheDocument();
  });

  it('breathes the speaking ring and says "speaking" as words', () => {
    const { container } = render(<StageTile person={MARA} name="Mara" speaking />);
    expect(container.querySelector('.pc-speaking')).not.toBeNull();
    expect(screen.getByText('· speaking')).toBeInTheDocument();
  });

  it('marks a muted tile with the word, not only the glyph', () => {
    render(<StageTile person={REN} name="Ren" muted />);
    expect(screen.getByText('· muted')).toBeInTheDocument();
  });

  it('shows the readout and the badge, and never both a ring and a still frame', () => {
    const { container } = render(
      <StageTile name="Mara" readout="12 ms · QUIC" badge="CAM · 720p" live>
        <canvas />
      </StageTile>,
    );
    expect(screen.getByText('12 ms · QUIC')).toBeInTheDocument();
    expect(screen.getByText('CAM · 720p')).toBeInTheDocument();
    // A live tile paints frames, so it never draws the camera-off avatar.
    expect(container.querySelector('.pc-lit')).toBeNull();
    expect(screen.queryByText(/camera is off/)).toBeNull();
  });

  it('falls back to initials when there is no person model', () => {
    render(<StageTile name="Priya Raman" />);
    expect(screen.getByText('PR')).toBeInTheDocument();
  });
});

describe('SpeakerGrid', () => {
  it('follows the VideoGrid column rules for the speakers-only Stage', () => {
    expect(speakerColumns(1, false)).toBe(1);
    expect(speakerColumns(2, false)).toBe(2);
    expect(speakerColumns(4, false)).toBe(2);
    expect(speakerColumns(5, false)).toBe(3);
    // A phone is always two columns — the 2×2 of §7.2.
    expect(speakerColumns(1, true)).toBe(1);
    expect(speakerColumns(5, true)).toBe(2);
  });

  it('divides the strip equally between everybody', () => {
    const { container } = render(
      <SpeakerGrid arrangement="strip" count={4}>
        <li>a</li>
      </SpeakerGrid>,
    );
    const grid = container.querySelector('ul') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(4, minmax(0, 1fr))');
  });

  it('caps the phone strip at two columns', () => {
    const { container } = render(<SpeakerGrid arrangement="strip" compact count={4}><li>a</li></SpeakerGrid>);
    const grid = container.querySelector('ul') as HTMLElement;
    expect(grid.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
  });
});

describe('StageControlBar', () => {
  it('is a labelled group of centred controls', () => {
    render(<StageControlBar><button type="button">Mute</button></StageControlBar>);
    const group = screen.getByRole('group', { name: 'Call controls' });
    expect(group).toBeInTheDocument();
    expect(group.className).toContain('justify-center');
  });
});

describe('StageHeader', () => {
  it('renders the room, its server and the duration in the mono face', () => {
    const { container } = render(
      <StageHeader
        roomName="Shop floor"
        buildingName="Kestrel"
        durationMs={34 * 60_000 + 12_000}
        hereNow={<span>4 here · 20 lights on</span>}
        actions={<button type="button">Invite</button>}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Shop floor' })).toBeInTheDocument();
    expect(screen.getByText('Kestrel ·', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('34:12')).toBeInTheDocument();
    expect(container.querySelector('.pc-mono')).not.toBeNull();
    expect(screen.getByText('4 here · 20 lights on')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite' })).toBeInTheDocument();
  });

  it('stacks the meta and takes a back affordance on a phone', () => {
    render(
      <StageHeader compact roomName="Shop floor" durationMs={null} leading={<button type="button">Back</button>} />,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('0:00')).toBeInTheDocument();
  });
});

describe('the words for a call that is not a room yet', () => {
  it('names the room, and counts a reconnect in seconds', () => {
    expect(stageStatusMessage('joining', 'Shop floor')).toBe('Joining Shop floor');
    expect(stageStatusMessage('reconnecting', 'Shop floor', 3_400)).toBe(
      'Reconnecting to Shop floor · 3 s',
    );
    expect(stageStatusMessage('closing', 'Shop floor')).toBe('Leaving Shop floor');
    expect(stageStatusMessage('failed', 'Shop floor')).toBe("Couldn't reach Shop floor");
  });

  it('never says "warming up", "connecting…" or any other filler', () => {
    const everything = (['joining', 'reconnecting', 'closing', 'failed'] as const)
      .flatMap((phase) => [stageStatusMessage(phase, 'Shop floor', 0), stageStatusDetail(phase, 'Shop floor')])
      .join(' ')
      .toLowerCase();
    for (const banned of ['warming up', 'connecting…', 'please wait', 'loading', 'no data']) {
      expect(everything).not.toContain(banned);
    }
  });

  it('renders the failed state with its reason and an action', () => {
    render(
      <StageStatus
        phase="failed"
        roomName="Shop floor"
        reason="The media server refused the ticket."
        actions={<button type="button">Try joining again</button>}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent("Couldn't reach Shop floor");
    expect(screen.getByText('The media server refused the ticket.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try joining again' })).toBeInTheDocument();
  });

  it('has a one-line form for a call already on the Stage', () => {
    render(<StageNotice phase="reconnecting" roomName="Shop floor" elapsedMs={12_000} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reconnecting to Shop floor · 12 s');
  });
});

describe('transport readout', () => {
  it('says which transport the call is actually on', () => {
    expect(callTransport({ hasMediaEngine: true, hasRoom: false })).toBe('quic');
    expect(callTransport({ hasMediaEngine: false, hasRoom: true })).toBe('webrtc');
    expect(callTransport({ hasMediaEngine: false, hasRoom: false })).toBeNull();
  });

  it('never invents a latency, and draws nothing when it knows nothing', () => {
    expect(transportReadout({ transport: 'quic' })).toBe('QUIC');
    expect(transportReadout({ transport: null })).toBeNull();
    expect(transportReadout({ transport: 'webrtc', quality: 'unstable' })).toBe('WebRTC · unstable');
    expect(transportReadout({ transport: 'webrtc', quality: 'stable' })).toBe('WebRTC');
    expect(transportReadout({ transport: 'quic', latencyMs: 12.4 })).toBe('12 ms · QUIC');
  });
});

describe('RoomChatRibbon', () => {
  it('is a 336px plate carrying the room name, the timeline and the composer', () => {
    const { container } = render(
      <RoomChatRibbon roomName="build-log" lit composer={<div>composer</div>}>
        <div>timeline</div>
      </RoomChatRibbon>,
    );
    const ribbon = screen.getByRole('complementary', { name: 'build-log — call chat' });
    expect(ribbon.className).toContain('w-[var(--w-chat-ribbon)]');
    expect(screen.getByText('build-log')).toBeInTheDocument();
    expect(screen.getByText('call chat')).toBeInTheDocument();
    expect(screen.getByText('timeline')).toBeInTheDocument();
    expect(screen.getByText('composer')).toBeInTheDocument();
    // Somebody is reading it, so the window dot is amber.
    expect(container.querySelector('.pc-window.is-reading')).not.toBeNull();
  });

  it('draws a dark window dot when nobody is reading', () => {
    const { container } = render(<RoomChatRibbon roomName="build-log"><div /></RoomChatRibbon>);
    expect(container.querySelector('.pc-window.is-reading')).toBeNull();
  });

  it('collapses to its handle as a phone sheet', async () => {
    const onToggle = vi.fn();
    const { rerender } = render(
      <RoomChatRibbon roomName="build-log" surface="sheet" expanded onToggle={onToggle} composer={<div>composer</div>}>
        <div>timeline</div>
      </RoomChatRibbon>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Hide the build-log chat' }));
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <RoomChatRibbon roomName="build-log" surface="sheet" expanded={false} onToggle={onToggle} composer={<div>composer</div>}>
        <div>timeline</div>
      </RoomChatRibbon>,
    );
    expect(screen.getByRole('button', { name: 'Show the build-log chat' })).toBeInTheDocument();
    expect(screen.queryByText('timeline')).toBeNull();
    expect(screen.queryByText('composer')).toBeNull();
  });
});

describe('StageLayout', () => {
  it('gives the speaker strip its own row only when a dominant tile is there', () => {
    const { container, rerender } = render(
      <StageLayout header={<div>header</div>} dominant={<div>share</div>} speakers={<div>strip</div>} controls={<div>controls</div>} />,
    );
    const grid = container.querySelector('div.grid') as HTMLElement;
    expect(grid.style.gridTemplateRows).toBe('minmax(0, 1fr) 128px');

    rerender(<StageLayout header={<div>header</div>} speakers={<div>strip</div>} controls={<div>controls</div>} />);
    const soloGrid = container.querySelector('div.grid') as HTMLElement;
    expect(soloGrid.style.gridTemplateRows).toBe('minmax(0, 1fr)');
    expect(screen.getByText('strip')).toBeInTheDocument();
  });

  it('puts the share on top and the chat sheet under the controls on a phone', () => {
    render(
      <StageLayout
        phone
        header={<div>header</div>}
        dominant={<div>share</div>}
        speakers={<div>speakers</div>}
        controls={<div>controls</div>}
        ribbon={<div>sheet</div>}
      />,
    );
    const order = ['header', 'share', 'speakers', 'controls', 'sheet'].map((label) =>
      screen.getByText(label),
    );
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i])).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    }
  });

  it('drops the control bar while you are not in the room yet', () => {
    render(<StageLayout header={<div>header</div>} dominant={<div>joining</div>} />);
    expect(screen.queryByRole('group', { name: 'Call controls' })).toBeNull();
  });
});

describe('no Stage component hard-codes a colour', () => {
  it('renders every piece without a literal hex or rgb value', () => {
    const { container } = render(
      <StageLayout
        header={<StageHeader roomName="Shop floor" buildingName="Kestrel" durationMs={1_000} />}
        dominant={<StageTile person={MARA} name="Mara" speaking readout="QUIC" />}
        speakers={
          <SpeakerGrid arrangement="strip" count={2}>
            <li><StageTile person={REN} name="Ren" muted /></li>
            <li><StageTile name="Priya" /></li>
          </SpeakerGrid>
        }
        notice={<StageNotice phase="reconnecting" roomName="Shop floor" elapsedMs={1_000} />}
        controls={<StageControlBar><button type="button">Mute</button></StageControlBar>}
        ribbon={
          <RoomChatRibbon roomName="build-log" lit composer={<div />}>
            <div />
          </RoomChatRibbon>
        }
      />,
    );
    const markup = container.innerHTML;
    expect(markup).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(markup).not.toMatch(/\brgba?\(\s*\d/);
  });
});
