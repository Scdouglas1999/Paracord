import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureMotion, resetMotionSwitchForTests } from '../../../lib/motion/reducedMotion';
import { installWaapiStub, type WaapiStub } from '../../../lib/motion/waapiStub';
import { useAuthStore } from '../../../stores/authStore';
import { useChannelStore } from '../../../stores/channelStore';
import { scopeGuild, useGuildStore } from '../../../stores/guildStore';
import { useRelationshipStore } from '../../../stores/relationshipStore';
import { toast } from '../../../stores/toastStore';
import { Permissions } from '../../../types';
import type { Channel } from '../../../types';
import { EmptyConversation, LockedConversation } from './EmptyConversation';
import type { ConversationSubject } from './types';

/**
 * The empty conversation (docs/index-spec.md §4.13, §5.6): the welcome with the
 * cards that fit, "Bring your people", "Say hello" and "Plan a night" (the draft,
 * Post it, Edit), and the DM and group welcomes.
 */
const net = vi.hoisted(() => ({
  listGuild: vi.fn(),
  create: vi.fn(),
  resolveShareAddress: vi.fn(),
  writeClipboardText: vi.fn(),
  openInvite: vi.fn(),
  post: vi.fn(),
  sendMessage: vi.fn(),
  setContent: vi.fn(),
  draft: { content: '' },
  getProfile: vi.fn(),
  onboarding: vi.fn(),
  perms: { permissions: 0n, isAdmin: false },
}));

vi.mock('../../../api/invites', () => ({ inviteApi: { listGuild: net.listGuild, create: net.create } }));
vi.mock('../../guild/InviteModal', () => ({
  resolveShareAddress: net.resolveShareAddress,
  reachNote: () => 'Only this computer can reach this server.',
}));
vi.mock('../../../lib/clipboard', () => ({ writeClipboardText: net.writeClipboardText }));
vi.mock('../menus', () => ({ openInvite: net.openInvite }));
vi.mock('../../../api/activeClient', () => ({ getApi: () => ({ post: net.post }) }));
vi.mock('../../../hooks/useMessageStore', () => ({
  useCurrentMessageStoreApi: () => ({ getState: () => ({ sendMessage: net.sendMessage }) }),
}));
vi.mock('../../../lib/messages/accountMessagingRuntime', () => ({
  getAccountMessagingRuntime: () => ({
    draftController: () => ({ store: { getState: () => ({ draft: net.draft }) }, setContent: net.setContent }),
  }),
}));
vi.mock('../../../api/users', () => ({ userApi: { getProfile: net.getProfile } }));
vi.mock('../../../api/guilds', () => ({ guildApi: { getMyOnboardingState: net.onboarding } }));
vi.mock('../../../hooks/usePermissions', () => ({ usePermissions: () => net.perms }));
vi.mock('../../guild/EventList', () => ({
  EventFormModal: ({
    defaults,
    onClose,
    onSaved,
  }: {
    defaults?: { name?: string; channelId?: string | null; entityType?: number };
    onClose: () => void;
    onSaved: (event: { id: string }) => void;
  }) => (
    <div role="dialog" aria-label="Create an event" data-name={defaults?.name} data-channel={defaults?.channelId} data-type={defaults?.entityType}>
      <button type="button" onClick={() => onSaved({ id: '88' })}>
        Create event
      </button>
      <button type="button" onClick={onClose}>
        Cancel
      </button>
    </div>
  ),
}));

const SCOPE = { serverId: '__local__', userId: 'me' };
const GUILD_ID = 'g1';
const ALL = (1n << 40n) - 1n;

const SUBJECT: ConversationSubject = { kind: 'channel', guildId: GUILD_ID, guildName: 'Fuel', channelId: 'c1', channelName: 'general' };

function channel(id: string, type: number, name: string, extra: Partial<Channel> = {}): Channel {
  return { id, type, channel_type: type, guild_id: GUILD_ID, name, position: 0, nsfw: false, created_at: '2026-01-01T00:00:00.000Z', ...extra } as Channel;
}

