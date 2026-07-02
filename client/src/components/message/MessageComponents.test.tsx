import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ButtonStyle, ComponentType } from '../../types/components';
import { MessageComponents } from './MessageComponents';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  getMembers: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('../../api/client', () => ({
  apiClient: { post: mocks.post },
  extractApiError: (err: unknown) => (err instanceof Error ? err.message : 'Unexpected failure'),
}));

vi.mock('../../api/guilds', () => ({
  guildApi: {
    getChannels: vi.fn(),
    getMembers: mocks.getMembers,
    getRoles: vi.fn(),
  },
}));

vi.mock('../../stores/channelStore', () => ({
  useChannelStore: (selector: (state: unknown) => unknown) =>
    selector({
      channelsByGuild: {
        'guild-1': [{ id: 'channel-1', type: 0, name: 'general', position: 0 }],
      },
    }),
}));

vi.mock('../../stores/toastStore', () => ({
  toast: {
    error: mocks.toastError,
  },
}));

describe('MessageComponents interaction feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
