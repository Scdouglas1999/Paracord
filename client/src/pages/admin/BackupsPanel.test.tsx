import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackupsPanel } from './BackupsPanel';

const mocks = vi.hoisted(() => ({ list: vi.fn(), prepare: vi.fn(), success: vi.fn(), error: vi.fn(), confirm: vi.fn() }));
vi.mock('../../api/admin', () => ({ adminApi: { listBackups: mocks.list, prepareRestore: mocks.prepare } }));
vi.mock('../../api/client', () => ({ extractApiError: (error: Error) => error.message }));
vi.mock('../../stores/toastStore', () => ({ toast: { success: mocks.success, error: mocks.error } }));
vi.mock('../../stores/confirmStore', () => ({ confirm: mocks.confirm }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ data: { backups: [{ name: 'saved.tar.gz', size_bytes: 100, created_at: '2026-09-12T00:00:00Z' }] } });
  mocks.prepare.mockResolvedValue({ data: { status: 'offline_restore_required', filename: 'saved.tar.gz', message: 'Verify a new recovery generation before activation.', command: 'paracord-server restore-backup --archive saved.tar.gz --output-dir new-recovery', postgres_argument: '--postgres-url-env RECOVERY_URL', steps: ['Retain the original configuration and keys.', 'Stop all old instances before activation.'] } });
});

describe('offline backup recovery', () => {
  it('shows instructions without offering a live destructive restore or claiming success', async () => {
    const user = userEvent.setup();
    render(<BackupsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Recovery instructions for saved.tar.gz' }));
    expect(await screen.findByRole('region', { name: 'Recovery instructions' })).toBeInTheDocument();
    expect(screen.getByText('Stop all old instances before activation.')).toBeInTheDocument();
    expect(mocks.prepare).toHaveBeenCalledWith('saved.tar.gz');
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.queryByText(/Backup restored/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download archive' })).toBeInTheDocument();
  });

  it('exposes preparation errors without a recovery success message', async () => {
    mocks.prepare.mockRejectedValue(new Error('Archive unavailable'));
    const user = userEvent.setup();
    render(<BackupsPanel />);
    await user.click(await screen.findByRole('button', { name: 'Recovery instructions for saved.tar.gz' }));
    expect(mocks.error).toHaveBeenCalledWith('Failed to load recovery instructions: Archive unavailable');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.queryByRole('region', { name: 'Recovery instructions' })).not.toBeInTheDocument();
  });
});
