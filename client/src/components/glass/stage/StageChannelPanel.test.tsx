import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useVoiceStore } from '../../../stores/voiceStore';
import type { VoiceState } from '../../../types';
import { StageChannelPanel } from './StageChannelPanel';
import { useStageChannelStore } from './useStageChannel';

/**
 * A stage channel's session over its chat: what the Lantern voice page carried
 * for a stage channel (open, retitle and end it; raised hands; invite and move
 * speakers; request to speak), in the Glass conversation.
 */

const SCOPE = { serverId: '__local__', userId: 'me' };
vi.mock('../../../hooks/useCurrentUser', () => ({ useCurrentAccountScope: () => SCOPE }));
const perms = vi.hoisted(() => ({ admin: true }));
vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: () => ({ permissions: 0n, isAdmin: perms.admin }),
}));
const api = vi.hoisted(() => ({
  instance: null as null | Record<string, unknown>,
  getForChannel: vi.fn(),
  create: vi.fn(async () => ({})),
  update: vi.fn(async () => ({})),
  remove: vi.fn(async () => ({})),
  inviteSpeaker: vi.fn(async () => ({})),
  removeSpeaker: vi.fn(async () => ({})),
  requestToSpeak: vi.fn(async () => ({})),
  cancelSpeakerRequest: vi.fn(async () => ({})),
  dismissSpeakerRequest: vi.fn(async () => ({})),
}));
vi.mock('../../../api/stage', () => ({ stageApi: api }));

const INSTANCE = { id: 'st1', channel_id: 'town', guild_id: 'g1', topic: 'Q&A', privacy_level: 2, created_at: '' };

function person(userId: string, over: Partial<VoiceState> = {}): VoiceState {
  return {
    user_id: userId,
    channel_id: 'town',
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
    ...over,
  };
}

function renderPanel() {
  return render(<StageChannelPanel guildId="g1" channelId="town" channelName="Town hall" />);
}

beforeEach(() => {
  perms.admin = true;
  api.instance = null;
  for (const fn of Object.values(api)) if (typeof fn === 'function') (fn as ReturnType<typeof vi.fn>).mockClear();
  api.getForChannel.mockImplementation(async () => {
    if (!api.instance) throw Object.assign(new Error('Not found'), { response: { status: 404 } });
    return { data: api.instance };
  });
  useStageChannelStore.getState().reset();
  useVoiceStore.setState({ connected: false, channelId: null, channelParticipants: new Map() });
});

afterEach(() => {
  useVoiceStore.setState({ connected: false, channelId: null, channelParticipants: new Map() });
});

describe('the stage channel panel', () => {
  it('lets a moderator open the stage with a topic', async () => {
    renderPanel();
    await screen.findByText('Nobody has opened the stage yet.');
    fireEvent.change(screen.getByLabelText('Topic'), { target: { value: 'Launch day' } });
    api.instance = { ...INSTANCE, topic: 'Launch day' };
    fireEvent.click(screen.getByRole('button', { name: 'Open the stage' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ channel_id: 'town', topic: 'Launch day', privacy_level: 2 }));
    expect(await screen.findByText('Launch day')).toBeInTheDocument();
  });

  it('opens with the channel name when the topic is left empty', async () => {
    renderPanel();
    await screen.findByText('Nobody has opened the stage yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Open the stage' }));
    await waitFor(() => expect(api.create).toHaveBeenCalledWith({ channel_id: 'town', topic: 'Town hall', privacy_level: 2 }));
  });

  it('shows a member the stage without the controls', async () => {
    perms.admin = false;
    api.instance = INSTANCE;
    renderPanel();
    expect(await screen.findByText('Q&A')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Manage the stage|Open the stage/ })).toBeNull();
  });

  it('answers raised hands, and moves people between speaking and listening', async () => {
    api.instance = INSTANCE;
    useVoiceStore.setState({
      channelParticipants: new Map([
        ['town', [person('vincent'), person('nick', { suppress: true, request_to_speak_at: '2026-09-30T20:00:00Z' })]],
      ]),
    });
    renderPanel();
    expect(await screen.findByText('One person wants to speak')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Let them speak' }));
    await waitFor(() => expect(api.inviteSpeaker).toHaveBeenCalledWith('st1', 'nick'));
    fireEvent.click(screen.getByRole('button', { name: "Dismiss Nick's request" }));
    await waitFor(() => expect(api.dismissSpeakerRequest).toHaveBeenCalledWith('st1', 'nick'));

    fireEvent.click(screen.getByRole('button', { name: 'Manage the stage' }));
    const people = screen.getByRole('list', { name: 'People on the stage' });
    fireEvent.click(within(people).getByRole('button', { name: 'Move to the audience' }));
    await waitFor(() => expect(api.removeSpeaker).toHaveBeenCalledWith('st1', 'vincent'));
    fireEvent.click(within(people).getByRole('button', { name: 'Invite to speak' }));
    await waitFor(() => expect(api.inviteSpeaker).toHaveBeenCalledWith('st1', 'nick'));
    fireEvent.click(screen.getByRole('button', { name: 'End the stage' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('st1'));
  });

  it("lets the audience in the call raise and lower a hand", async () => {
    perms.admin = false;
    api.instance = INSTANCE;
    useVoiceStore.setState({
      connected: true,
      channelId: 'town',
      channelParticipants: new Map([['town', [person('me', { suppress: true })]]]),
    });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Request to speak' }));
    await waitFor(() => expect(api.requestToSpeak).toHaveBeenCalledWith('st1'));
    act(() =>
      useVoiceStore.setState({
        channelParticipants: new Map([['town', [person('me', { suppress: true, request_to_speak_at: '2026-09-30T20:00:00Z' })]]]),
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Request sent' }));
    await waitFor(() => expect(api.cancelSpeakerRequest).toHaveBeenCalledWith('st1'));
  });

  it("says what the server said when a change fails", async () => {
    api.instance = INSTANCE;
    api.remove.mockRejectedValueOnce(Object.assign(new Error('nope'), { response: { status: 403, data: { message: 'You cannot end this stage.' } } }));
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Manage the stage' }));
    fireEvent.click(screen.getByRole('button', { name: 'End the stage' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/cannot end this stage|nope/i);
  });
});
