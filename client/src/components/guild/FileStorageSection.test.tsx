import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { guildStorageApi } from '../../api/guildStorage';
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

describe('FileStorageSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
