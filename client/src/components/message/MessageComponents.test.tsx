import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonStyle, ComponentType } from '../../types/components';
import { MessageComponents } from './MessageComponents';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getMembers: vi.fn(),
  getRoles: vi.fn(),
  toastError: vi.fn(),
  addPendingInteraction: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  apiClient: { post: mocks.post },
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Unexpected failure'),
}));

vi.mock('../../api/activeClient', () => ({
  getApi: () => ({ post: mocks.post }),
}));

// This suite asserts on the interaction POST. The real download-ticket module
// mints through the same `getApi()` the moment a component subscribes to it,
// which would put `/download/ticket` first in `mocks.post.mock.calls`.
vi.mock('../../lib/downloadTicket', () => ({
  getDownloadTicket: () => null,
  subscribeDownloadTicket: () => () => {},
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getChannels: vi.fn(),
    getMembers: mocks.getMembers,
    getRoles: mocks.getRoles,
  },
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        channelsByGuild: {
          'guild-1': [{ id: 'channel-1', type: 0, name: 'general', position: 0 }],
        },
      }),
    {
      getState: () => ({
        channelsByGuild: {
          'guild-1': [{ id: 'channel-1', type: 0, name: 'general', position: 0 }],
        },
      }),
    },
  ),
}));

vi.mock('../../stores/interactionStore', () => ({
  useInteractionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        addPendingInteraction: mocks.addPendingInteraction,
      }),
    {
      getState: () => ({
        addPendingInteraction: mocks.addPendingInteraction,
      }),
    },
  ),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

