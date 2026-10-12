import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useGlassStore } from '../../../stores/glassStore';
import { AddServerSheet } from './AddServerSheet';
import { closeAddServer, openAddServer, useAddServerStore } from './addServerStore';

const mocks = vi.hoisted(() => ({
  createGuild: vi.fn(),
  acceptInvite: vi.fn(),
  applyTemplate: vi.fn(),
  landing: vi.fn(),
  get: vi.fn(),
  closeSheets: vi.fn(),
}));

const scope = { serverId: '__local__', userId: 'user-1' };

vi.mock('../../../stores/guildStore', () => ({
  useGuildStore: { getState: () => ({ createGuild: mocks.createGuild, acceptInvite: mocks.acceptInvite, applyTemplate: mocks.applyTemplate }) },
}));
vi.mock('../../../lib/guildNavigation', () => ({ guildLandingPath: mocks.landing }));
vi.mock('../../../api/activeClient', () => ({ getApi: () => ({ get: mocks.get }) }));
vi.mock('../../../api/client', () => ({
  extractApiError: (error: { message?: string }) => error?.message || 'request failed',
}));
vi.mock('../../../hooks/useCurrentUser', () => ({
  useCurrentUser: () => ({ id: 'user-1', username: 'ada' }),
  useCurrentAccountScope: () => scope,
}));
vi.mock('../../../lib/security', () => ({ isAllowedImageMimeType: (type: string) => type.startsWith('image/') }));
// The frame is IX-9's: here a dialog that renders its children while open.
vi.mock('../../glass/sheets', () => ({
  SheetFrame: ({ open, label, title, children }: { open: boolean; label: string; title: string; children: React.ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={label}>
        <h2>{title}</h2>
        {children}
      </div>
    ) : null,
  closeSheets: mocks.closeSheets,
}));

const template = (id: string, name: string, description: string, channels: number, roles = 0) => ({
  id,
  name,
  description,
  creator_id: '1',
  source_guild_id: null,
  usage_count: 0,
  created_at: '2026-09-01T00:00:00Z',
  template_data: {
    channels: [
      { name: 'Category', type: 4, position: 0, parent_name: null },
      ...Array.from({ length: channels }, (_, i) => ({ name: `c${i}`, type: 0, position: i + 1, parent_name: 'Category' })),
    ],
    roles: Array.from({ length: roles }, (_, i) => ({ name: `r${i}`, permissions: '0', color: 0, position: i })),
  },
});

let here = '';
let go: (path: string) => void = () => {};
function Spy() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    here = pathname;
    go = (path) => navigate(path);
  });
  return null;
}

function mount(path = '/app/guilds/g1/channels/c1') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Spy />
      <AddServerSheet />
    </MemoryRouter>,
  );
}

const sheet = () => screen.getByRole('dialog', { name: 'Add a server' });
const open = (tab?: Parameters<typeof openAddServer>[0]) => act(() => openAddServer(tab));
/** Blank and both templates, once the list has arrived. */
const radios = async () => {
  await waitFor(() => expect(within(sheet()).getAllByRole('radio')).toHaveLength(3));
  return within(sheet()).getAllByRole('radio');
};

beforeEach(() => {
  vi.clearAllMocks();
  useAddServerStore.setState({ open: false, tab: 'create' });
  useGlassStore.getState().reset();
  mocks.get.mockResolvedValue({ data: [template('t1', 'Study group', 'Notes and questions.', 3, 1), template('t2', 'Game night', '', 1)] });
  mocks.createGuild.mockResolvedValue({ id: 'new-1', name: 'Ada HQ', scope });
  mocks.acceptInvite.mockResolvedValue({ id: 'joined-1', name: 'Joined', scope });
  mocks.applyTemplate.mockResolvedValue({ id: 'templated-1', name: 'Book club', scope });
  mocks.landing.mockImplementation(async (guild: { id: string }) => `/app/guilds/${guild.id}/channels/general`);
});

