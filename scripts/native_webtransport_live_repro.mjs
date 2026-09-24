#!/usr/bin/env node

/**
 * Live repro harness for browser-native WebTransport voice connect.
 *
 * Usage (PowerShell):
 *   $env:PARACORD_URL="https://server.example"
 *   $env:PARACORD_USER="test-user"
 *   $env:PARACORD_PASS="<test-password>"
 *   node scripts/native_webtransport_live_repro.mjs
 *
 * Optional:
 *   $env:PARACORD_BROWSER="firefox"   # firefox | chromium (default: firefox)
 *   $env:PARACORD_GUILD_ID="..."
 *   $env:PARACORD_CHANNEL_ID="..."    # voice channel id
 */

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const playwrightPath = path.resolve(__dirname, '../client/node_modules/playwright/index.mjs');
const { firefox, chromium, request: pwRequest } = await import(pathToFileURL(playwrightPath).href);

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function normalizeBaseUrl(raw) {
  return raw.replace(/\/+$/, '');
}

function pickVoiceChannel(channels) {
  return channels.find((c) => Number(c?.type) === 2 || Number(c?.channel_type) === 2) ?? null;
}

function withMediaPath(base) {
  const url = new URL(base);
  url.pathname = '/media';
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function main() {
  const baseUrl = normalizeBaseUrl(requiredEnv('PARACORD_URL'));
  const username = requiredEnv('PARACORD_USER');
  const password = requiredEnv('PARACORD_PASS');
  const browserName = (process.env.PARACORD_BROWSER ?? 'firefox').trim().toLowerCase();
  const forcedGuildId = process.env.PARACORD_GUILD_ID?.trim() || null;
  const forcedChannelId = process.env.PARACORD_CHANNEL_ID?.trim() || null;

  const api = await pwRequest.newContext({
    baseURL: baseUrl,
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: {
      'content-type': 'application/json',
    },
  });

  let browser;
  let joinedSession;
  try {
    const loginResp = await api.post('/api/v1/auth/login', {
      data: {
        email: username,
        password,
      },
    });
    if (!loginResp.ok()) {
      const body = await loginResp.text();
      throw new Error(`Login failed (${loginResp.status()}): ${body}`);
    }
    const loginData = await loginResp.json();
    const token = loginData?.token;
    if (!token || typeof token !== 'string') {
      throw new Error('Login response missing token');
    }

    const csrf = (await api.storageState()).cookies.find((cookie) => cookie.name === 'paracord_csrf')?.value;
    const authHeaders = {
      authorization: `Bearer ${token}`,
      ...(csrf ? { 'x-paracord-csrf': csrf } : {}),
    };

    const guildId = forcedGuildId ?? await (async () => {
      const guildsResp = await api.get('/api/v1/users/@me/guilds', { headers: authHeaders });
      if (!guildsResp.ok()) {
        throw new Error(`GET /users/@me/guilds failed (${guildsResp.status()})`);
      }
      const guilds = await guildsResp.json();
      if (!Array.isArray(guilds) || guilds.length === 0) {
        throw new Error('No guilds available for authenticated user');
      }
      return String(guilds[0].id);
    })();

    const channelId = forcedChannelId ?? await (async () => {
      const channelsResp = await api.get(`/api/v1/guilds/${guildId}/channels`, { headers: authHeaders });
      if (!channelsResp.ok()) {
        throw new Error(`GET /guilds/${guildId}/channels failed (${channelsResp.status()})`);
      }
      const channels = await channelsResp.json();
      if (!Array.isArray(channels) || channels.length === 0) {
        throw new Error(`No channels returned for guild ${guildId}`);
      }
      const voice = pickVoiceChannel(channels);
      if (!voice?.id) {
        throw new Error(`No voice channel found in guild ${guildId}`);
      }
      return String(voice.id);
    })();

    const joinResp = await api.post(`/api/v2/voice/${channelId}/join`, {
      headers: authHeaders,
    });
    if (!joinResp.ok()) {
      const body = await joinResp.text();
      throw new Error(`Voice join failed (${joinResp.status()}): ${body}`);
    }
    const join = await joinResp.json();
    joinedSession = { channelId, sessionId: join?.session_id, headers: authHeaders };
    const mediaEndpoint = join?.media_endpoint;
    const mediaEndpointCandidates = Array.isArray(join?.media_endpoint_candidates)
      ? join.media_endpoint_candidates.filter((value) => typeof value === 'string' && value.trim().length > 0)
      : [];
    const mediaToken = join?.media_token;
    const certHash = typeof join?.cert_hash === 'string' ? join.cert_hash : '';

    if (!join?.native_media) {
      throw new Error('Join response is not native_media=true');
    }
    if (!mediaEndpoint || !mediaToken) {
      throw new Error('Join response missing media endpoint/token');
    }

    if (browserName === 'chromium') {
      browser = await chromium.launch({ headless: true });
    } else {
      browser = await firefox.launch({ headless: true });
    }
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

    const defaultOriginMediaEndpoint = withMediaPath(baseUrl);
    const extraEndpoints = (process.env.PARACORD_EXTRA_MEDIA_ENDPOINTS ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    const endpointsToTry = Array.from(
      new Set([...mediaEndpointCandidates, mediaEndpoint, defaultOriginMediaEndpoint, ...extraEndpoints]),
    );

    const wtAttempts = [];
    for (const endpoint of endpointsToTry) {
      const attempt = await page.evaluate(
        async ({ endpoint, token, certHash }) => {
        const result = {
          browser: navigator.userAgent,
          endpoint,
          steps: [],
        };
        if (typeof WebTransport === 'undefined') {
          return {
            ok: false,
            ...result,
            error: {
              name: 'NotSupportedError',
              message: 'WebTransport API is unavailable in this browser context',
            },
          };
        }

        let transport;
        let reader;
        let writer;
        const deadline = Date.now() + 10000;
        async function beforeDeadline(promise) {
          let timer;
          try {
            return await Promise.race([
              promise,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('WebTransport authentication timed out')), Math.max(0, deadline - Date.now()));
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
        }
        try {
          const options = certHash
            ? {
                serverCertificateHashes: [
                  {
                    algorithm: 'sha-256',
                    value: Uint8Array.from(atob(certHash), (c) => c.charCodeAt(0)),
                  },
                ],
              }
            : undefined;
          transport = new WebTransport(endpoint, options);
          // A failed or deliberately closed connection must not create an
          // unhandled rejection while the bounded readiness/auth check runs.
          transport.closed.catch(() => {});
          result.steps.push('constructed');
          await beforeDeadline(transport.ready);
          result.steps.push('ready');

          const stream = await beforeDeadline(transport.createBidirectionalStream());
          result.steps.push('bidi_opened');
          writer = stream.writable.getWriter();
          const payload = new TextEncoder().encode(JSON.stringify({ type: 'auth', token }));
          const frame = new Uint8Array(4 + payload.length);
          new DataView(frame.buffer).setUint32(0, payload.length, false);
          frame.set(payload, 4);
          await beforeDeadline(writer.write(frame));
          writer.releaseLock();
          writer = undefined;
          result.steps.push('auth_sent');

          reader = stream.readable.getReader();
          let buffered = new Uint8Array(0);
          let expected;
          while (expected === undefined || buffered.length < 4 + expected) {
            const { done, value } = await beforeDeadline(reader.read());
            if (done) throw new Error('Connection closed before authentication acknowledgment');
            if (buffered.length + value.length > 4 + 256 * 1024) {
              throw new Error('Authentication acknowledgment exceeds control frame limit');
            }
            const combined = new Uint8Array(buffered.length + value.length);
            combined.set(buffered);
            combined.set(value, buffered.length);
            buffered = combined;
            if (expected === undefined && buffered.length >= 4) {
              expected = new DataView(buffered.buffer).getUint32(0, false);
              if (expected === 0 || expected > 256 * 1024) {
                throw new Error('Invalid authentication acknowledgment frame size');
              }
            }
          }
          const acknowledgment = JSON.parse(new TextDecoder().decode(buffered.subarray(4, 4 + expected)));
          if (acknowledgment?.type !== 'pong') {
            throw new Error('Server did not acknowledge authenticated transport');
          }
          result.steps.push('authenticated');
          return { ok: true, ...result, authResponse: acknowledgment.type };
        } catch (err) {
          return {
            ok: false,
            ...result,
            error: {
              name: err?.name ?? 'Error',
              message: err?.message ?? String(err),
            },
          };
        } finally {
          if (writer) writer.abort().catch(() => {});
          if (reader) reader.cancel().catch(() => {});
          transport?.close({ closeCode: 0, reason: 'repro done' });
        }
        },
        { endpoint, token: mediaToken, certHash },
      );
      wtAttempts.push(attempt);
      if (attempt.ok) {
        break;
      }
    }
    const wtResult = wtAttempts[wtAttempts.length - 1] ?? null;
    if (!wtAttempts.some((attempt) => attempt.ok)) process.exitCode = 1;

    console.log(
      JSON.stringify(
        {
          ok: Boolean(wtAttempts.find((a) => a.ok)),
          server: baseUrl,
          guildId,
          channelId,
          nativeMedia: true,
          mediaEndpoint,
          mediaEndpointCandidates,
          endpointsTried: endpointsToTry,
          certHashPresent: Boolean(certHash),
          browser: browserName,
          attempts: wtAttempts,
          result: wtResult,
        },
        null,
        2,
      ),
    );
  } finally {
    if (joinedSession?.sessionId) {
      const { channelId, sessionId, headers } = joinedSession;
      await api.post(`/api/v2/voice/${channelId}/leave?session_id=${encodeURIComponent(sessionId)}`, { headers }).catch(() => {});
    }
    if (browser) {
      await browser.close().catch(() => {});
    }
    await api.dispose().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