function seed(channels: Channel[] = [channel('c1', 0, 'general'), channel('c2', 0, 'clips'), channel('v1', 2, 'General')], owner = 'me') {
  useGuildStore.setState({
    guilds: [scopeGuild({ id: GUILD_ID, name: 'Fuel', owner_id: owner, description: 'Haz 5 runs.', member_count: 1 } as never, SCOPE)],
  });
  useChannelStore.getState().reset();
  useChannelStore.getState().setChannels(GUILD_ID, channels, SCOPE);
}

function Host({ subject = SUBJECT, ...rest }: Partial<React.ComponentProps<typeof EmptyConversation>> & { children?: ReactNode }) {
  const root = useRef<HTMLDivElement | null>(null);
  return (
    <MemoryRouter>
      <div ref={root}>
        <textarea data-composer-input="" aria-label="Message" />
        <EmptyConversation subject={subject} canSend joiner={false} root={root} {...rest} />
      </div>
    </MemoryRouter>
  );
}

let waapi: WaapiStub;

beforeEach(() => {
  waapi = installWaapiStub();
  resetMotionSwitchForTests();
  configureMotion('full');
  for (const fn of [net.listGuild, net.create, net.resolveShareAddress, net.writeClipboardText, net.openInvite, net.post, net.sendMessage, net.setContent, net.getProfile, net.onboarding]) fn.mockReset();
  net.draft.content = '';
  net.perms = { permissions: ALL, isAdmin: false };
  net.listGuild.mockRejectedValue(new Error('forbidden'));
  net.create.mockResolvedValue({ data: { code: 'abc' } });
  net.resolveShareAddress.mockResolvedValue({ url: 'https://paracord.test', reach: 'internet' });
  net.writeClipboardText.mockResolvedValue(undefined);
  net.post.mockResolvedValue({ data: { id: '77' } });
  net.sendMessage.mockResolvedValue(undefined);
  net.getProfile.mockRejectedValue(new Error('offline'));
  net.onboarding.mockRejectedValue(new Error('offline'));
  useAuthStore.setState({ token: 'token', user: { id: 'me', username: 'sean', display_name: 'Sean' } as never });
  useRelationshipStore.setState({ relationships: [] });
  seed();
});

afterEach(() => {
  cleanup();
  waapi.restore();
  resetMotionSwitchForTests();
  vi.restoreAllMocks();
});

const card = (action: string): HTMLElement => {
  const found = document.querySelector<HTMLElement>(`[data-testid="ix-action-card"][data-action="${action}"]`);
  if (!found) throw new Error(`no ${action} card`);
  return found;
};
const cards = () => screen.queryAllByTestId('ix-action-card').map((element) => element.getAttribute('data-action'));