describe('opening', () => {
  it('draws nothing while closed, and a dialog named Add a server on Create when opened', () => {
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    expect(sheet()).toBeInTheDocument();
    expect(within(sheet()).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Create', 'Join', 'Discover']);
    expect(within(sheet()).getByRole('tab', { name: 'Create' })).toHaveAttribute('aria-selected', 'true');
  });

  it('opens on the page it is asked for, and always on Create when just toggled', () => {
    mount();
    open('join');
    expect(within(sheet()).getByRole('tab', { name: 'Join' })).toHaveAttribute('aria-selected', 'true');
    act(() => closeAddServer());
    act(() => useAddServerStore.getState().toggleSheet());
    expect(within(sheet()).getByRole('tab', { name: 'Create' })).toHaveAttribute('aria-selected', 'true');
  });

  it('puts any other sheet away when it opens (one sheet at a time)', () => {
    mount();
    open();
    expect(mocks.closeSheets).toHaveBeenCalled();
  });

  it('goes away when another sheet opens', () => {
    mount();
    open();
    act(() => useGlassStore.getState().openSheet('people'));
    expect(useAddServerStore.getState().open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('goes away when you move to another place or conversation, and not before', () => {
    mount();
    open();
    expect(useAddServerStore.getState().open).toBe(true);
    act(() => go('/app/guilds/g2/channels/c9'));
    expect(useAddServerStore.getState().open).toBe(false);
  });
});

describe('Create', () => {
  it('suggests a name, and creates a blank server with it, then lands on its channel', async () => {
    const user = userEvent.setup();
    mount();
    open();
    const name = within(sheet()).getByLabelText('Server name');
    expect(name).toHaveValue("ada's server");
    await user.clear(name);
    await user.type(name, 'Ada HQ');
    await user.click(within(sheet()).getByRole('button', { name: 'Create server' }));
    await waitFor(() => expect(mocks.createGuild).toHaveBeenCalledWith('Ada HQ', scope, undefined));
    expect(mocks.landing).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-1' }));
    await waitFor(() => expect(here).toBe('/app/guilds/new-1/channels/general'));
    expect(useAddServerStore.getState().open).toBe(false);
  });

  it('cannot create without a name', async () => {
    const user = userEvent.setup();
    mount();
    open();
    await user.clear(within(sheet()).getByLabelText('Server name'));
    expect(within(sheet()).getByRole('button', { name: 'Create server' })).toBeDisabled();
  });

  it('offers Blank first and then each template, with what it holds', async () => {
    mount();
    open();
    const options = await radios();
    expect(options.map((option) => option.querySelector('.ix-add__option-title')?.textContent)).toEqual(['Blank', 'Study group', 'Game night']);
    expect(options[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(sheet()).getByText('3 channels · 1 role')).toBeInTheDocument();
    // A template without a description says what it holds instead; categories are not channels.
    expect(within(sheet()).getByText('1 channel')).toBeInTheDocument();
    expect(mocks.get).toHaveBeenCalledWith('/templates', { signal: expect.any(AbortSignal) });
  });

  it('creates from the chosen template with the name given, and not through the blank route', async () => {
    const user = userEvent.setup();
    mount();
    open();
    const options = await radios();
    await user.click(options[1]);
    expect(options[1]).toHaveAttribute('aria-checked', 'true');
    expect(options[0]).toHaveAttribute('aria-checked', 'false');
    const name = within(sheet()).getByLabelText('Server name');
    await user.clear(name);
    await user.type(name, 'Book club');
    await user.click(within(sheet()).getByRole('button', { name: 'Create server' }));
    await waitFor(() => expect(mocks.applyTemplate).toHaveBeenCalledWith('t1', 'Book club', scope));
    expect(mocks.createGuild).not.toHaveBeenCalled();
    await waitFor(() => expect(here).toBe('/app/guilds/templated-1/channels/general'));
  });

  it('offers a picture for a blank server only, and sends it with the server', async () => {
    const user = userEvent.setup();
    mount();
    open();
    const options = await radios();
    expect(within(sheet()).getByText('Add a picture')).toBeInTheDocument();
    await user.click(options[1]);
    expect(within(sheet()).queryByText('Add a picture')).toBeNull();
    await user.click(options[0]);

    const file = new File(['x'], 'icon.png', { type: 'image/png' });
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    fireEvent.change(within(sheet()).getByLabelText('Picture'), { target: { files: [file] } });
    expect(await within(sheet()).findByText('Change picture')).toBeInTheDocument();
    await waitFor(() => expect(within(sheet()).getByRole('button', { name: 'Remove' })).toBeInTheDocument());
    await user.click(within(sheet()).getByRole('button', { name: 'Create server' }));
    await waitFor(() => expect(mocks.createGuild).toHaveBeenCalled());
    expect(mocks.createGuild.mock.calls[0][2]).toMatch(/^data:/);
  });

  it('refuses a file that is not a picture, in words', () => {
    mount();
    open();
    fireEvent.change(within(sheet()).getByLabelText('Picture'), { target: { files: [new File(['x'], 'notes.txt', { type: 'text/plain' })] } });
    expect(within(sheet()).getByRole('alert')).toHaveTextContent('Please upload PNG, JPG, GIF, or WEBP.');
  });

  it('says what went wrong and keeps the form when the server refuses', async () => {
    mocks.createGuild.mockRejectedValue(new Error('You have too many servers.'));
    const user = userEvent.setup();
    mount();
    open();
    await user.click(within(sheet()).getByRole('button', { name: 'Create server' }));
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('You have too many servers.');
    expect(within(sheet()).getByLabelText('Server name')).toHaveValue("ada's server");
    expect(useAddServerStore.getState().open).toBe(true);
    // Typing again clears it.
    await user.type(within(sheet()).getByLabelText('Server name'), '!');
    expect(within(sheet()).queryByRole('alert')).toBeNull();
  });

  it('says so, with a way to try again, when the templates cannot be loaded; Blank still works', async () => {
    mocks.get.mockRejectedValueOnce(new Error('Template service is offline.'));
    const user = userEvent.setup();
    mount();
    open();
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('Failed to load templates: Template service is offline.');
    expect(within(sheet()).getAllByRole('radio')).toHaveLength(1);
    await user.click(within(sheet()).getByRole('button', { name: 'Try again' }));
    expect(await within(sheet()).findAllByRole('radio')).toHaveLength(3);
    expect(mocks.get).toHaveBeenCalledTimes(2);
  });

  it('says there are none when the instance has no templates', async () => {
    mocks.get.mockResolvedValue({ data: [] });
    mount();
    open();
    expect(await within(sheet()).findByText(/Templates you save from a server/)).toBeInTheDocument();
  });
});

describe('Join', () => {
  it('reads a pasted link or a bare code, and lands on the server it joined', async () => {
    const user = userEvent.setup();
    mount();
    open('join');
    const join = within(sheet()).getByRole('button', { name: 'Join server' });
    expect(join).toBeDisabled();
    await user.type(within(sheet()).getByLabelText('Invite link'), `${window.location.origin}/invite/hTKzmak`);
    await user.click(join);
    await waitFor(() => expect(mocks.acceptInvite).toHaveBeenCalledWith('hTKzmak', scope));
    await waitFor(() => expect(here).toBe('/app/guilds/joined-1/channels/general'));
    expect(useAddServerStore.getState().open).toBe(false);
  });

  it('says so when what was pasted is neither a link nor a code', async () => {
    const user = userEvent.setup();
    mount();
    open('join');
    await user.type(within(sheet()).getByLabelText('Invite link'), 'https://chat.example.com/hTKzmak');
    await user.click(within(sheet()).getByRole('button', { name: 'Join server' }));
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('That is not an invite link or code.');
    expect(mocks.acceptInvite).not.toHaveBeenCalled();
  });

  it('takes the code alone, and Enter submits', async () => {
    const user = userEvent.setup();
    mount();
    open('join');
    await user.type(within(sheet()).getByLabelText('Invite link'), 'hTKzmak{Enter}');
    await waitFor(() => expect(mocks.acceptInvite).toHaveBeenCalledWith('hTKzmak', scope));
  });

  it('shows the refusal in words and leaves the invite where it was', async () => {
    mocks.acceptInvite.mockRejectedValue(new Error('That invite has expired.'));
    const user = userEvent.setup();
    mount();
    open('join');
    await user.type(within(sheet()).getByLabelText('Invite link'), 'old');
    await user.click(within(sheet()).getByRole('button', { name: 'Join server' }));
    expect(await within(sheet()).findByRole('alert')).toHaveTextContent('That invite has expired.');
    expect(within(sheet()).getByLabelText('Invite link')).toHaveValue('old');
    expect(here).toBe('/app/guilds/g1/channels/c1');
  });
});

describe('Discover', () => {
  it('opens the Discover page in main and puts the sheet away', async () => {
    const user = userEvent.setup();
    mount();
    open('discover');
    await user.click(within(sheet()).getByRole('button', { name: 'Discover servers' }));
    expect(here).toBe('/app/discovery');
    expect(useAddServerStore.getState().open).toBe(false);
  });
});

describe('the segmented control', () => {
  it('is a tablist: arrows, Home and End move between the three and select', async () => {
    const user = userEvent.setup();
    mount();
    open();
    const tab = (name: string) => within(sheet()).getByRole('tab', { name });
    tab('Create').focus();
    await user.keyboard('{ArrowRight}');
    expect(tab('Join')).toHaveFocus();
    expect(tab('Join')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('Discover')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowRight}');
    expect(tab('Create')).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{End}');
    expect(tab('Discover')).toHaveFocus();
    await user.keyboard('{Home}');
    expect(tab('Create')).toHaveFocus();
    // One Tab stop: the selected tab; the panel is named by it.
    expect(tab('Join')).toHaveAttribute('tabindex', '-1');
    expect(within(sheet()).getByRole('tabpanel')).toHaveAccessibleName('Create');
  });
});
