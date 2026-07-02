import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AxiosInstance } from 'axios';

const { legacyClientStub, activeClientStub, getActiveApiClient } = vi.hoisted(() => ({
  legacyClientStub: { __id: 'legacy' } as unknown as AxiosInstance,
  activeClientStub: { __id: 'active' } as unknown as AxiosInstance,
  getActiveApiClient: vi.fn<() => AxiosInstance | undefined>(),
}));

vi.mock('./client', () => ({
  apiClient: legacyClientStub,
}));

vi.mock('../lib/connectionManager', () => ({
  connectionManager: {
    getActiveApiClient,
  },
}));

import { getApi } from './activeClient';

describe('getApi() REST routing', () => {
  afterEach(() => {
    getActiveApiClient.mockReset();
  });

  it('returns the active server per-server client when one exists', () => {
    getActiveApiClient.mockReturnValue(activeClientStub);
    expect(getApi()).toBe(activeClientStub);
  });

  it('falls back to the LOCAL-only singleton when no active client exists', () => {
    getActiveApiClient.mockReturnValue(undefined);
    expect(getApi()).toBe(legacyClientStub);
  });

  it('resolves the active client at call time (not captured at module load)', () => {
    getActiveApiClient.mockReturnValueOnce(legacyClientStub);
    expect(getApi()).toBe(legacyClientStub);
    getActiveApiClient.mockReturnValueOnce(activeClientStub);
    expect(getApi()).toBe(activeClientStub);
  });
});
