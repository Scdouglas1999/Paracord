import { act, fireEvent, render, screen } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { GlassFrame } from './GlassFrame';
import type { GlassLayout } from './useGlassLayout';
import { usePhoneNavStore } from './phoneNav';

/**
 * One frame for every layout (glass-polish-2 item 5). A window resized across the
 * phone breakpoint used to swap two components, which rebuilt the conversation
 * under them and closed every dialog held in its local state. The conversation,
 * the stage and the sheets are now the same elements in every layout, so they are
 * mounted once and keep their DOM nodes, their state and their scroll position.
 */

vi.mock('../room', () => ({ RoomBackdrop: () => <div className="glass-room-backdrop" /> }));
vi.mock('../pill', () => ({
  CallPill: () => <div data-testid="call-pill" />,
}));
vi.mock('../places', () => ({
  PlacesPanel: ({ presentation }: { presentation: string }) => (
    <nav aria-label="Channels" data-presentation={presentation}>
      <a href="/app/guilds/g1/channels/c1" data-place-row="">General</a>
    </nav>
  ),
}));
vi.mock('../conversation/HeaderAvatar', () => ({
  HeaderAvatar: () => <button type="button">Your profile</button>,
}));
vi.mock('../stage/useStageAudienceGuard', () => ({ useStageAudienceGuard: () => {} }));

const lifetimes = vi.hoisted(() => ({ sheets: { mounts: 0, unmounts: 0 }, stage: { mounts: 0, unmounts: 0 } }));
vi.mock('../sheets', () => ({
  Sheets: ({ layout }: { layout: string }) => {
    useEffect(() => {
      lifetimes.sheets.mounts += 1;
      return () => {
        lifetimes.sheets.unmounts += 1;
      };
    }, []);
    return <div data-testid="sheets-slot" data-layout={layout} />;
  },
}));
vi.mock('../stage', () => ({
  Stage: ({ mode }: { mode: string }) => {
    const [taps, setTaps] = useState(0);
    useEffect(() => {
      lifetimes.stage.mounts += 1;
      return () => {
        lifetimes.stage.unmounts += 1;
      };
    }, []);
    return (
      <button type="button" data-testid="stage-slot" data-mode={mode} onClick={() => setTaps((n) => n + 1)}>
        taps {taps}
      </button>
    );
  },
}));
vi.mock('./PhoneStageChrome', () => ({ PhoneStageChrome: () => <div data-testid="stage-chrome" /> }));

const LOUNGE: StageTarget = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

/** A conversation page: a dialog held in local state, a draft, a scroller, a mount counter. */
const pageLife = { mounts: 0 };
function Page() {
  const [dialog, setDialog] = useState(false);
  useEffect(() => {
    pageLife.mounts += 1;
  }, []);
  return (
    <div data-testid="page">
      <button type="button" onClick={() => setDialog(true)}>
        Edit history
      </button>
      <input aria-label="Message" />
      <div data-testid="scroller" style={{ overflow: 'auto', height: 40 }}>
        <div style={{ height: 400 }} />
      </div>
      {dialog && (
        <div role="dialog" aria-label="Edit history for this message">
          <button type="button" onClick={() => setDialog(false)}>
            Done
          </button>
        </div>
      )}
    </div>
  );
}

function Frame({ layout }: { layout: GlassLayout }) {
  return (
    <MemoryRouter initialEntries={['/app/guilds/g1/channels/c1']}>
      <GlassFrame layout={layout} guildId="g1" channelId="c1">
        <Page />
      </GlassFrame>
    </MemoryRouter>
  );
}

beforeEach(() => {
  useGlassStore.getState().reset();
  usePhoneNavStore.getState().setScreen(null);
  useVoiceStore.setState({ callId: null, callPhase: 'idle', channelId: null });
  lifetimes.sheets = { mounts: 0, unmounts: 0 };
  lifetimes.stage = { mounts: 0, unmounts: 0 };
  pageLife.mounts = 0;
});

