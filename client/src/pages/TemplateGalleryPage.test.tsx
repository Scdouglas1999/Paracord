import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { templateApi, type GuildTemplate } from '../api/templates';
import { useAuthStore } from '../stores/authStore';
import { useChannelStore } from '../stores/channelStore';
import { useGuildStore } from '../stores/guildStore';
import { confirm } from '../stores/confirmStore';
import { TemplateGalleryPage } from './TemplateGalleryPage';

vi.mock('../api/templates', () => ({
  templateApi: {
    list: vi.fn(),
    apply: vi.fn(),
    remove: vi.fn(),
    createFromGuild: vi.fn(),
  },
}));

vi.mock('../stores/confirmStore', () => ({
  confirm: vi.fn(),
}));

const currentUser = {
  id: 'user-1',
  username: 'Ada',
  discriminator: 1,
  flags: 0,
  bot: false,
  system: false,
  created_at: '2026-05-17T00:00:00Z',
};

const ownedGuild = {
  id: 'guild-1',
  name: 'Owned Guild',
  owner_id: 'user-1',
  member_count: 4,
  features: [],
  created_at: '2026-05-17T00:00:00Z',
};

const otherGuild = {
  id: 'guild-2',
  name: 'Other Guild',
  owner_id: 'user-2',
  member_count: 8,
  features: [],
  created_at: '2026-05-17T00:00:00Z',
};

const template: GuildTemplate = {
  id: 'tpl-1',
  name: 'Ops Template',
  description: 'Incident response channels.',
  creator_id: 'user-1',
  source_guild_id: 'guild-1',
  usage_count: 2,
  created_at: '2026-05-17T00:00:00Z',
  template_data: {
    channels: [
      { name: 'war-room', type: 2, position: 2, parent_name: null },
      { name: 'announcements', type: 5, position: 1, parent_name: null },
    ],
    roles: [{ name: 'Moderator', permissions: '8', color: 0, position: 1 }],
  },
};

