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
