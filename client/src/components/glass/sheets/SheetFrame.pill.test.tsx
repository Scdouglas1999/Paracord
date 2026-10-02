import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { entityScopeKey } from '../../../lib/serverScope';
import { useChannelStore } from '../../../stores/channelStore';
import { useGlassStore } from '../../../stores/glassStore';
import { useGuildStore } from '../../../stores/guildStore';
import { useMemberStore } from '../../../stores/memberStore';
import { useRemoteSpeakingStore } from '../../../stores/remoteSpeakingStore';
import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { CallPill } from '../pill';
import { useSheetCoverStore } from '../pill/sheetCover';
import { SheetFrame } from './SheetFrame';

/**
 * A sheet covers the conversation's header and the pill in it, and the call's
 * controls have to stay reachable (docs/design/glass-polish-2-checkpoint.md,
 * item 1). Where the pill is drawn and how it looks is held by the screenshots
 * (e2e/glass-polish-2.spec.ts); this holds what a keyboard and a screen reader
 * get: one pill to reach, in the sheet, and the one underneath out of the way.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentAccountScope: () => SCOPE,
  useCurrentUser: () => ({ id: 'me', username: 'sean', display_name: 'Sean', avatar_hash: null }),
}));
vi.mock('../../../api/files', () => ({
  fileApi: { resolveAttachmentObjectUrl: vi.fn(async () => 'blob:face') },
}));
vi.mock('../../../stores/voice/viewFrames', () => ({ subscribeViewFrames: () => () => {} }));

const mobile = vi.hoisted(() => ({ value: false }));
vi.mock('../../../hooks/useMobile', () => ({ useMobile: () => mobile.value }));

function voiceState(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: 'lounge',
    guild_id: 'g1',
    session_id: `s-${userId}`,
    deaf: false,
    mute: false,
    self_deaf: false,
    self_mute: false,
    self_stream: false,
    self_video: false,
    suppress: false,
    username: userId,
    display_name: userId[0].toUpperCase() + userId.slice(1),
    avatar_hash: null,
    ...over,
  };
}

const channel = (id: string, name: string, type: number) => ({
  id,
  name,
  guild_id: 'g1',
  type,
  channel_type: type,
  position: 0,
  key: entityScopeKey(SCOPE, id),
  scope: SCOPE,
});

const LOUNGE_PILL = { name: 'Lounge, live voice channel' };

/** The conversation: its header's pill slot, and the sheet over it. */
function Conversation({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <main id="main-content">
        <div className="glass-header">
          <div className="glass-header__pill">
            <CallPill guildId="g1" layout="row" />
          </div>
        </div>
      </main>
      <SheetFrame
        open={open}
        onClose={() => {
          setOpen(false);
          onClose();
        }}
        kind="test"
        label="A sheet"
        title="A sheet"
        closeLabel="Close the sheet"
      >
        <button type="button">A control</button>
      </SheetFrame>
    </>
  );
}

function renderSheet(path = '/app/guilds/g1/channels/general', onClose?: () => void) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/app/guilds/:guildId/channels/:channelId" element={<Conversation onClose={onClose} />} />
      </Routes>
    </MemoryRouter>,
  );
}

function live() {
  useVoiceStore.setState({
    channelParticipants: new Map([['lounge', [voiceState('vincent', { self_stream: true }), voiceState('brendan')]]]),
  });
}

beforeEach(() => {
  mobile.value = false;
  document.body.innerHTML = '';
  useSheetCoverStore.setState({ sheets: 0 });
  useGlassStore.getState().reset();
  useRemoteSpeakingStore.setState({ byChannel: new Map() });
  useMemberStore.setState({ members: new Map() } as never);
  useGuildStore.setState({
    guilds: [{ key: entityScopeKey(SCOPE, 'g1'), id: 'g1', name: 'Game Night', scope: SCOPE, originServerId: SCOPE.serverId }],
  } as never);
  useChannelStore.setState({
    channelsById: {
      [entityScopeKey(SCOPE, 'lounge')]: channel('lounge', 'Lounge', 2),
      [entityScopeKey(SCOPE, 'general')]: channel('general', 'General', 0),
    },
  } as never);
  useVoiceStore.setState({
    callId: null,
    callScope: null,
    callPhase: 'idle',
    callMode: null,
    connected: false,
    channelId: null,
    guildId: null,
    selfMute: false,
    channelParticipants: new Map(),
    participants: new Map(),
    speakingUsers: new Set(),
    watchView: null,
    ambientView: null,
  });
});