const secondTemplate: GuildTemplate = {
  ...template,
  id: 'tpl-2',
  name: 'Launch Template',
  creator_id: 'user-2',
  source_guild_id: null,
  usage_count: 0,
  template_data: {
    channels: [{ name: 'launch-chat', type: 0, position: 0, parent_name: null }],
    roles: [],
  },
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={['/app/templates']}>
      <Routes>
        <Route path="/app/templates" element={<TemplateGalleryPage />} />
        <Route path="/app/guilds/:guildId" element={<div>Created server route</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('TemplateGalleryPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(templateApi.list).mockResolvedValue({ data: [template] } as never);
    vi.mocked(templateApi.apply).mockResolvedValue({
      data: {
        id: 'guild-new',
        name: 'Launch HQ',
        owner_id: 'user-1',
        member_count: 1,
        features: [],
        created_at: '2026-05-17T00:00:00Z',
      },
    } as never);
    vi.mocked(templateApi.createFromGuild).mockResolvedValue({ data: template } as never);
    vi.mocked(templateApi.remove).mockResolvedValue({ data: {} } as never);
    vi.mocked(confirm).mockResolvedValue(true);
    useAuthStore.setState({ user: currentUser });
    useGuildStore.setState({ guilds: [ownedGuild, otherGuild] });
    useChannelStore.setState({
      channelsByGuild: {},
      channelsById: {},
      channels: [],
      guildChannelsLoaded: {},
      fetchChannels: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('renders template details and creates a server from the selected template', async () => {
    const user = userEvent.setup();

    renderPage();

    expect(await screen.findByRole('button', { name: 'View template Ops Template' })).toBeInTheDocument();
    expect(screen.getByText('2 channels | 1 roles')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Ops Template' })).toBeInTheDocument();
    expect(screen.getByText('Incident response channels.')).toBeInTheDocument();
    expect(screen.getByText('announcements')).toBeInTheDocument();
    expect(screen.getByText('Announcement')).toBeInTheDocument();
    expect(screen.getByText('Voice')).toBeInTheDocument();
    expect(screen.getByText('Moderator')).toBeInTheDocument();
    expect(screen.getByText('Used 2 times')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('New server name'));
    await user.type(screen.getByLabelText('New server name'), 'Launch HQ');
    await user.click(screen.getByRole('button', { name: 'Create From Template' }));

    await waitFor(() => {
      expect(templateApi.apply).toHaveBeenCalledWith('tpl-1', 'Launch HQ');
    });
    expect(useChannelStore.getState().fetchChannels).toHaveBeenCalledWith('guild-new');
    expect(await screen.findByText('Created server route')).toBeInTheDocument();
    expect(useGuildStore.getState().guilds.some((guild) => guild.id === 'guild-new')).toBe(true);
  });

  it('creates a template from an owned guild and deletes owned templates after confirmation', async () => {
    const user = userEvent.setup();
    vi.mocked(templateApi.list)
      .mockResolvedValueOnce({ data: [template] } as never)
      .mockResolvedValueOnce({ data: [template] } as never)
      .mockResolvedValueOnce({ data: [] } as never);

    renderPage();

    await screen.findByRole('button', { name: 'View template Ops Template' });
    expect(screen.getByLabelText('Source guild')).toHaveValue('guild-1');
    expect(screen.queryByText('Other Guild')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create Template' }));

    await waitFor(() => {
      expect(templateApi.createFromGuild).toHaveBeenCalledWith('guild-1');
    });
    expect(templateApi.list).toHaveBeenCalledTimes(2);

    await user.click(screen.getByRole('button', { name: 'Delete template Ops Template' }));

    await waitFor(() => {
      expect(confirm).toHaveBeenCalledWith({
        title: 'Delete template?',
        description: 'This permanently removes the template from the gallery.',
        confirmLabel: 'Delete template',
        variant: 'danger',
      });
      expect(templateApi.remove).toHaveBeenCalledWith('tpl-1');
    });
    expect(await screen.findByText("You haven't saved a template yet")).toBeInTheDocument();
  });

  it('keeps selection valid after deleting a selected template', async () => {
    const user = userEvent.setup();
    vi.mocked(templateApi.list)
      .mockResolvedValueOnce({ data: [template, secondTemplate] } as never)
      .mockResolvedValueOnce({ data: [secondTemplate] } as never);

    renderPage();

    await screen.findByRole('button', { name: 'View template Ops Template' });
    await user.click(screen.getByRole('button', { name: 'Delete template Ops Template' }));

    await waitFor(() => {
      expect(templateApi.remove).toHaveBeenCalledWith('tpl-1');
    });
    expect(await screen.findByRole('heading', { name: 'Launch Template' })).toBeInTheDocument();
    expect(screen.getByText('launch-chat')).toBeInTheDocument();
    expect(screen.queryByText('Select a template to view details.')).not.toBeInTheDocument();
  });

  it('shows concrete action errors for apply, create, and delete failures', async () => {
    const user = userEvent.setup();
    vi.mocked(templateApi.apply).mockRejectedValueOnce(new Error('template quota reached'));
    vi.mocked(templateApi.createFromGuild).mockRejectedValueOnce(new Error('source guild unavailable'));
    vi.mocked(templateApi.remove).mockRejectedValueOnce(new Error('delete denied'));

    renderPage();

    await screen.findByRole('button', { name: 'View template Ops Template' });
    await user.clear(screen.getByLabelText('New server name'));
    await user.type(screen.getByLabelText('New server name'), 'Launch HQ');
    await user.click(screen.getByRole('button', { name: 'Create From Template' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('template quota reached');

    await user.click(screen.getByRole('button', { name: 'Create Template' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('source guild unavailable');

    await user.click(screen.getByRole('button', { name: 'Delete template Ops Template' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('delete denied');
  });

  it('shows a retryable load error when templates cannot be fetched', async () => {
    vi.mocked(templateApi.list).mockRejectedValue(new Error('network down'));

    renderPage();

    expect(await screen.findByRole('alert')).toHaveTextContent('network down');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
