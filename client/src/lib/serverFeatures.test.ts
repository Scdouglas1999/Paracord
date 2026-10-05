import { AxiosError, AxiosHeaders } from 'axios';
import { beforeEach, describe, expect, it } from 'vitest';

import { isMissingRoute } from '../api/client';
import {
  noteMissingRoute,
  OlderServerError,
  olderServerReason,
  resetServerFeaturesForTests,
  serverLacks,
  useServerFeatureStore,
} from './serverFeatures';

function axios404(data: unknown): AxiosError {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', config, null, {
    status: 404, statusText: 'Not Found', headers: {}, config, data,
  });
}

beforeEach(() => resetServerFeaturesForTests());

describe('isMissingRoute', () => {
  it('is a 404 with an empty body: the route does not exist on that server', () => {
    expect(isMissingRoute(axios404(''))).toBe(true);
    expect(isMissingRoute(axios404(undefined))).toBe(true);
    expect(isMissingRoute(axios404(null))).toBe(true);
  });

  it('is never a 404 the route itself answered, nor another status or error', () => {
    expect(isMissingRoute(axios404({ code: 'NOT_FOUND', message: 'Unknown channel' }))).toBe(false);
    expect(isMissingRoute(axios404('Not found'))).toBe(false);
    expect(isMissingRoute(new Error('boom'))).toBe(false);
    expect(isMissingRoute({ response: { status: 404, data: '' } })).toBe(false);
  });
});

describe('the older-server record', () => {
  it('records a missing route per server, and only that', () => {
    expect(noteMissingRoute('A', 'voiceViews', axios404(''))).toBe(true);
    expect(noteMissingRoute('A', 'reminders', axios404({ message: 'no' }))).toBe(false);
    expect(noteMissingRoute(null, 'reminders', axios404(''))).toBe(false);
    expect(serverLacks('A', 'voiceViews')).toBe(true);
    expect(serverLacks('A', 'reminders')).toBe(false);
    expect(serverLacks('B', 'voiceViews')).toBe(false);
  });

  it('forgets a server when it reconnects (it may have been updated)', () => {
    useServerFeatureStore.getState().markMissing('A', 'listenIn');
    useServerFeatureStore.getState().markMissing('B', 'listenIn');
    useServerFeatureStore.getState().forget('A');
    expect(serverLacks('A', 'listenIn')).toBe(false);
    expect(serverLacks('B', 'listenIn')).toBe(true);
  });

  it('says what is missing and what to do', () => {
    expect(new OlderServerError('voiceViews').message).toBe(olderServerReason('voiceViews'));
    expect(olderServerReason('voiceViews')).toMatch(/older version of Paracord\. Join the call to watch\.$/);
  });
});