describe('the call pill over a sheet', () => {
  it("is drawn in the sheet's header, so the call stays reachable", () => {
    live();
    renderSheet();
    const dialog = screen.getByRole('dialog', { name: 'A sheet' });
    const pill = within(dialog).getByRole('region', LOUNGE_PILL);
    expect(pill).toHaveAttribute('data-placement', 'sheet');
    expect(pill.closest('.glass-sheet__pill')).not.toBeNull();
    expect(pill.closest('.glass-sheet__header')).not.toBeNull();
    // It is the real pill: its buttons work (Join is one of them).
    expect(within(pill).getByRole('button', { name: 'Join Lounge' })).toBeInTheDocument();
  });

  it('leaves the one underneath inert and out of the accessibility tree, so there is one pill to reach', () => {
    live();
    renderSheet();
    const regions = screen.getAllByRole('region', LOUNGE_PILL);
    expect(regions).toHaveLength(1);
    expect(screen.getByRole('dialog')).toContainElement(regions[0]);

    const covered = document.querySelector<HTMLElement>('main .glass-pill');
    expect(covered).not.toBeNull();
    expect(covered).toHaveAttribute('data-placement', 'header');
    expect(covered).toHaveAttribute('aria-hidden', 'true');
    expect(covered).toHaveAttribute('inert');
  });

  it('gives the header back its pill when the sheet is gone', async () => {
    live();
    const user = userEvent.setup();
    renderSheet();
    await user.click(screen.getByRole('button', { name: 'Close the sheet' }));
    await vi.waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The pill is reachable again the moment the sheet is gone.
    const pill = await screen.findByRole('region', LOUNGE_PILL);
    expect(screen.getAllByRole('region', LOUNGE_PILL)).toHaveLength(1);
    expect(pill).toHaveAttribute('data-placement', 'header');
    expect(pill).not.toHaveAttribute('inert');
    expect(pill).not.toHaveAttribute('aria-hidden');
    expect(useSheetCoverStore.getState().sheets).toBe(0);
  });

  it("keeps the first focus on the sheet's own first control, not on the pill", () => {
    live();
    renderSheet();
    expect(screen.getByRole('button', { name: 'Close the sheet' })).toHaveFocus();
  });

  it('reaches the pill by Tab, and Tab still stays inside the sheet', async () => {
    live();
    const user = userEvent.setup();
    renderSheet();
    const dialog = screen.getByRole('dialog');
    const reached: Array<string | null> = [];
    for (let i = 0; i < 12; i++) {
      await user.tab();
      expect(dialog).toContainElement(document.activeElement as HTMLElement);
      reached.push((document.activeElement as HTMLElement).getAttribute('aria-label'));
    }
    expect(reached).toContain('Join Lounge');
    expect(reached).toContain("Show who's in Lounge");
  });

  it('Escape on an expanded pill puts the roster away and leaves the sheet open', async () => {
    live();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSheet('/app/guilds/g1/channels/general', onClose);
    const pill = screen.getByRole('region', LOUNGE_PILL);
    await user.click(within(pill).getByRole('button', { name: "Show who's in Lounge" }));
    expect(useGlassStore.getState().pillExpanded).toBe(true);
    expect(within(pill).getByRole('list', { name: 'In Lounge' })).toBeInTheDocument();

    fireEvent.keyDown(within(pill).getByRole('button', { name: "Show who's in Lounge" }), { key: 'Escape' });
    expect(useGlassStore.getState().pillExpanded).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    // The next Escape is the sheet's.
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a voice channel's own pill on that channel's route, even with nobody in it", () => {
    renderSheet('/app/guilds/g1/channels/lounge');
    expect(within(screen.getByRole('dialog')).getByRole('region', LOUNGE_PILL)).toBeInTheDocument();
  });

  it('draws no pill when nothing is live and there is no call, and its slot takes no room', () => {
    renderSheet();
    expect(screen.queryByRole('region', LOUNGE_PILL)).toBeNull();
    expect(document.querySelector('.glass-sheet__pill')).toBeEmptyDOMElement();
  });

  it('does not count a closed sheet as covering anything', () => {
    live();
    render(
      <MemoryRouter initialEntries={['/app/guilds/g1/channels/general']}>
        <Routes>
          <Route
            path="/app/guilds/:guildId/channels/:channelId"
            element={
              <>
                <div className="glass-header__pill">
                  <CallPill guildId="g1" layout="row" />
                </div>
                <SheetFrame open={false} onClose={() => {}} kind="test" label="A sheet" title="A sheet">
                  <p>Nothing</p>
                </SheetFrame>
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );
    expect(useSheetCoverStore.getState().sheets).toBe(0);
    expect(screen.getByRole('region', LOUNGE_PILL)).not.toHaveAttribute('inert');
  });

  it('does not announce what the covered pill would, only the sheet one', () => {
    live();
    renderSheet();
    act(() => {
      useVoiceStore.setState({
        callId: 'call-1',
        callScope: SCOPE,
        callPhase: 'connected',
        callMode: 'joined',
        connected: true,
        channelId: 'lounge',
        guildId: 'g1',
        channelParticipants: new Map([['lounge', [voiceState('vincent', { self_stream: true }), voiceState('me', { mode: 'joined' })]]]),
      });
    });
    const said = Array.from(document.querySelectorAll('[role="status"]')).map((node) => node.textContent);
    expect(said.filter((text) => text === 'Joined Lounge')).toHaveLength(1);
  });
});

describe('on a phone', () => {
  it("is a row above the header, where the conversation has it", () => {
    mobile.value = true;
    live();
    renderSheet();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('data-host', 'window');
    const pill = within(dialog).getByRole('region', LOUNGE_PILL);
    expect(pill).toHaveAttribute('data-layout', 'stacked');
    const row = pill.closest('.glass-sheet__phone-pill');
    expect(row).not.toBeNull();
    // Drawn above the header (CSS `order`), after it in the document so the
    // sheet's own first control keeps the focus.
    expect(row?.parentElement).toBe(dialog);
    expect(dialog.querySelector('.glass-sheet__pill')).toBeNull();
    expect(screen.getByRole('button', { name: 'Close the sheet' })).toHaveFocus();
  });
});
