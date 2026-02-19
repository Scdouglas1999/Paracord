import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockToast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));

const mockGuildApi = vi.hoisted(() => ({
  getAll: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  leaveGuild: vi.fn(),
}));

vi.mock('./toastStore', () => ({ toast: mockToast }));
vi.mock('../api/guilds', () => ({ guildApi: mockGuildApi }));
vi.mock('../api/client', () => ({
  extractApiError: vi.fn((err: unknown) => {
    if (err instanceof Error) return err.message;
    return 'An unexpected error occurred';
  }),
}));
vi.mock('../lib/apiBaseUrl', () => ({
  resolveApiBaseUrl: () => 'http://localhost:8090/api/v1',
}));

import { useGuildStore } from './guildStore';

function makeGuild(overrides: Partial<{
  id: string;
  name: string;
  owner_id: string;
}> = {}) {
  return {
    id: 'g1',
    name: 'Test Server',
    owner_id: 'u1',
    member_count: 10,
    features: [],
    created_at: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('guildStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useGuildStore.setState({
      guilds: [],
      selectedGuildId: null,
      isLoading: false,
    });
  });

  it('has correct initial state', () => {
    const state = useGuildStore.getState();
    expect(state.guilds).toEqual([]);
    expect(state.selectedGuildId).toBeNull();
    expect(state.isLoading).toBe(false);
  });

  describe('fetchGuilds', () => {
    it('fetches and stores guilds', async () => {
      const guilds = [makeGuild({ id: 'g1' }), makeGuild({ id: 'g2', name: 'Other' })];
      mockGuildApi.getAll.mockResolvedValue({ data: guilds });

      await useGuildStore.getState().fetchGuilds();
      const state = useGuildStore.getState();
      expect(state.guilds).toEqual(
        guilds.map((g) => ({ ...g, server_url: 'http://localhost:8090/api/v1' }))
      );
      expect(state.isLoading).toBe(false);
    });

    it('sets isLoading during fetch', async () => {
      let resolveGet: (v: unknown) => void;
      mockGuildApi.getAll.mockImplementation(
        () => new Promise((resolve) => { resolveGet = resolve; }),
      );

      const promise = useGuildStore.getState().fetchGuilds();
      expect(useGuildStore.getState().isLoading).toBe(true);

      resolveGet!({ data: [] });
      await promise;
      expect(useGuildStore.getState().isLoading).toBe(false);
    });

    it('shows toast on failure', async () => {
      mockGuildApi.getAll.mockRejectedValue(new Error('fail'));

      await useGuildStore.getState().fetchGuilds();
      expect(mockToast.error).toHaveBeenCalled();
      expect(useGuildStore.getState().isLoading).toBe(false);
    });
  });

  describe('selectGuild', () => {
    it('selects a guild by id', () => {
      useGuildStore.getState().selectGuild('g1');
      expect(useGuildStore.getState().selectedGuildId).toBe('g1');
    });

    it('clears selection with null', () => {
      useGuildStore.getState().selectGuild('g1');
      useGuildStore.getState().selectGuild(null);
      expect(useGuildStore.getState().selectedGuildId).toBeNull();
    });
  });

  describe('createGuild', () => {
    it('creates a guild and adds it to the list', async () => {
      const newGuild = makeGuild({ id: 'g-new', name: 'New Server' });
      mockGuildApi.create.mockResolvedValue({ data: newGuild });

      const result = await useGuildStore.getState().createGuild('New Server');
      expect(result).toEqual({ ...newGuild, server_url: 'http://localhost:8090/api/v1' });
      expect(useGuildStore.getState().guilds).toHaveLength(1);
      expect(useGuildStore.getState().guilds[0].name).toBe('New Server');
    });

    it('creates a guild with icon', async () => {
      const newGuild = makeGuild({ id: 'g-new', name: 'Icon Server' });
      mockGuildApi.create.mockResolvedValue({ data: newGuild });

      await useGuildStore.getState().createGuild('Icon Server', 'data:image/png;base64,abc');
      expect(mockGuildApi.create).toHaveBeenCalledWith({
        name: 'Icon Server',
        icon: 'data:image/png;base64,abc',
      });
    });
  });

  describe('updateGuild', () => {
    it('updates a guild in the list', async () => {
      const guild = makeGuild({ id: 'g1', name: 'Old Name' });
      useGuildStore.setState({ guilds: [guild] });

      const updated = makeGuild({ id: 'g1', name: 'New Name' });
      mockGuildApi.update.mockResolvedValue({ data: updated });

      await useGuildStore.getState().updateGuild('g1', { name: 'New Name' });
      expect(useGuildStore.getState().guilds[0].name).toBe('New Name');
    });
  });

  describe('deleteGuild', () => {
    it('removes a guild from the list', async () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1' }), makeGuild({ id: 'g2' })],
      });
      mockGuildApi.delete.mockResolvedValue({});

      await useGuildStore.getState().deleteGuild('g1');
      expect(useGuildStore.getState().guilds).toHaveLength(1);
      expect(useGuildStore.getState().guilds[0].id).toBe('g2');
    });

    it('clears selectedGuildId if the deleted guild was selected', async () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1' })],
        selectedGuildId: 'g1',
      });
      mockGuildApi.delete.mockResolvedValue({});

      await useGuildStore.getState().deleteGuild('g1');
      expect(useGuildStore.getState().selectedGuildId).toBeNull();
    });

    it('keeps selectedGuildId if a different guild was deleted', async () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1' }), makeGuild({ id: 'g2' })],
        selectedGuildId: 'g1',
      });
      mockGuildApi.delete.mockResolvedValue({});

      await useGuildStore.getState().deleteGuild('g2');
      expect(useGuildStore.getState().selectedGuildId).toBe('g1');
    });
  });

  describe('leaveGuild', () => {
    it('removes the guild and clears selection if selected', async () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1' })],
        selectedGuildId: 'g1',
      });
      mockGuildApi.leaveGuild.mockResolvedValue({});

      await useGuildStore.getState().leaveGuild('g1');
      expect(useGuildStore.getState().guilds).toHaveLength(0);
      expect(useGuildStore.getState().selectedGuildId).toBeNull();
    });
  });

  describe('setGuilds', () => {
    it('sets the guilds array directly', () => {
      const guilds = [makeGuild({ id: 'g1' }), makeGuild({ id: 'g2' })];
      useGuildStore.getState().setGuilds(guilds);
      expect(useGuildStore.getState().guilds).toEqual(guilds);
    });
  });

  describe('addGuild (gateway handler)', () => {
    it('adds a new guild', () => {
      const guild = makeGuild({ id: 'g1' });
      useGuildStore.getState().addGuild(guild);
      expect(useGuildStore.getState().guilds).toHaveLength(1);
    });

    it('updates existing guild instead of duplicating', () => {
      const guild = makeGuild({ id: 'g1', name: 'Old' });
      useGuildStore.setState({ guilds: [guild] });

      useGuildStore.getState().addGuild(makeGuild({ id: 'g1', name: 'Updated' }));
      expect(useGuildStore.getState().guilds).toHaveLength(1);
      expect(useGuildStore.getState().guilds[0].name).toBe('Updated');
    });

    it('normalizes missing fields with defaults', () => {
      const partial = { id: 'g-new', name: 'Partial', owner_id: 'u1' } as any;
      useGuildStore.getState().addGuild(partial);
      const guild = useGuildStore.getState().guilds[0];
      expect(guild.member_count).toBe(0);
      expect(guild.features).toEqual([]);
      expect(guild.created_at).toBeDefined();
    });
  });

  describe('removeGuild (gateway handler)', () => {
    it('removes a guild by id', () => {
      useGuildStore.setState({ guilds: [makeGuild({ id: 'g1' })] });
      useGuildStore.getState().removeGuild('g1');
      expect(useGuildStore.getState().guilds).toHaveLength(0);
    });

    it('clears selection if removed guild was selected', () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1' })],
        selectedGuildId: 'g1',
      });
      useGuildStore.getState().removeGuild('g1');
      expect(useGuildStore.getState().selectedGuildId).toBeNull();
    });
  });

  describe('updateGuildData (gateway handler)', () => {
    it('merges partial data into the guild', () => {
      useGuildStore.setState({ guilds: [makeGuild({ id: 'g1', name: 'Old' })] });
      useGuildStore.getState().updateGuildData('g1', { name: 'Renamed' });
      expect(useGuildStore.getState().guilds[0].name).toBe('Renamed');
    });

    it('does not change other guilds', () => {
      useGuildStore.setState({
        guilds: [makeGuild({ id: 'g1', name: 'A' }), makeGuild({ id: 'g2', name: 'B' })],
      });
      useGuildStore.getState().updateGuildData('g1', { name: 'Changed' });
      expect(useGuildStore.getState().guilds[1].name).toBe('B');
    });
  });
});
