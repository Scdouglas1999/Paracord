import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildStorageApi } from '../../api/guildStorage';
import {
  olderServerReason,
  resetServerFeaturesForTests,
  serverLacks,
  useServerFeatureStore,
} from '../../lib/serverFeatures';
import { LOCAL_SERVER_ID } from '../../lib/serverScope';
import { FileStorageSection } from './FileStorageSection';

vi.mock('../../api/guildStorage', () => ({
  guildStorageApi: {
    getUsage: vi.fn(),
    listFiles: vi.fn(),
    updatePolicy: vi.fn(),
    deleteFiles: vi.fn(),
  },
}));

vi.mock('../../stores/confirmStore', () => ({ confirm: vi.fn() }));

const MB = 1024 * 1024;

function answer(usage: number, quota: number | null) {
  vi.mocked(guildStorageApi.getUsage).mockResolvedValue({ data: { usage, quota, policy: null } } as never);
  vi.mocked(guildStorageApi.listFiles).mockResolvedValue({ data: [] } as never);
}

function refused(status: number, data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, null, {
    status,
    statusText: String(status),
    headers: {},
    config,
    data,
  });
}

/** What the section must not draw for a server that has given no readout. */
function expectNoReadout() {
  expect(screen.queryByText('Storage used')).toBeNull();
  expect(screen.queryByText('0 B')).toBeNull();
  expect(screen.queryByText('no quota set')).toBeNull();
  expect(screen.queryByRole('progressbar')).toBeNull();
  expect(screen.queryByLabelText(/Storage quota/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Save policy' })).toBeNull();
  expect(screen.queryByText('No files stored yet')).toBeNull();
}

describe('FileStorageSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetServerFeaturesForTests();
  });

  // The usage meter's fill is a layer inside its track. Its track must own it: a
  // track that clips but is not the fill's containing block let the fill take the
  // whole settings window and draw a half circle over the index. jsdom has no
  // layout, so this holds the markup contract; the geometry is held by the Index
  // e2e (`index-settings-containment.spec.ts`).
  it('puts the quota meter in a track that owns its fill', async () => {
    answer(180 * MB, 500 * MB);
    render(<FileStorageSection guildId="guild-1" canManage />);

    const meter = await screen.findByRole('progressbar');
    expect(meter).toHaveClass('pc-meter');
    expect(meter).toHaveAttribute('aria-valuenow', '36');
    const fill = meter.querySelector('.pc-meter-fill');
    expect(fill).not.toBeNull();
    expect(fill?.parentElement).toBe(meter);
    expect((fill as HTMLElement).style.getPropertyValue('--pc-fill')).toBe('0.36');
  });

  it('draws no meter, and says so, when the server sets no quota', async () => {
    answer(41 * MB, null);
    render(<FileStorageSection guildId="guild-1" canManage />);

    expect(await screen.findByText('no quota set')).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  // The owner's server is an older build: its router answers a route it lacks with
  // an empty 404 (`isMissingRoute`). That is not "0 B stored, no quota".
  describe('on a server that has no storage routes (an empty 404)', () => {
    beforeEach(() => {
      vi.mocked(guildStorageApi.getUsage).mockRejectedValue(refused(404, ''));
      vi.mocked(guildStorageApi.listFiles).mockRejectedValue(refused(404, ''));
    });

    it('says the server is older, and draws no readout, form or empty list', async () => {
      render(<FileStorageSection guildId="guild-1" canManage />);

      expect(await screen.findByText(olderServerReason('fileStorage'))).toBeInTheDocument();
      expect(screen.getByTestId('file-storage-unavailable')).toBeInTheDocument();
      expect(screen.queryByText('Failed to load storage info')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expectNoReadout();
      expect(serverLacks(LOCAL_SERVER_ID, 'fileStorage')).toBe(true);
    });

    it('asks once: the next time the section opens it says so without a request', async () => {
      const first = render(<FileStorageSection guildId="guild-1" canManage />);
      await screen.findByTestId('file-storage-unavailable');
      first.unmount();
      vi.mocked(guildStorageApi.getUsage).mockClear();

      render(<FileStorageSection guildId="guild-1" canManage />);
      expect(screen.getByTestId('file-storage-unavailable')).toBeInTheDocument();
      await act(async () => {});
      expect(guildStorageApi.getUsage).not.toHaveBeenCalled();
      expectNoReadout();
    });

    it('reads the storage again once a reconnect forgets what the server lacked', async () => {
      render(<FileStorageSection guildId="guild-1" canManage />);
      await screen.findByTestId('file-storage-unavailable');

      answer(180 * MB, 500 * MB);
      act(() => useServerFeatureStore.getState().forget(LOCAL_SERVER_ID));

      expect(await screen.findByRole('progressbar')).toBeInTheDocument();
      expect(screen.queryByTestId('file-storage-unavailable')).toBeNull();
    });
  });

  it('keeps a refusal (403) a permission message, not an older server and not a readout', async () => {
    vi.mocked(guildStorageApi.getUsage).mockRejectedValue(refused(403, { code: 'MISSING_PERMISSIONS', message: 'Missing permissions' }));
    vi.mocked(guildStorageApi.listFiles).mockRejectedValue(refused(403, { code: 'MISSING_PERMISSIONS', message: 'Missing permissions' }));
    render(<FileStorageSection guildId="guild-1" canManage={false} />);

    expect(await screen.findByTestId('file-storage-forbidden')).toHaveTextContent('Manage Server permission');
    expect(screen.queryByTestId('file-storage-unavailable')).toBeNull();
    expect(serverLacks(LOCAL_SERVER_ID, 'fileStorage')).toBe(false);
    expectNoReadout();
  });

  it('keeps a 404 the route itself answered, and a server error, as errors with a way to try again', async () => {
    vi.mocked(guildStorageApi.getUsage).mockRejectedValue(refused(404, { code: 'NOT_FOUND', message: 'Unknown guild' }));
    vi.mocked(guildStorageApi.listFiles).mockResolvedValue({ data: [] } as never);
    render(<FileStorageSection guildId="guild-1" canManage />);

    expect(await screen.findByText('Unknown guild')).toBeInTheDocument();
    expect(screen.queryByTestId('file-storage-unavailable')).toBeNull();
    expect(serverLacks(LOCAL_SERVER_ID, 'fileStorage')).toBe(false);
    expectNoReadout();

    // The server recovers; Try again reads it.
    answer(41 * MB, null);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('no quota set')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('file-storage-failed')).toBeNull());
  });
});