describe('resizing across the layouts', () => {
  it('keeps an open dialog open, and the page mounted once, across the phone breakpoint and back', () => {
    const { rerender } = render(<Frame layout="wide" />);
    const main = screen.getByRole('main');
    const page = screen.getByTestId('page');
    fireEvent.click(screen.getByRole('button', { name: 'Edit history' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'half a thought' } });
    const dialog = screen.getByRole('dialog', { name: 'Edit history for this message' });

    for (const layout of ['phone', 'compact', 'wide', 'phone', 'wide'] as const) {
      rerender(<Frame layout={layout} />);
      // The same elements, not rebuilt ones.
      expect(screen.getByRole('main'), layout).toBe(main);
      expect(screen.getByTestId('page'), layout).toBe(page);
      expect(screen.getByRole('dialog', { name: 'Edit history for this message' }), layout).toBe(dialog);
      expect(screen.getByRole('textbox', { name: 'Message' }), layout).toHaveValue('half a thought');
    }
    expect(pageLife.mounts).toBe(1);

    // And it is still alive: it closes from inside.
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps the sheets slot mounted once, with the layout it is given', () => {
    const { rerender } = render(<Frame layout="wide" />);
    expect(screen.getByTestId('sheets-slot')).toHaveAttribute('data-layout', 'wide');
    rerender(<Frame layout="phone" />);
    expect(screen.getByTestId('sheets-slot')).toHaveAttribute('data-layout', 'phone');
    rerender(<Frame layout="compact" />);
    expect(screen.getByTestId('sheets-slot')).toHaveAttribute('data-layout', 'compact');
    expect(lifetimes.sheets).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('keeps the stage on screen, and what it holds, when a watch is resized to a phone and back', () => {
    useGlassStore.getState().openStage(LOUNGE, 'side');
    const { rerender } = render(<Frame layout="wide" />);
    fireEvent.click(screen.getByTestId('stage-slot'));
    expect(screen.getByTestId('stage-slot')).toHaveTextContent('taps 1');
    const stage = screen.getByRole('region', { name: 'Stage' });

    rerender(<Frame layout="phone" />);
    expect(screen.getByRole('region', { name: 'Stage' })).toBe(stage);
    expect(screen.getByTestId('stage-slot')).toHaveTextContent('taps 1');
    expect(screen.getByTestId('stage-chrome')).toBeInTheDocument();

    rerender(<Frame layout="wide" />);
    expect(screen.getByRole('region', { name: 'Stage' })).toBe(stage);
    expect(screen.getByTestId('stage-slot')).toHaveTextContent('taps 1');
    expect(screen.queryByTestId('stage-chrome')).not.toBeInTheDocument();
    expect(lifetimes.stage).toEqual({ mounts: 1, unmounts: 0 });
  });

  it('keeps the page node, with its scroll position, in the same place in the document', () => {
    const { rerender } = render(<Frame layout="wide" />);
    const scroller = screen.getByTestId('scroller');
    scroller.scrollTop = 120;
    rerender(<Frame layout="phone" />);
    expect(screen.getByTestId('scroller')).toBe(scroller);
    expect(scroller.scrollTop).toBe(120);
  });

  it('draws only what a layout has: the wide places pane, the phone places screen, the morph layers', () => {
    const { container, rerender } = render(<Frame layout="wide" />);
    // (The phone's places screen holds a pane of its own, so the wide one is the body's child.)
    const widePane = '.glass-frame__body > .glass-frame__places';
    expect(container.querySelector(widePane)).not.toBeNull();
    expect(container.querySelector('.glass-phone__screen--places')).toBeNull();
    expect(container.querySelector('.glass-phone__scrim')).toBeNull();
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-layout', 'wide');
    expect(container.querySelector('.glass-frame')).not.toHaveAttribute('data-screen');

    rerender(<Frame layout="phone" />);
    expect(container.querySelector(widePane)).toBeNull();
    expect(container.querySelector('.glass-phone__screen--places')).not.toBeNull();
    expect(container.querySelector('.glass-phone__scrim')).not.toBeNull();
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-layout', 'phone');

    rerender(<Frame layout="wide" />);
    expect(container.querySelector(widePane)).not.toBeNull();
    expect(container.querySelector('.glass-phone__screen--places')).toBeNull();
    expect(container.querySelector('.glass-phone__scrim')).toBeNull();
  });

  it('puts the panes in the frame as its own flex items on the wide layout (the body takes no box)', () => {
    const { container } = render(<Frame layout="wide" />);
    const body = container.querySelector('.glass-frame__body') as HTMLElement;
    expect(body.style.display).toBe('contents');
    expect(body.parentElement).toBe(container.querySelector('.glass-frame'));
    // The stage's moves measure `:scope > .glass-frame__places` and friends from it.
    expect(body.querySelector(':scope > .glass-frame__places')).not.toBeNull();
    expect(body.querySelector(':scope > .glass-frame__conversation')).toBe(screen.getByRole('main'));
  });

  it('does not slide the screens for the window becoming a phone, or leave a screen chosen when it stops being one', () => {
    const { container, rerender } = render(<Frame layout="wide" />);
    act(() => usePhoneNavStore.getState().setScreen('conversation'));
    rerender(<Frame layout="phone" />);
    const conversation = container.querySelector('.glass-phone__screen--conversation');
    expect(conversation).toHaveAttribute('data-active', 'true');
    rerender(<Frame layout="wide" />);
    expect(container.querySelector('.glass-frame__body')).not.toHaveAttribute('data-active');
    expect(container.querySelector('.glass-frame__body')).not.toHaveAttribute('inert');
    expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    expect(screen.getByRole('main')).not.toHaveAttribute('tabindex');
  });
});
