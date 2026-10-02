import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useGlassStore, type StageTarget } from '../../../stores/glassStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import { GlassFrame } from './GlassFrame';
import { usePhoneNavStore } from './phoneNav';

// The window is a phone (the back button and the stage read the frame's layout).
vi.mock('../../../hooks/useMobile', () => ({
  useMobile: () => true,
  DEFAULT_MOBILE_MAX_WIDTH: 768,
}));
// The frame's moves and guard belong to the wide frame and have suites of their own.
vi.mock('../stage/useStageAudienceGuard', () => ({ useStageAudienceGuard: () => {} }));
// What the frame owes each slot is a mount, the right props and the right place;
// every slot has a suite of its own.
vi.mock('../room', () => ({ RoomBackdrop: () => <div className="glass-room-backdrop" /> }));
vi.mock('../pill', () => ({
  CallPill: ({ layout, guildId }: { layout: string; guildId: string | null }) => (
    <div data-testid="call-pill" data-layout={layout} data-guild={guildId ?? ''} />
  ),
}));
vi.mock('../places', () => ({
  PlacesPanel: ({ presentation }: { presentation: string }) => (
    <nav aria-label="Channels" data-presentation={presentation}>
      <a href="/app/guilds/g1/channels/c1" data-place-row="" tabIndex={0} onClick={(event) => event.preventDefault()}>
        General
      </a>
      <button type="button" data-place-row="" aria-haspopup="dialog">
        Game servers
      </button>
      <div className="glass-places-servers">
        <button type="button" data-place-row="" aria-current="true">
          Game Night
        </button>
        <button type="button" data-place-row="">
          Basecamp
        </button>
      </div>
    </nav>
  ),
}));
vi.mock('../conversation/HeaderAvatar', () => ({
  HeaderAvatar: () => (
    <button type="button" className="glass-header__avatar">
      Your profile
    </button>
  ),
}));
vi.mock('../sheets', () => ({
  Sheets: ({ layout }: { layout: string }) => <div data-testid="sheets-slot" data-layout={layout} />,
}));
vi.mock('../stage', () => ({
  Stage: ({ mode, target }: { mode: string; target: { streamerId: string } }) => (
    <div data-testid="stage-slot" data-mode={mode}>
      {target.streamerId}
    </div>
  ),
}));
vi.mock('./PhoneStageChrome', () => ({
  PhoneStageChrome: ({ mode }: { mode: string }) => <div data-testid="stage-chrome" data-mode={mode} />,
}));

const LOUNGE: StageTarget = { serverId: 'local', guildId: 'g1', channelId: 'lounge', streamerId: 'vincent' };

interface FrameOptions {
  stageTarget?: StageTarget | null;
  stageMode?: 'side' | 'theater' | null;
}

function renderFrame(path = '/app/guilds/g1/channels/c1', { stageTarget = null, stageMode = null }: FrameOptions = {}) {
  if (stageTarget && stageMode) useGlassStore.getState().openStage(stageTarget, stageMode);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <GlassFrame layout="phone" guildId="g1" channelId="c1">
        <div data-testid="page">a page</div>
      </GlassFrame>
    </MemoryRouter>,
  );
}

const placesScreen = (container: HTMLElement) => container.querySelector('.glass-phone__screen--places') as HTMLElement;
const conversationScreen = (container: HTMLElement) =>
  container.querySelector('.glass-phone__screen--conversation') as HTMLElement;

let waapi: WaapiStub;

beforeEach(() => {
  waapi = installWaapiStub();
  usePhoneNavStore.getState().setScreen('conversation');
  useGlassStore.getState().reset();
  useVoiceStore.setState({ callId: null, callPhase: 'idle', channelId: null });
});

afterEach(() => waapi.restore());