describe('the server’s welcome', () => {
  it('says "<Server> is ready" with the three cards, for a server nobody has spoken in', () => {
    render(<Host />);
    expect(screen.getByRole('heading', { name: 'Fuel is ready' })).toBeInTheDocument();
    expect(screen.getByText('Three good ways to start it.')).toBeInTheDocument();
    expect(cards()).toEqual(['invite', 'plan', 'hello']);
    expect(screen.getByTestId('ix-welcome')).toHaveAttribute('data-variant', 'server');
  });

  it('leaves out the cards a person lacks permission for', () => {
    net.perms = { permissions: Permissions.SEND_MESSAGES, isAdmin: false };
    render(<Host />);
    expect(cards()).toEqual(['hello']);
    expect(screen.getByText('One good way to start it.')).toBeInTheDocument();
  });

  it('without Send Messages there is no Say hello or Plan a night (a plan is posted as a message)', () => {
    render(<Host canSend={false} />);
    expect(cards()).toEqual(['invite']);
  });

  it('a server that already has something said in it opens its first channel like any other', () => {
    seed([channel('c1', 0, 'general', { last_message_id: '5' }), channel('c2', 0, 'clips')]);
    render(<Host />);
    expect(screen.getByRole('heading', { name: 'general is ready' })).toBeInTheDocument();
    expect(cards()).toEqual(['hello', 'plan']);
  });

  it('says the topic of an empty channel, and "Nothing here yet." when there is none', () => {
    seed([channel('c1', 0, 'general', { last_message_id: '5' }), channel('c2', 0, 'plans', { topic: 'Game nights and meetups' })]);
    const { unmount } = render(<Host subject={{ ...SUBJECT, channelId: 'c2', channelName: 'plans', topic: 'Game nights and meetups' }} />);
    expect(screen.getByText('Game nights and meetups')).toBeInTheDocument();
    unmount();
    render(<Host subject={{ ...SUBJECT, channelId: 'c3', channelName: 'clips' }} />);
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});

describe('Bring your people', () => {
  it('makes a link that never ends and copies it, and the card says "Link copied"', async () => {
    render(<Host />);
    await userEvent.click(card('invite'));
    await waitFor(() => expect(net.writeClipboardText).toHaveBeenCalledWith('https://paracord.test/invite/abc'));
    expect(net.create).toHaveBeenCalledWith('c1', { max_age: 0, max_uses: 0 });
    await waitFor(() => expect(card('invite').querySelector('[data-copied]')).not.toBeNull());
    expect(screen.getByRole('status')).toHaveTextContent('Link copied');
  });

  it('reuses an invite of yours that never ends, and makes none', async () => {
    net.listGuild.mockResolvedValue({
      data: [
        { code: 'old', max_age: 604800, max_uses: 0, inviter_id: 'me' },
        { code: 'forever', max_age: 0, max_uses: 0, inviter_id: 'me' },
      ],
    });
    render(<Host />);
    await userEvent.click(card('invite'));
    await waitFor(() => expect(net.writeClipboardText).toHaveBeenCalledWith('https://paracord.test/invite/forever'));
    expect(net.create).not.toHaveBeenCalled();
  });

  it('a second press opens the invite dialog, where the link and Copy are', async () => {
    render(<Host />);
    await userEvent.click(card('invite'));
    await waitFor(() => expect(net.writeClipboardText).toHaveBeenCalledTimes(1));
    await userEvent.click(card('invite'));
    expect(net.openInvite).toHaveBeenCalledWith({ guildName: 'Fuel', channelId: 'c1' });
    expect(net.create).toHaveBeenCalledTimes(1);
  });

  it('says why when there is no link to hand out, and never says "copied"', async () => {
    net.resolveShareAddress.mockResolvedValue({ url: null, reach: 'this_computer' });
    const error = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    render(<Host />);
    await userEvent.click(card('invite'));
    await waitFor(() => expect(error).toHaveBeenCalledWith('Could not copy an invite link: Only this computer can reach this server.'));
    expect(net.writeClipboardText).not.toHaveBeenCalled();
    expect(card('invite').querySelector('[data-copied]')).toBeNull();
  });
});

describe('Say hello', () => {
  it('fills the message box, selects the greeting and focuses it; it never sends', async () => {
    render(<Host />);
    const input = screen.getByLabelText('Message') as HTMLTextAreaElement;
    net.setContent.mockImplementation((value: string) => {
      input.value = value;
    });
    await userEvent.click(card('hello'));
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(net.setContent).toHaveBeenCalledWith('Hello! Fuel is open, come hang out.');
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Hello! Fuel is open, come hang out.'.length);
    expect(net.sendMessage).not.toHaveBeenCalled();
  });

  it('never replaces words already typed: the box only takes focus', async () => {
    net.draft.content = 'half a thought';
    render(<Host />);
    await userEvent.click(card('hello'));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Message')));
    expect(net.setContent).not.toHaveBeenCalled();
  });
});

describe('Plan a night', () => {
  const plan = async () => {
    render(<Host />);
    await userEvent.click(card('plan'));
    return screen.getByTestId('ix-draft-event');
  };

  it('morphs into a draft event card: Game night, a Friday at 9:00 PM, in the first voice channel', async () => {
    const draft = await plan();
    expect(draft).toHaveTextContent('Game night');
    expect(draft).toHaveTextContent(/Friday at 9:00\sPM · in General/);
    expect(screen.getByRole('button', { name: 'Post it' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    // Nothing exists until Post it.
    expect(net.post).not.toHaveBeenCalled();
    expect(net.sendMessage).not.toHaveBeenCalled();
  });

  it('grows out of the action card (650ms, from half opacity) while the welcome fades out (300ms)', async () => {
    await plan();
    const grow = waapi.played.find((record) => record.animation.id === 'ix-conversation:draft');
    expect(grow?.options.duration).toBe(650);
    expect(grow?.keyframes.map((frame) => frame.opacity)).toEqual([0.5, 1]);
    const out = waapi.played.find((record) => record.animation.id === 'ix-conversation:welcome-out');
    expect(out?.options.duration).toBe(300);
    expect(out?.keyframes.map((frame) => frame.opacity)).toEqual([1, 0]);
    // Transform and opacity only.
    const properties = new Set(waapi.played.flatMap((record) => record.keyframes.flatMap((frame) => Object.keys(frame))));
    expect([...properties].every((property) => ['transform', 'opacity', 'transformOrigin', 'offset'].includes(property))).toBe(true);
    // While it fades the welcome gives up the pointer and the reader.
    expect(screen.getByTestId('ix-welcome').parentElement).toHaveAttribute('inert');
    act(() => waapi.played.find((record) => record.animation.id === 'ix-conversation:welcome-out')?.animation.finish());
    await waitFor(() => expect(screen.queryByTestId('ix-welcome')).not.toBeInTheDocument());
  });

  it('Post it creates the event in the voice channel with a reminder, then posts it in the channel', async () => {
    await plan();
    await userEvent.click(screen.getByRole('button', { name: 'Post it' }));
    await waitFor(() => expect(net.sendMessage).toHaveBeenCalledWith('c1', '<event:77>'));
    expect(net.post).toHaveBeenCalledTimes(1);
    const [path, body] = net.post.mock.calls[0];
    expect(path).toBe(`/guilds/${GUILD_ID}/events`);
    expect(body).toMatchObject({ name: 'Game night', entity_type: 1, channel_id: 'v1', reminder_minutes: 30 });
    expect(new Date(body.scheduled_start).getDay()).toBe(5);
  });

  it('a message that failed to send is retried alone: never a second event', async () => {
    net.sendMessage.mockRejectedValueOnce(new Error('The server is busy.'));
    await plan();
    await userEvent.click(screen.getByRole('button', { name: 'Post it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The server is busy.');
    expect(screen.getByRole('button', { name: 'Post it' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Post it' }));
    await waitFor(() => expect(net.sendMessage).toHaveBeenCalledTimes(2));
    expect(net.post).toHaveBeenCalledTimes(1);
    expect(net.sendMessage).toHaveBeenLastCalledWith('c1', '<event:77>');
  });

  it('an event the server refused is said, and the draft stays', async () => {
    net.post.mockRejectedValueOnce(new Error('You need Manage Server.'));
    await plan();
    await userEvent.click(screen.getByRole('button', { name: 'Post it' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('You need Manage Server.');
    expect(net.sendMessage).not.toHaveBeenCalled();
    expect(screen.getByTestId('ix-draft-event')).toBeInTheDocument();
  });

  it('Edit opens the event form first, with the draft; saving it posts the event it made', async () => {
    await plan();
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('dialog', { name: 'Create an event' });
    expect(form).toHaveAttribute('data-name', 'Game night');
    expect(form).toHaveAttribute('data-channel', 'v1');
    expect(form).toHaveAttribute('data-type', '1');
    expect(net.post).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Create event' }));
    await waitFor(() => expect(net.sendMessage).toHaveBeenCalledWith('c1', '<event:88>'));
    // The form made the event; this posted it and made nothing of its own.
    expect(net.post).not.toHaveBeenCalled();
  });
});

describe('the joiner welcome', () => {
  it('welcomes a joiner with the description and Say hello, See who’s here and Pick roles', async () => {
    net.onboarding.mockResolvedValue({ data: { settings: { role_options: [{ id: 'r' }] }, member_state: { completed_at: null } } });
    const onPickRoles = vi.fn();
    render(<Host joiner onPickRoles={onPickRoles} />);
    expect(screen.getByRole('heading', { name: 'Welcome to Fuel' })).toBeInTheDocument();
    expect(screen.getByText('Haz 5 runs.')).toBeInTheDocument();
    await waitFor(() => expect(cards()).toEqual(['hello', 'people', 'roles']));
    await userEvent.click(card('roles'));
    expect(onPickRoles).toHaveBeenCalledTimes(1);
  });

  it('offers no Pick roles when the server has none, or it is done', async () => {
    net.onboarding.mockResolvedValue({ data: { settings: { role_options: [{ id: 'r' }] }, member_state: { completed_at: '2026-10-01' } } });
    render(<Host joiner onPickRoles={() => undefined} />);
    await waitFor(() => expect(net.onboarding).toHaveBeenCalled());
    expect(cards()).toEqual(['hello', 'people']);
  });

  it('is shown once: seeing it is being welcomed', () => {
    render(<Host joiner />);
    expect(window.localStorage.getItem(`paracord:v2:guild-welcomed:${GUILD_ID}`)).toBe('1');
  });
});

describe('a new message and a group', () => {
  const DM: ConversationSubject = {
    kind: 'dm',
    channelId: 'd1',
    title: 'Jeremy',
    isGroup: false,
    recipient: { id: 'jeremy', username: 'jeremy', display_name: 'Jeremy', avatar_hash: null },
  };

  it('shows the person and says "You’re friends"', () => {
    useRelationshipStore.setState({ relationships: [{ type: 1, user: { id: 'jeremy', username: 'jeremy' } } as never] });
    render(<Host subject={DM} />);
    expect(screen.getByRole('heading', { name: 'Jeremy' })).toBeInTheDocument();
    expect(screen.getByText('You’re friends')).toBeInTheDocument();
    expect(cards()).toEqual(['hello']);
  });

  it('says what the two of you share when you are not friends', async () => {
    net.getProfile.mockResolvedValue({ data: { mutual_guilds: [{ id: 'g2', name: 'Game Night' }] } });
    render(<Host subject={DM} />);
    expect(await screen.findByText('You share Game Night')).toBeInTheDocument();
  });

  it('Say hello greets the person by their first name', async () => {
    render(<Host subject={DM} />);
    await userEvent.click(card('hello'));
    await waitFor(() => expect(net.setContent).toHaveBeenCalledWith('Hey Jeremy!'));
  });

  it('a group says how many are in it, or who it is waiting on', () => {
    const group: ConversationSubject = { kind: 'dm', channelId: 'd2', title: 'Crew', isGroup: true, participants: 4 };
    const { unmount } = render(<Host subject={group} />);
    expect(screen.getByText('Group · 4 people')).toBeInTheDocument();
    unmount();
    useChannelStore.getState().setChannels('', [{ id: 'd2', type: 3, channel_type: 3, guild_id: null, recipients: [{ id: 'me', username: 'sean', public_key: 'k' }, { id: 'ada', username: 'ada' }] } as never], SCOPE);
    render(<Host subject={group} />);
    expect(screen.getByRole('heading', { name: 'Waiting on everyone’s encryption' })).toBeInTheDocument();
    expect(screen.getByText(/Waiting on: ada\./)).toBeInTheDocument();
    expect(cards()).toEqual([]);
  });
});

describe('LockedConversation', () => {
  it('says "Locked" with one cream Unlock that goes to the unlock page and back', async () => {
    render(
      <MemoryRouter>
        <LockedConversation />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Locked' })).toBeInTheDocument();
    expect(screen.getByText('Unlock your vault to read this conversation.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unlock' })).toHaveClass('ix-cream');
  });
});