describe('MessageComponents interaction feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.post.mockResolvedValue({
      data: {
        id: 'ix-1',
        application_id: 'app-1',
        type: 3,
        channel_id: 'channel-1',
        guild_id: 'guild-1',
        token: 'tok',
        version: 1,
      },
    });
    vi.stubGlobal('open', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows a toast when a button interaction fails', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce(new Error('Bot endpoint rejected the click'));

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        guildId="guild-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Primary,
                custom_id: 'approve',
                label: 'Approve',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith(
        'Could not run message action: Bot endpoint rejected the click',
      );
    });
  });

  it('posts guild_id and tracks pending on successful button click', async () => {
    const user = userEvent.setup();

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        guildId="guild-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Primary,
                custom_id: 'approve',
                label: 'Approve',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith(
        '/interactions',
        expect.objectContaining({
          type: 3,
          guild_id: 'guild-1',
          channel_id: 'channel-1',
          message_id: 'message-1',
          custom_id: 'approve',
        }),
      );
      expect(mocks.addPendingInteraction).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ix-1', guild_id: 'guild-1' }),
      );
    });
  });

  it('shows a toast when a select-menu interaction fails', async () => {
    const user = userEvent.setup();
    mocks.post.mockRejectedValueOnce(new Error('Selection expired'));

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: 'priority',
                placeholder: 'Choose priority',
                options: [
                  { label: 'Low', value: 'low' },
                  { label: 'High', value: 'high' },
                ],
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Choose priority' }));
    await user.click(screen.getByRole('button', { name: 'High' }));

    await waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledWith('Could not submit selection: Selection expired');
    });
  });

  it('shows an inline alert when entity select options fail to load', async () => {
    const user = userEvent.setup();
    mocks.getMembers.mockRejectedValueOnce(new Error('Members unavailable'));

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.UserSelect,
                custom_id: 'assign-user',
                placeholder: 'Assign user',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign user' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Could not load options: Members unavailable',
    );
    expect(mocks.toastError).toHaveBeenCalledWith('Could not load options: Members unavailable');
  });

  it('strips user/role prefixes before submitting mentionable select values', async () => {
    const user = userEvent.setup();
    mocks.getMembers.mockResolvedValueOnce({
      data: [
        {
          user: { id: '111', username: 'Ada', avatar_hash: null },
          nick: null,
        },
      ],
    });
    mocks.getRoles.mockResolvedValueOnce({
      data: [{ id: '222', name: 'Mods', color: 0, position: 1 }],
    });

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        guildId="guild-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.MentionableSelect,
                custom_id: 'ping-target',
                placeholder: 'Select a user or role...',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Select a user or role...' }));
    await user.click(await screen.findByRole('button', { name: /Ada/i }));

    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith(
        '/interactions',
        expect.objectContaining({
          custom_id: 'ping-target',
          values: ['111'],
        }),
      );
    });
    expect(mocks.post.mock.calls[0][1].values[0]).not.toMatch(/^user:/);
  });

  it('renders safe entity avatars and falls back for unresolved avatar hashes', async () => {
    const user = userEvent.setup();
    mocks.getMembers.mockResolvedValueOnce({
      data: [
        {
          user: {
            id: 'user-1',
            username: 'Ada',
            discriminator: 1,
            avatar_hash: 'data:image/png;base64,iVBORw0KGgo=',
          },
          roles: [],
          joined_at: '2026-05-17T00:00:00Z',
          deaf: false,
          mute: false,
        },
        {
          user: {
            id: 'user-2',
            username: 'Grace',
            discriminator: 2,
            avatar_hash: 'legacy-avatar-hash',
          },
          roles: [],
          joined_at: '2026-05-17T00:00:00Z',
          deaf: false,
          mute: false,
        },
      ],
    });

    const { container } = render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.UserSelect,
                custom_id: 'assign-user',
                placeholder: 'Assign user',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Assign user' }));

    expect(await screen.findByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    const renderedImages = Array.from(container.querySelectorAll('img')).map((img) =>
      img.getAttribute('src'),
    );
    expect(renderedImages).toContain('data:image/png;base64,iVBORw0KGgo=');
    expect(renderedImages).not.toContain('/avatars/user-2/legacy-avatar-hash.png');
  });

  describe('button tones (docs/index-spec.md §8.4)', () => {
    const row = (...buttons: Array<{ label: string; style: ButtonStyle; url?: string; disabled?: boolean }>) => [
      {
        type: ComponentType.ActionRow,
        components: buttons.map((b, i) => ({ type: ComponentType.Button, custom_id: `b${i}`, ...b })),
      },
    ];
    const show = (components: ReturnType<typeof row>) =>
      render(<MessageComponents channelId="channel-1" messageId="message-1" guildId="guild-1" components={components} />);

    it('makes a bot’s only primary button the cream one', () => {
      show(row({ label: 'Approve', style: ButtonStyle.Primary }, { label: 'Later', style: ButtonStyle.Secondary }));
      expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('data-tone', 'cream');
      expect(screen.getByRole('button', { name: 'Later' })).not.toHaveAttribute('data-tone');
    });

    it('makes none of several primaries cream: one cream button per surface', () => {
      show(row({ label: 'Ship', style: ButtonStyle.Primary }, { label: 'Hold', style: ButtonStyle.Primary }));
      expect(screen.getByRole('button', { name: 'Ship' })).toHaveAttribute('data-tone', 'primary');
      expect(screen.getByRole('button', { name: 'Hold' })).toHaveAttribute('data-tone', 'primary');
    });

    it('counts the primaries across every row of the message', () => {
      show([
        ...row({ label: 'One', style: ButtonStyle.Primary }),
        ...row({ label: 'Two', style: ButtonStyle.Primary }),
      ]);
      expect(document.querySelector('[data-tone="cream"]')).toBeNull();
    });

    it('gives success the same lit edge as a primary (Index has no green), danger the danger ink, a link its text', () => {
      show(row({ label: 'Done', style: ButtonStyle.Success }, { label: 'Delete', style: ButtonStyle.Danger }, { label: 'Docs', style: ButtonStyle.Link, url: 'https://example.com' }));
      expect(screen.getByRole('button', { name: 'Done' })).toHaveAttribute('data-tone', 'primary');
      expect(screen.getByRole('button', { name: 'Delete' })).toHaveAttribute('data-tone', 'danger');
      expect(screen.getByRole('button', { name: 'Docs' })).toHaveAttribute('data-tone', 'link');
    });

    it('shows a ring that turns while a click is on its way, and says it is busy', async () => {
      const user = userEvent.setup();
      let finish!: (value: unknown) => void;
      mocks.post.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      show(row({ label: 'Approve', style: ButtonStyle.Primary }));
      const button = screen.getByRole('button', { name: 'Approve' });
      await user.click(button);
      await waitFor(() => expect(button).toBeDisabled());
      expect(button).toHaveAttribute('aria-busy', 'true');
      expect(button.querySelector('.ix-bot-btn__busy')).not.toBeNull();
      finish({ data: { id: 'ix-1', guild_id: 'guild-1' } });
      await waitFor(() => expect(button).not.toBeDisabled());
      expect(button.querySelector('.ix-bot-btn__busy')).toBeNull();
    });
  });

  it('keeps a multi-select’s choices until Confirm, which sends them once', async () => {
    const user = userEvent.setup();
    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        guildId="guild-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.StringSelect,
                custom_id: 'days',
                placeholder: 'Pick the days',
                min_values: 1,
                max_values: 2,
                options: [
                  { label: 'Friday', value: 'fri' },
                  { label: 'Saturday', value: 'sat' },
                ],
              },
            ],
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pick the days' }));
    await user.click(screen.getByRole('button', { name: 'Friday' }));
    await user.click(screen.getByRole('button', { name: 'Saturday' }));
    expect(mocks.post).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm (2 selected)' }));
    await waitFor(() => {
      expect(mocks.post).toHaveBeenCalledWith(
        '/interactions',
        expect.objectContaining({ custom_id: 'days', values: ['fri', 'sat'] }),
      );
    });
  });

  it('blocks unsafe link button URLs instead of opening them', async () => {
    const user = userEvent.setup();

    render(
      <MessageComponents
        channelId="channel-1"
        messageId="message-1"
        components={[
          {
            type: ComponentType.ActionRow,
            components: [
              {
                type: ComponentType.Button,
                style: ButtonStyle.Link,
                label: 'Open dashboard',
                url: 'javascript:alert(1)',
              },
            ],
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Open dashboard' }));

    expect(window.open).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith('Blocked unsafe link button URL.');
  });
});

vi.mock('../../hooks/useChannels', async () => {
  const actual = await vi.importActual<typeof import('../../hooks/useChannels')>('../../hooks/useChannels');
  const { useChannelStore } = await import('../../stores/channelStore');
  return {
    ...actual,
    useCurrentChannelStore: useChannelStore,
    useChannelActions: () => useChannelStore.getState(),
    getAccountChannelView: () => useChannelStore.getState(),
    useGuildChannels: (id: string) => useChannelStore(state => state.channelsByGuild[id] ?? []),
  };
});

vi.mock('../../lib/channelView', async () => {
  const { useChannelStore } = await import('../../stores/channelStore');
  return { getAccountChannelView: () => useChannelStore.getState() };
});