describe('the phone layout of the frame', () => {
  it('draws two screens on the room, with the page in the conversation and the list in places', () => {
    const { container } = renderFrame();
    expect(container.querySelector('.glass-room-backdrop')).not.toBeNull();
    expect(container.querySelector('.glass-phone__scrim')).toHaveAttribute('aria-hidden', 'true');
    const frame = container.querySelector('.glass-frame');
    expect(frame).toHaveAttribute('data-layout', 'phone');
    expect(frame).toHaveAttribute('data-screen', 'conversation');
    expect(frame).toHaveAttribute('data-stage', 'none');

    expect(placesScreen(container)).toContainElement(screen.getByRole('navigation', { name: 'Channels' }));
    expect(screen.getByRole('navigation', { name: 'Channels' })).toHaveAttribute('data-presentation', 'pane');
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(conversationScreen(container)).toContainElement(main);
    expect(main).toContainElement(screen.getByTestId('page'));
    // The sheets slot goes with the conversation, in its phone layout.
    expect(conversationScreen(container)).toContainElement(screen.getByTestId('sheets-slot'));
    expect(screen.getByTestId('sheets-slot')).toHaveAttribute('data-layout', 'phone');
  });

  it('has no bottom bar and no drawer', () => {
    renderFrame();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Navigation' })).not.toBeInTheDocument();
  });

  it('puts the screen behind out of reach: inert, and not the active one', () => {
    const { container } = renderFrame();
    expect(conversationScreen(container)).toHaveAttribute('data-active', 'true');
    expect(conversationScreen(container)).not.toHaveAttribute('inert');
    expect(placesScreen(container)).not.toHaveAttribute('data-active');
    expect(placesScreen(container)).toHaveAttribute('inert');

    act(() => usePhoneNavStore.getState().showPlaces());
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-screen', 'places');
    expect(placesScreen(container)).toHaveAttribute('data-active', 'true');
    expect(placesScreen(container)).not.toHaveAttribute('inert');
    expect(conversationScreen(container)).toHaveAttribute('inert');
    // Both stay mounted: the page keeps its draft and its scroll.
    expect(screen.getByTestId('page')).toBeInTheDocument();
  });

  it('draws the conversation before a first screen has been chosen', () => {
    usePhoneNavStore.getState().setScreen(null);
    const { container } = renderFrame();
    expect(container.querySelector('.glass-frame')).toHaveAttribute('data-screen', 'conversation');
  });

  describe('what a tap in places means', () => {
    beforeEach(() => usePhoneNavStore.getState().setScreen('places'));

    it('a row in the list opens its conversation', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('link', { name: 'General' }));
      expect(usePhoneNavStore.getState().screen).toBe('conversation');
    });

    it('a row that opens a popover is not a place to go to', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Game servers' }));
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });

    it('a modified click is the browser\'s, not a pick', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('link', { name: 'General' }), { ctrlKey: true });
      expect(usePhoneNavStore.getState().screen).toBe('places');
      fireEvent.click(screen.getByRole('link', { name: 'General' }), { button: 1 });
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });

    it('a circle in the server row looks at that server and stays on places', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Basecamp' }));
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });

    it('the circle you are already in goes back to its conversation', () => {
      renderFrame();
      fireEvent.click(screen.getByRole('button', { name: 'Game Night' }));
      expect(usePhoneNavStore.getState().screen).toBe('conversation');
    });

    it('your face is on this screen: the account menu is the phone\'s way to settings', () => {
      const { container } = renderFrame();
      expect(placesScreen(container)).toContainElement(screen.getByRole('button', { name: 'Your profile' }));
      fireEvent.click(screen.getByRole('button', { name: 'Your profile' }));
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });
  });

  describe('the way back', () => {
    it('is a button on a page with no conversation header', () => {
      renderFrame('/app/friends');
      const bar = screen.getByRole('main').querySelector('.glass-frame__pane-bar');
      expect(bar).not.toBeNull();
      const back = screen.getByRole('button', { name: 'Back to places' });
      expect(bar).toContainElement(back);
      fireEvent.click(back);
      expect(usePhoneNavStore.getState().screen).toBe('places');
    });
  });

  describe('the call', () => {
    it('shows no pill on places when you are not in a call', () => {
      const { container } = renderFrame();
      expect(placesScreen(container).querySelector('[data-testid="call-pill"]')).toBeNull();
    });

    it('rides above places while you are in one, two rows, so the microphone and Leave are one tap away', () => {
      usePhoneNavStore.getState().setScreen('places');
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'connected', channelId: 'lounge' });
      const { container } = renderFrame();
      const pill = placesScreen(container).querySelector('[data-testid="call-pill"]');
      expect(pill).toHaveAttribute('data-layout', 'stacked');
      expect(pill).toHaveAttribute('data-guild', 'g1');
    });

    it('is not drawn on places while the conversation is in front (a channel has its own: one pill, not two)', async () => {
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'connected', channelId: 'lounge' });
      const { container } = renderFrame();
      await waitFor(() => expect(placesScreen(container).querySelector('[data-testid="call-pill"]')).toBeNull());

      // Back on places it is there, and it stays for the length of the leave.
      act(() => usePhoneNavStore.getState().showPlaces());
      expect(placesScreen(container).querySelector('[data-testid="call-pill"]')).not.toBeNull();
    });

    it('a call that is closing or failed is not held', () => {
      usePhoneNavStore.getState().setScreen('places');
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'closing', channelId: 'lounge' });
      const { container } = renderFrame();
      expect(placesScreen(container).querySelector('[data-testid="call-pill"]')).toBeNull();
    });

    it('a channel draws its own pill (the pane does), so the frame adds none', () => {
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'connected', channelId: 'lounge' });
      renderFrame('/app/guilds/g1/channels/c1');
      expect(screen.getByRole('main').querySelector('[data-testid="call-pill"]')).toBeNull();
    });

    it('any other page shows the call in a bar under the way back', () => {
      useVoiceStore.setState({ callId: 'call-1', callPhase: 'connected', channelId: 'lounge' });
      renderFrame('/app/friends');
      const bar = screen.getByRole('main').querySelector('.glass-frame__pane-bar');
      expect(bar?.querySelector('[data-testid="call-pill"]')).toHaveAttribute('data-layout', 'stacked');
    });
  });

  describe('watching', () => {
    it('is the stacked stream: the stage card above the conversation, with its phone chrome', () => {
      const { container } = renderFrame(undefined, { stageTarget: LOUNGE, stageMode: 'side' });
      const stage = screen.getByRole('region', { name: 'Stage' });
      expect(stage).toHaveClass('glass-frame__stage');
      expect(stage).toContainElement(screen.getByTestId('stage-slot'));
      expect(screen.getByTestId('stage-slot')).toHaveTextContent('vincent');
      expect(stage).toContainElement(screen.getByTestId('stage-chrome'));
      expect(container.querySelector('.glass-frame')).toHaveAttribute('data-stage', 'side');
      // Above the conversation, in the same screen: no side by side on a phone.
      expect(conversationScreen(container)).toContainElement(stage);
      expect(stage.compareDocumentPosition(screen.getByRole('main'))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(screen.getByRole('main')).not.toHaveAttribute('inert');
    });

    it('full screen is the phone\'s theater: the conversation is out of reach under it', () => {
      const { container } = renderFrame(undefined, { stageTarget: LOUNGE, stageMode: 'theater' });
      expect(container.querySelector('.glass-frame')).toHaveAttribute('data-stage', 'theater');
      expect(screen.getByTestId('stage-chrome')).toHaveAttribute('data-mode', 'theater');
      expect(screen.getByRole('main')).toHaveAttribute('inert');
    });

    it('draws no stage while nothing is on it', () => {
      renderFrame();
      expect(screen.queryByRole('region', { name: 'Stage' })).not.toBeInTheDocument();
    });
  });

  describe('the move between the screens', () => {
    it('plays nothing for the first screen, and slides for a change', () => {
      usePhoneNavStore.getState().setScreen(null);
      const { container } = renderFrame();
      expect(waapi.played).toHaveLength(0);
      // The frame's first choice (the layout effect of the shell) is not a move.
      act(() => usePhoneNavStore.getState().setScreen('conversation'));
      expect(waapi.played).toHaveLength(0);

      act(() => usePhoneNavStore.getState().showPlaces());
      const moves = waapi.played.filter((record) => record.animation.id.startsWith('glass-phone:'));
      expect(moves).toHaveLength(2);
      const incoming = moves.find((record) => record.animation.id === 'glass-phone:in');
      const outgoing = moves.find((record) => record.animation.id === 'glass-phone:out');
      expect(incoming?.target).toBe(placesScreen(container));
      expect(outgoing?.target).toBe(conversationScreen(container));
      // Back: the conversation leaves to the right.
      expect(outgoing?.keyframes.at(-1)).toMatchObject({ transform: 'translateX(100%)' });
    });

    it('moves focus to the conversation when it comes in and to the current row when places comes back', () => {
      usePhoneNavStore.getState().setScreen('places');
      renderFrame();
      act(() => usePhoneNavStore.getState().showConversation());
      expect(screen.getByRole('main')).toHaveFocus();
      act(() => usePhoneNavStore.getState().showPlaces());
      expect(screen.getByRole('link', { name: 'General' })).toHaveFocus();
    });
  });
});
