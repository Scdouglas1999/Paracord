#!/usr/bin/env node

/**
 * Live repro harness for browser-native WebTransport voice connect.
 *
 * Usage (PowerShell):
 *   $env:PARACORD_URL="https://173.62.236.246:8443"
 *   $env:PARACORD_USER="Scdouglas"
 *   $env:PARACORD_PASS="KIC8462852"
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

    const authHeaders = {
      authorization: `Bearer ${token}`,
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
    const mediaEndpoint = join?.media_endpoint;
    const mediaEndpointCandidates = Array.isArray(join?.media_endpoint_candidates)
      ? join.media_endpoint_candidates.filter((value) => typeof value === 'string' && value.trim().length > 0)
      : [];
    const mediaToken = join?.media_token;
    const certHash = typeof join?.cert_hash === 'string' ? join.cert_hash : '';

    if (!join?.native_media) {
      throw new Error(`Join response is not native_media=true: ${JSON.stringify(join)}`);
    }
    if (!mediaEndpoint || !mediaToken) {
      throw new Error(`Join response missing media endpoint/token: ${JSON.stringify(join)}`);
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
          const transport = new WebTransport(endpoint, options);
          result.steps.push('constructed');

          await transport.ready;
          result.steps.push('ready');

          const stream = await transport.createBidirectionalStream();
          result.steps.push('bidi_opened');

          const writer = stream.writable.getWriter();
          const payload = JSON.stringify({ type: 'auth', token }) + '\n';
          await writer.write(new TextEncoder().encode(payload));
          writer.releaseLock();
          result.steps.push('auth_sent');

          const reader = stream.readable.getReader();
          const first = await Promise.race([
            reader.read(),
            new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 8000)),
          ]);
          if (first && first.timeout) {
            return {
              ok: false,
              ...result,
              error: { name: 'TimeoutError', message: 'Timed out waiting for auth response' },
            };
          }

          const value = first?.value ? new TextDecoder().decode(first.value) : '';
          result.steps.push('auth_response_received');

          transport.close({ closeCode: 0, reason: 'repro done' });
          return {
            ok: true,
            ...result,
            authResponse: value.trim(),
          };
        } catch (err) {
          return {
            ok: false,
            ...result,
            error: {
              name: err?.name ?? 'Error',
              message: err?.message ?? String(err),
            },
          };
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
