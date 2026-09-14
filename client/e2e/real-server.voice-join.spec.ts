import { resolve } from 'node:path';
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Locator,
  type Page,
} from '@playwright/test';

// The end-to-end proof that a *browser* can hold a call on the native media
// transport. Nothing here is mocked or stubbed: Chromium loads the embedded UI
// out of the release binary, joins a real guild voice room through
// `BrowserMediaEngine`, opens a real WebTransport session to the release
// binary's QUIC media port, and publishes real (fake-device) Opus audio, which
// the relay counts.
//
// It asserts four separate things, because each one has failed on its own:
//
//   1. the UI reaches a connected call and reports no error;
//   2. the *server* agrees — the relay names this account as a live participant
//      of the room, on the `webtransport` path, under the same media-session
//      receipt the REST join issued;
//   3. audio actually moved — the relay's cumulative per-connection counters
//      show audio datagrams arriving from this user (a joined-but-silent call
//      passes 1 and 2 and fails here);
//   4. leaving retires the connection.
//
// Assertion 3 is the one that catches WebTransport stream/datagram framing:
// before it, the browser's auth stream arrived with its HTTP/3
// `WEBTRANSPORT_STREAM` header in front of the length prefix and the session
// never authenticated at all.

const PORT = process.env.PARACORD_E2E_PORT ?? '18150';
const BASE = `http://127.0.0.1:${PORT}`;

// Joining runs a real handshake, a real getUserMedia, a WebCodecs Opus encoder
// and an AudioWorklet before the first packet leaves, and the relay counters are
// then polled. Give the whole journey room on a cold runner.
test.setTimeout(180_000);

function shotPath(name: string): string {
  // Playwright runs with `client/` as the working directory.
  return resolve(process.cwd(), '..', 'output', 'improvement-program', 'browser-voice-join', name);
}

const MEDIA_LAUNCH_ARGS = [
  // A deterministic 440 Hz tone and a moving colour pattern, auto-granted, so
  // neither the microphone nor the camera step depends on the runner having
  // hardware.
  '--use-fake-device-for-media-stream',
  '--use-fake-ui-for-media-stream',
  '--autoplay-policy=no-user-gesture-required',
  // `getDisplayMedia` has no picker to click in a headless browser: these take
  // the asking tab, which is the closest thing to a real share available here
  // and gives a genuinely changing picture (the Paracord UI itself).
  '--auto-accept-this-tab-capture',
  '--auto-select-desktop-capture-source=Entire screen',
];

type PlaywrightFixture = {
  chromium: { launch: (options: { args: string[] }) => Promise<Browser> };
};

/**
 * Count the three things that have to happen for somebody to actually be heard:
 * an `AudioDecoder` is built for a remote participant, it emits decoded frames,
 * and each one is played through an `AudioBufferSourceNode`.
 *
 * Installed before the app boots. Headless Chromium has no output device, so
 * this is the only honest way to assert playback: a call once connected,
 * counted audio at the relay, read every forwarded datagram and decoded not one
 * of them, and every relay-side assertion in this file passed while it did.
 */
const AUDIO_PROBE = () => {
  const probe = { decoders: 0, decodedFrames: 0, buffers: 0, starts: 0 };
  (window as unknown as { __paracordAudioProbe: typeof probe }).__paracordAudioProbe = probe;

  const NativeAudioDecoder = (window as unknown as { AudioDecoder?: typeof AudioDecoder })
    .AudioDecoder;
  if (NativeAudioDecoder) {
    (window as unknown as { AudioDecoder: unknown }).AudioDecoder = class extends (
      NativeAudioDecoder
    ) {
      constructor(init: AudioDecoderInit) {
        super({
          ...init,
          output: (frame: AudioData) => {
            probe.decodedFrames += 1;
            init.output(frame);
          },
        });
        probe.decoders += 1;
      }
    };
  }

  const createBuffer = AudioContext.prototype.createBuffer;
  AudioContext.prototype.createBuffer = function patchedCreateBuffer(
    this: AudioContext,
    ...args: Parameters<AudioContext['createBuffer']>
  ) {
    probe.buffers += 1;
    return createBuffer.apply(this, args);
  };

  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function patchedStart(
    this: AudioBufferSourceNode,
    ...args: Parameters<AudioBufferSourceNode['start']>
  ) {
    probe.starts += 1;
    return start.apply(this, args);
  };
};

interface AudioProbe {
  decoders: number;
  decodedFrames: number;
  buffers: number;
  starts: number;
}

async function readAudioProbe(page: Page): Promise<AudioProbe> {
  return page.evaluate(
    () =>
      (window as unknown as { __paracordAudioProbe?: AudioProbe }).__paracordAudioProbe ?? {
        decoders: 0,
        decodedFrames: 0,
        buffers: 0,
        starts: 0,
      },
  );
}

/** Poll until both pages are audibly playing the other, or fail saying what stalled. */
async function waitForAudiblePlayback(
  pages: Array<{ label: string; page: Page }>,
  minimumFrames: number,
  timeoutMs = 45_000,
): Promise<Map<string, AudioProbe>> {
  const deadline = Date.now() + timeoutMs;
  let latest = new Map<string, AudioProbe>();
  for (;;) {
    latest = new Map(
      await Promise.all(
        pages.map(async ({ label, page }) => [label, await readAudioProbe(page)] as const),
      ),
    );
    if (
      Array.from(latest.values()).every(
        (probe) => probe.decodedFrames >= minimumFrames && probe.starts >= minimumFrames,
      )
    ) {
      return latest;
    }
    if (Date.now() > deadline) {
      const detail = Array.from(latest.entries())
        .map(
          ([label, probe]) =>
            `${label}: decoders=${probe.decoders} decodedFrames=${probe.decodedFrames} buffers=${probe.buffers} starts=${probe.starts}`,
        )
        .join('; ');
      throw new Error(`remote audio was never decoded and played (${detail})`);
    }
    await pages[0].page.waitForTimeout(500);
  }
}

/**
 * The same standard, one layer up: count the `VideoDecoder`s this page builds
 * and the frames they actually emit.
 *
 * This is the assertion the first two QA passes did not make, and the one that
 * caught the blocker. A publisher's camera and screen share were counted at the
 * relay in their thousands of datagrams, the sidebar said "X is on camera", and
 * the receiving browser built 346 `VideoDecoder`s that between them decoded
 * **zero** frames — because a VP9 decoder cannot emit anything until it has a
 * keyframe, and keyframes ride reliable unidirectional streams that the server
 * was never accepting.
 */
const VIDEO_PROBE = () => {
  const probe = {
    decoders: 0,
    decodedFrames: 0,
    keyChunks: 0,
    deltaChunks: 0,
    errors: 0,
  };
  (window as unknown as { __paracordVideoProbe: typeof probe }).__paracordVideoProbe = probe;

  const NativeVideoDecoder = (window as unknown as { VideoDecoder?: typeof VideoDecoder })
    .VideoDecoder;
  if (!NativeVideoDecoder) return;
  const nativeDecode = NativeVideoDecoder.prototype.decode;
  NativeVideoDecoder.prototype.decode = function patchedDecode(
    this: VideoDecoder,
    chunk: EncodedVideoChunk,
  ) {
    if (chunk.type === 'key') probe.keyChunks += 1;
    else probe.deltaChunks += 1;
    return nativeDecode.call(this, chunk);
  };
  (window as unknown as { VideoDecoder: unknown }).VideoDecoder = class extends (
    NativeVideoDecoder
  ) {
    constructor(init: VideoDecoderInit) {
      super({
        ...init,
        output: (frame: VideoFrame) => {
          probe.decodedFrames += 1;
          init.output(frame);
        },
        error: (error: DOMException) => {
          probe.errors += 1;
          init.error(error);
        },
      });
      probe.decoders += 1;
    }
  };
};

interface VideoProbe {
  decoders: number;
  decodedFrames: number;
  keyChunks: number;
  deltaChunks: number;
  errors: number;
}

async function readVideoProbe(page: Page): Promise<VideoProbe> {
  return page.evaluate(
    () =>
      (window as unknown as { __paracordVideoProbe?: VideoProbe }).__paracordVideoProbe ?? {
        decoders: 0,
        decodedFrames: 0,
        keyChunks: 0,
        deltaChunks: 0,
        errors: 0,
      },
  );
}

/** Poll until every page has decoded `minimumFrames` of somebody else's video. */
async function waitForDecodedVideo(
  pages: Array<{ label: string; page: Page }>,
  minimumFrames: number,
  timeoutMs = 90_000,
): Promise<Map<string, VideoProbe>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = new Map(
      await Promise.all(
        pages.map(async ({ label, page }) => [label, await readVideoProbe(page)] as const),
      ),
    );
    if (Array.from(latest.values()).every((probe) => probe.decodedFrames >= minimumFrames)) {
      return latest;
    }
    if (Date.now() > deadline) {
      const detail = Array.from(latest.entries())
        .map(
          ([label, probe]) =>
            `${label}: decoders=${probe.decoders} frames=${probe.decodedFrames} ` +
            `keyChunks=${probe.keyChunks} deltaChunks=${probe.deltaChunks} errors=${probe.errors}`,
        )
        .join('; ');
      throw new Error(`remote video was never decoded (${detail})`);
    }
    await pages[0].page.waitForTimeout(1_000);
  }
}

/**
 * How much of a tile is actually lit, and how many colours are in it.
 *
 * A tile painting somebody's camera is a picture; a tile that is not is the
 * well colour with an avatar disc on it. Screenshotting the tile and measuring
 * what the compositor produced is the only readback that works here: the
 * renderer's WebGL context is created with `preserveDrawingBuffer: false`, so
 * reading the canvas from inside the page gives a cleared buffer.
 *
 * The screenshot comes back as PNG bytes, and the browser under test is the
 * nearest PNG decoder — it hands them straight back as pixels.
 */
async function tileBrightness(
  page: Page,
  locator: Locator,
): Promise<{ litFraction: number; distinctColours: number }> {
  const png = (await locator.screenshot()).toString('base64');
  return page.evaluate(async (base64: string) => {
    // Straight to a Blob: the app serves itself under a strict CSP, so a
    // `fetch('data:…')` for the screenshot is refused before it is a picture.
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2d context to measure the tile with');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    const pixels = canvas.width * canvas.height;
    const colours = new Set<number>();
    let lit = 0;
    for (let index = 0; index < pixels; index += 1) {
      const offset = index * 4;
      const [r, g, b] = [data[offset], data[offset + 1], data[offset + 2]];
      // Rec. 601 luma, near enough for "is there a picture here".
      if (0.299 * r + 0.587 * g + 0.114 * b > 24) lit += 1;
      colours.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
    }
    return { litFraction: pixels === 0 ? 0 : lit / pixels, distinctColours: colours.size };
  }, png);
}

/**
 * Playwright refuses per-test `launchOptions`, and these cases need the fake
 * capture device, so each launches its own browser (same shape as
 * real-server.voice-check.spec.ts). `body` receives a factory so a case can
 * open as many independent, separately-signed-in participants as it needs.
 */
async function withChromium(
  playwrightFixture: PlaywrightFixture,
  body: (newParticipant: () => Promise<Page>) => Promise<void>,
): Promise<void> {
  const browser = await playwrightFixture.chromium.launch({ args: MEDIA_LAUNCH_ARGS });
  const pages: Page[] = [];
  try {
    const newParticipant = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.grantPermissions(['microphone', 'camera'], { origin: BASE });
      await context.addInitScript(AUDIO_PROBE);
      await context.addInitScript(VIDEO_PROBE);
      context.setDefaultTimeout(30_000);
      const page = await context.newPage();
      pages.push(page);
      return page;
    };
    try {
      await body(newParticipant);
    } catch (error) {
      for (const [index, page] of pages.entries()) {
        await page
          .screenshot({ path: shotPath(`failure-${Date.now()}-${index}.png`) })
          .catch(() => {});
      }
      throw error;
    }
  } finally {
    await browser.close();
  }
}

interface Account {
  email: string;
  /** The display name on this account's tile. */
  username: string;
  /** The snowflake the Stage marks this person's tile with. */
  userId: string;
  password: string;
  token: string;
  csrf: string;
}

/**
 * Register a fresh account.
 *
 * This used to sleep off a 429 and try again, because the whole real-server
 * project shares one per-IP registration budget and this file runs last. That
 * hid the actual problem — thirteen end-to-end cases legitimately cost more
 * `/auth/*` per minute than the product's single-client ceiling allows — behind
 * a forty-second wait. The harness now raises that ceiling for its throwaway
 * loopback instance instead, so a 429 here is a real signal again and fails.
 */
async function register(api: APIRequestContext): Promise<Account> {
  const unique = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const email = `voicejoin-${unique}@example.test`;
  const username = `vj${unique}`.slice(0, 32);
  const password = 'Voice-Join-Password-123!';
  const response = await api.post(`${BASE}/api/v1/auth/register`, {
    data: { email, username, password },
  });
  expect(
    response.ok(),
    `register failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
  const body = await response.json();
  // Register sets the ambient auth + CSRF cookies on this context, so writes
  // from here need the double-submit header the real client sends.
  const cookies = (await api.storageState()).cookies;
  const csrf = cookies.find((cookie) => cookie.name === 'paracord_csrf')?.value;
  expect(csrf, 'register should set a readable paracord_csrf cookie').toBeTruthy();
  return {
    email,
    username,
    userId: String(body.user.id),
    password,
    token: body.token as string,
    csrf: csrf!,
  };
}

/** Create the space and its voice room over REST — the UI paths for both are
 * covered elsewhere and are not what this case is testing. */
async function createVoiceRoom(
  api: APIRequestContext,
  account: Account,
): Promise<{ guildId: string; channelId: string }> {
  const headers = {
    Authorization: `Bearer ${account.token}`,
    'x-paracord-csrf': account.csrf,
  };
  const guildResponse = await api.post(`${BASE}/api/v1/guilds`, {
    headers,
    data: { name: 'Browser voice proof' },
  });
  expect(
    guildResponse.status(),
    `guild creation: ${await guildResponse.text()}`,
  ).toBe(201);
  const guild = await guildResponse.json();

  const channelResponse = await api.post(`${BASE}/api/v1/guilds/${guild.id}/channels`, {
    headers,
    data: { name: 'lounge', channel_type: 2 },
  });
  expect(
    channelResponse.status(),
    `voice channel creation: ${await channelResponse.text()}`,
  ).toBe(201);
  const channel = await channelResponse.json();
  return { guildId: String(guild.id), channelId: String(channel.id) };
}

async function signIn(page: Page, account: Account): Promise<void> {
  // Registration already authenticated this context's cookie jar; clear it so
  // the form below is a genuine sign-in rather than an instant redirect.
  await page.context().clearCookies();
  await page.goto(`${BASE}/login`);
  await page.locator('input[autocomplete="username"]').fill(account.email);
  await page.locator('input[autocomplete="current-password"]').fill(account.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/\/app/);

  await dismissFirstRunOverlays(page);
}

/**
 * Two first-run panels sit on top of the app and swallow clicks: the layout
 * tour, and the per-space welcome screen that appears the first time a member
 * opens a guild. Both are dismissible and neither is what these cases are about.
 *
 * The welcome screen renders only once the guild's channels have loaded, so it
 * can appear *after* the Join button is already on screen — dismissing once on
 * arrival is a race.
 */
async function dismissFirstRunOverlays(page: Page): Promise<void> {
  for (const name of ['Skip tour', 'Close welcome screen']) {
    const button = page.getByRole('button', { name, exact: true });
    if (await button.isVisible().catch(() => false)) {
      await button.click().catch(() => {});
      await expect(button).toHaveCount(0);
    }
  }
}

/**
 * Press Join voice, re-clearing the first-run overlays if one of them appears
 * between the button rendering and the click landing.
 */
async function joinVoice(page: Page): Promise<void> {
  // The welcome screen and layout tour are dialogs that mark the rest of the
  // app aria-hidden, and they can mount a beat after the room renders — so
  // clear them, then look for the button, and repeat until the click lands.
  const joinButton = page.getByRole('button', { name: 'Join the room', exact: true });
  let clicked = false;
  for (let attempt = 0; attempt < 8 && !clicked; attempt++) {
    await dismissFirstRunOverlays(page);
    if (await joinButton.isVisible().catch(() => false)) {
      try {
        await joinButton.click({ timeout: 3_000 });
        clicked = true;
      } catch {
        // An overlay landed between the visibility check and the click.
      }
    } else {
      await page.waitForTimeout(500);
    }
  }
  expect(clicked, 'the Join the room button never became clickable').toBe(true);
}

interface RelayParticipant {
  user_id: string;
  session_id: string;
  transport: string;
  datagrams_received: number;
  datagrams_sent: number;
  audio_datagrams_received: number;
  video_datagrams_received: number;
  /** Whole keyframe frames the relay accepted on this connection's uni streams. */
  stream_frames_received: number;
  /** …and forwarded to it on fresh uni streams. */
  stream_frames_sent: number;
  bytes_received: number;
  bytes_sent: number;
}

interface RelayRoom {
  transport: string;
  room_id: string;
  connected_participants: number;
  participants: RelayParticipant[];
}

/** Read the relay's live counters for the room. Authenticated as the signed-in
 * browser (this shares the page's cookie jar), and side-effect free. */
async function readRelayRoom(page: Page, channelId: string): Promise<RelayRoom> {
  const response = await page.request.get(`${BASE}/api/v1/voice/${channelId}/media-stats`);
  expect(
    response.ok(),
    `media-stats failed: ${response.status()} ${await response.text()}`,
  ).toBeTruthy();
  return (await response.json()) as RelayRoom;
}

/**
 * Poll the relay until `predicate` holds, then return the snapshot.
 *
 * `expect.poll` would report only the final boolean; the room snapshot itself is
 * what makes a failure diagnosable ("joined, zero datagrams" is a completely
 * different defect from "never joined"), so keep the last one and print it.
 */
async function waitForRelay(
  page: Page,
  channelId: string,
  what: string,
  predicate: (room: RelayRoom) => boolean,
  timeoutMs = 45_000,
): Promise<RelayRoom> {
  const deadline = Date.now() + timeoutMs;
  let last: RelayRoom | null = null;
  while (Date.now() < deadline) {
    last = await readRelayRoom(page, channelId);
    if (predicate(last)) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `timed out waiting for the relay to report ${what}; last snapshot: ${JSON.stringify(last)}`,
  );
}

test('a browser joins a guild voice room, its audio reaches the relay, and leaving retires the connection', async ({
  playwright,
}) => {
  await withChromium(playwright, async (newParticipant) => {
    const page = await newParticipant();
    const consoleErrors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });

    const account = await register(page.request);
    const { guildId, channelId } = await createVoiceRoom(page.request, account);
    await signIn(page, account);

    // The native join contract is what the browser engine dials with; if any of
    // it is missing the failure downstream is unreadable.
    const joinResponse = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/v2/voice/${channelId}/join`) && response.request().method() === 'POST',
      { timeout: 60_000 },
    );
    joinResponse.catch(() => {});

    await page.goto(`${BASE}/app/guilds/${guildId}/channels/${channelId}`);
    await joinVoice(page);

    const join = await joinResponse;
    expect(join.status(), `voice join: ${await join.text()}`).toBe(200);
    const joinBody = await join.json();
    expect(joinBody.native_media, 'this proof is about the native transport').toBe(true);
    expect(typeof joinBody.media_token).toBe('string');
    expect(typeof joinBody.cert_hash).toBe('string');
    expect(joinBody.room_name).toBe(`${guildId}:${channelId}`);
    const voiceSessionId = joinBody.session_id as string;
    expect(typeof voiceSessionId).toBe('string');

    // 1. The UI reaches a connected call. The call dock only renders while
    //    `voiceStore.connected` is true, and the lobby replaces the Join button
    //    with an error block on failure — so assert the absence of that too,
    //    otherwise a failed join that re-renders quickly could slip through.
    await expect(page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Voice connection failed:/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disconnect from voice' })).toBeVisible();

    // 2. The server agrees: the relay holds a live WebTransport connection for
    //    this account in this room, under the receipt the REST join issued.
    const connected = await waitForRelay(
      page,
      channelId,
      'a connected participant',
      (room) => room.connected_participants === 1,
    );
    expect(connected.transport).toBe('native');
    expect(connected.room_id).toBe(`${guildId}:${channelId}`);
    const participant = connected.participants[0];
    expect(
      participant.transport,
      'a browser must be bridged over WebTransport, not raw QUIC',
    ).toBe('webtransport');
    expect(
      participant.session_id,
      'the media connection must be fenced on the receipt the join issued',
    ).toBe(voiceSessionId);

    // 3. Audio actually flows. The counters are cumulative, so this is proof the
    //    packets arrived rather than a snapshot of an instantaneous rate.
    // Ten 20 ms frames is a fifth of a second of continuous capture, so this
    // cannot be satisfied by one stray packet that happened to parse.
    const flowing = await waitForRelay(
      page,
      channelId,
      'a stream of audio datagrams from the browser',
      (room) => (room.participants[0]?.audio_datagrams_received ?? 0) >= 10,
      60_000,
    );
    const audible = flowing.participants[0];
    expect(audible.audio_datagrams_received).toBeGreaterThanOrEqual(10);
    expect(audible.datagrams_received).toBeGreaterThanOrEqual(
      audible.audio_datagrams_received,
    );
    expect(audible.bytes_received).toBeGreaterThan(0);

    await page.screenshot({ path: shotPath('browser-voice-connected.png') });

    // 4. Leaving retires the connection on both sides, *promptly*. The 15 s
    //    budget is deliberate: a browser ends a WebTransport session by closing
    //    its CONNECT stream and leaves the QUIC connection warm, so a server
    //    that watches only the connection keeps the departed participant
    //    registered until the ~30 s idle timeout. That is what this bound
    //    catches.
    await page.getByRole('button', { name: 'Disconnect from voice' }).click();
    await expect(page.getByTestId('call-dock')).toHaveCount(0, { timeout: 30_000 });
    const empty = await waitForRelay(
      page,
      channelId,
      'an empty room after leaving',
      (room) => room.connected_participants === 0,
      15_000,
    );
    expect(empty.participants).toEqual([]);

    // A call that logs errors while "working" is not working.
    expect(
      consoleErrors.filter((text) => /voice|media|webtransport|worklet/i.test(text)),
      'the call must not log media errors',
    ).toEqual([]);
  });
});

test('two browsers in one room exchange audio through the relay', async ({ playwright }) => {
  await withChromium(playwright, async (newParticipant) => {
    const host = await newParticipant();
    const guest = await newParticipant();

    const hostAccount = await register(host.request);
    const { guildId, channelId } = await createVoiceRoom(host.request, hostAccount);
    const guestAccount = await register(guest.request);

    // The guest reaches the room the way a real second person does.
    const invite = await host.request.post(`${BASE}/api/v1/channels/${channelId}/invites`, {
      headers: {
        Authorization: `Bearer ${hostAccount.token}`,
        'x-paracord-csrf': hostAccount.csrf,
      },
      data: {},
    });
    expect(invite.status(), `invite creation: ${await invite.text()}`).toBe(201);
    const inviteCode = (await invite.json()).code as string;
    const accepted = await guest.request.post(`${BASE}/api/v1/invites/${inviteCode}`, {
      headers: {
        Authorization: `Bearer ${guestAccount.token}`,
        'x-paracord-csrf': guestAccount.csrf,
      },
      data: {},
    });
    expect(accepted.ok(), `invite accept: ${await accepted.text()}`).toBeTruthy();

    for (const [page, account] of [
      [host, hostAccount],
      [guest, guestAccount],
    ] as const) {
      await signIn(page, account);
      await page.goto(`${BASE}/app/guilds/${guildId}/channels/${channelId}`);
      await joinVoice(page);
      await expect(page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/Voice connection failed:/)).toHaveCount(0);
    }

    // Both are live on the WebTransport path…
    const both = await waitForRelay(
      host,
      channelId,
      'two connected participants',
      (room) => room.connected_participants === 2,
    );
    expect(both.participants.map((entry) => entry.transport)).toEqual([
      'webtransport',
      'webtransport',
    ]);

    // …and media is genuinely being exchanged, not merely published: each
    // connection is both receiving its own browser's audio and being *sent*
    // packets, which can only be the other participant's audio fanned out.
    const exchanging = await waitForRelay(
      host,
      channelId,
      'audio flowing in both directions',
      (room) =>
        room.participants.length === 2 &&
        room.participants.every(
          (entry) => entry.audio_datagrams_received >= 10 && entry.datagrams_sent >= 10,
        ),
      60_000,
    );
    for (const entry of exchanging.participants) {
      expect(entry.audio_datagrams_received).toBeGreaterThanOrEqual(10);
      expect(entry.datagrams_sent).toBeGreaterThanOrEqual(10);
      expect(entry.bytes_sent).toBeGreaterThan(0);
    }

    // …and, the only assertion that means anybody was *heard*: each browser
    // built a decoder for the other, decoded its frames, and played every one
    // of them. The relay counters above are satisfied by a call that reads
    // every datagram off the wire and drops it, which is exactly what this
    // client did before the media control plane and the call keys were fixed.
    const audible = await waitForAudiblePlayback(
      [
        { label: 'host', page: host },
        { label: 'guest', page: guest },
      ],
      50,
    );
    for (const [label, probe] of audible) {
      expect(probe.decoders, `${label} built a decoder for the other participant`).toBeGreaterThanOrEqual(1);
      expect(probe.decodedFrames, `${label} decoded remote audio`).toBeGreaterThanOrEqual(50);
      expect(probe.buffers, `${label} built playback buffers`).toBeGreaterThanOrEqual(50);
      expect(probe.starts, `${label} played remote audio`).toBeGreaterThanOrEqual(50);
    }

    await host.screenshot({ path: shotPath('browser-voice-two-party.png') });

    // One leaving must not disturb the other.
    await guest.getByRole('button', { name: 'Disconnect from voice' }).click();
    await expect(guest.getByTestId('call-dock')).toHaveCount(0, { timeout: 30_000 });
    const remaining = await waitForRelay(
      host,
      channelId,
      'only the host left in the room',
      (room) => room.connected_participants === 1,
      15_000,
    );
    expect(remaining.participants[0].session_id).not.toBe('');
    await expect(host.getByTestId('call-dock')).toBeVisible();

    await host.getByRole('button', { name: 'Disconnect from voice' }).click();
    await waitForRelay(
      host,
      channelId,
      'an empty room',
      (room) => room.connected_participants === 0,
      15_000,
    );
  });
});

test('a participant who closes their tab stops being in the room for everyone else', async ({
  playwright,
}) => {
  await withChromium(playwright, async (newParticipant) => {
    const host = await newParticipant();
    const guest = await newParticipant();

    const hostAccount = await register(host.request);
    const { guildId, channelId } = await createVoiceRoom(host.request, hostAccount);
    const guestAccount = await register(guest.request);

    const invite = await host.request.post(`${BASE}/api/v1/channels/${channelId}/invites`, {
      headers: {
        Authorization: `Bearer ${hostAccount.token}`,
        'x-paracord-csrf': hostAccount.csrf,
      },
      data: {},
    });
    expect(invite.status(), `invite creation: ${await invite.text()}`).toBe(201);
    const inviteCode = (await invite.json()).code as string;
    const accepted = await guest.request.post(`${BASE}/api/v1/invites/${inviteCode}`, {
      headers: {
        Authorization: `Bearer ${guestAccount.token}`,
        'x-paracord-csrf': guestAccount.csrf,
      },
      data: {},
    });
    expect(accepted.ok(), `invite accept: ${await accepted.text()}`).toBeTruthy();

    for (const [page, account] of [
      [host, hostAccount],
      [guest, guestAccount],
    ] as const) {
      await signIn(page, account);
      await page.goto(`${BASE}/app/guilds/${guildId}/channels/${channelId}`);
      await joinVoice(page);
      await expect(page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });
    }
    await waitForRelay(host, channelId, 'two connected participants', (room) => room.connected_participants === 2);
    // The host's Stage says two people are here before the guest disappears,
    // so the assertion below is a transition and not a state that was never true.
    await expect(host.getByText('2 here', { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    // No leave, no disconnect click: the tab is simply gone, which is how most
    // calls actually end. Nothing on the client gets to tell the server.
    await guest.close();

    // The media connection retires on its own — that part always worked.
    await waitForRelay(host, channelId, 'the room down to one', (room) => room.connected_participants === 1, 20_000);

    // This is the regression: the *voice state* is what every other client draws
    // the room's light from, and nothing retired it on the native transport, so
    // the room stayed lit with a ghost in it until the server was restarted.
    // The host must see the room empty out.
    await expect(host.getByText('1 here', { exact: false }).first()).toBeVisible({ timeout: 15_000 });
    await expect(host.getByText('2 here', { exact: false })).toHaveCount(0);
    await expect(host.getByTestId('call-dock')).toBeVisible();

    // And a member who was never in the call sees a room with one person in it,
    // not two — the lobby reads the same voice state.
    const bystander = await newParticipant();
    const bystanderAccount = await register(bystander.request);
    const joined = await bystander.request.post(`${BASE}/api/v1/invites/${inviteCode}`, {
      headers: {
        Authorization: `Bearer ${bystanderAccount.token}`,
        'x-paracord-csrf': bystanderAccount.csrf,
      },
      data: {},
    });
    expect(joined.ok(), `bystander invite accept: ${await joined.text()}`).toBeTruthy();
    await signIn(bystander, bystanderAccount);
    await bystander.goto(`${BASE}/app/guilds/${guildId}/channels/${channelId}`);
    await expect(bystander.getByText('In this room — 1')).toBeVisible({ timeout: 30_000 });
  });
});

/**
 * Set a room up with two signed-in members already in the call, and hand back
 * the pair. Every video case needs exactly this preamble.
 */
async function twoInOneRoom(
  newParticipant: () => Promise<Page>,
): Promise<{
  host: Page;
  guest: Page;
  hostAccount: Account;
  guestAccount: Account;
  guildId: string;
  channelId: string;
}> {
  const host = await newParticipant();
  const guest = await newParticipant();

  const hostAccount = await register(host.request);
  const { guildId, channelId } = await createVoiceRoom(host.request, hostAccount);
  const guestAccount = await register(guest.request);

  const invite = await host.request.post(`${BASE}/api/v1/channels/${channelId}/invites`, {
    headers: {
      Authorization: `Bearer ${hostAccount.token}`,
      'x-paracord-csrf': hostAccount.csrf,
    },
    data: {},
  });
  expect(invite.status(), `invite creation: ${await invite.text()}`).toBe(201);
  const inviteCode = (await invite.json()).code as string;
  const accepted = await guest.request.post(`${BASE}/api/v1/invites/${inviteCode}`, {
    headers: {
      Authorization: `Bearer ${guestAccount.token}`,
      'x-paracord-csrf': guestAccount.csrf,
    },
    data: {},
  });
  expect(accepted.ok(), `invite accept: ${await accepted.text()}`).toBeTruthy();

  for (const [page, account] of [
    [host, hostAccount],
    [guest, guestAccount],
  ] as const) {
    await signIn(page, account);
    await page.goto(`${BASE}/app/guilds/${guildId}/channels/${channelId}`);
    await joinVoice(page);
    await expect(page.getByTestId('call-dock')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Voice connection failed:/)).toHaveCount(0);
  }

  await waitForRelay(
    host,
    channelId,
    'two connected participants',
    (room) => room.connected_participants === 2,
  );

  return { host, guest, hostAccount, guestAccount, guildId, channelId };
}

test('two browsers in one room see each other — one on camera, one sharing a screen', async ({
  playwright,
}) => {
  await withChromium(playwright, async (newParticipant) => {
    const { host, guest, hostAccount, guestAccount, channelId } =
      await twoInOneRoom(newParticipant);

    const pageErrors: string[] = [];
    for (const page of [host, guest]) {
      page.on('pageerror', (error) => pageErrors.push(error.message));
    }

    // The host goes on camera; the guest shares a screen. One publisher each
    // way, and the guest's own share preview is off by default — so every video
    // frame the *guest* decodes came from the host's camera and nothing else.
    await dismissFirstRunOverlays(host);
    await dismissFirstRunOverlays(guest);
    await host.getByRole('button', { name: 'Turn on camera', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Turn off camera', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await guest.getByRole('button', { name: 'Share screen', exact: true }).click();
    // The share is offered in two places at once — the call dock's Stop and the
    // Stage control bar's — so take the first.
    await expect(
      guest.getByRole('button', { name: 'Stop streaming', exact: true }).first(),
    ).toBeVisible({ timeout: 30_000 });

    // 1. The keyframe path itself. A VP9 decoder emits nothing until it has a
    //    keyframe, and keyframes ride reliable unidirectional streams rather
    //    than datagrams. This counter pinned at 0 while thousands of video
    //    datagrams arrived was the blocker: the server's WebTransport accept
    //    loop validated each stream's header inline, so the first HTTP/3 stream
    //    Chromium opened beside the session and left silent parked it, and
    //    every keyframe stream behind it queued unaccepted.
    const streaming = await waitForRelay(
      host,
      channelId,
      'whole keyframe frames arriving on unidirectional streams',
      (room) =>
        room.participants.length === 2 &&
        room.participants.every(
          (entry) =>
            (entry.stream_frames_received ?? 0) >= 1 &&
            (entry.stream_frames_sent ?? 0) >= 1 &&
            (entry.video_datagrams_received ?? 0) > 0,
        ),
      90_000,
    );
    for (const entry of streaming.participants) {
      expect(
        entry.stream_frames_received,
        'the relay must accept the browser’s keyframe streams',
      ).toBeGreaterThanOrEqual(1);
      expect(
        entry.stream_frames_sent,
        'and forward the other publisher’s keyframes to it',
      ).toBeGreaterThanOrEqual(1);
      expect(
        entry.video_datagrams_received,
        'the delta frames ride datagrams beside them, as they always did',
      ).toBeGreaterThan(0);
    }

    // 2. The guest decoded the host's camera. Thirty frames is a second of
    //    continuous picture at the capture rate, not one lucky keyframe — and
    //    the guest publishes no camera and previews no share, so there is
    //    nothing else these frames could be.
    const decoded = await waitForDecodedVideo([{ label: 'guest', page: guest }], 30);
    for (const [label, probe] of decoded) {
      expect(probe.decoders, `${label} built a video decoder`).toBeGreaterThanOrEqual(1);
      expect(probe.decodedFrames, `${label} decoded the host’s camera`).toBeGreaterThanOrEqual(30);
    }

    // 3. And it reached the screen. The guest's tile for the host stops
    //    reporting a camera that is off — that flag is set by the first frame
    //    the renderer actually paints for *that participant* — and the tile is
    //    a picture rather than the well colour with initials on it.
    const hostTileOnGuest = guest.locator(`[data-motion-speaking="${hostAccount.userId}"]`).first();
    await expect(hostTileOnGuest).toBeVisible({ timeout: 30_000 });
    await expect(
      hostTileOnGuest.getByText(/camera is off/),
      'the tile must stop reporting a camera that is off once frames arrive',
    ).toHaveCount(0, { timeout: 60_000 });
    const cameraTile = await tileBrightness(guest, hostTileOnGuest);
    expect(
      cameraTile.litFraction,
      `the host's camera tile is still dark (${JSON.stringify(cameraTile)})`,
    ).toBeGreaterThan(0.2);
    expect(cameraTile.distinctColours).toBeGreaterThan(8);
    await guest.screenshot({ path: shotPath('browser-video-camera-seen.png') });

    // 4. The other direction: the host opens the guest's share and decodes it.
    //
    //    The host's camera goes off first, and that is what makes this
    //    countable: with nothing of its own to publish, every video frame the
    //    host decodes from here on is the guest's screen. The viewer's own
    //    empty state is the second half of the proof — it says "X is not
    //    sharing" until a frame is *painted for that person's screen track*,
    //    which is exactly what it said for every share before this round.
    await host.getByRole('button', { name: 'Turn off camera', exact: true }).click();
    await expect(host.getByRole('button', { name: 'Turn on camera', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await host.waitForTimeout(2_000);
    const beforeWatching = (await readVideoProbe(host)).decodedFrames;

    const watch = host.getByRole('button', { name: 'Watch', exact: true }).first();
    if (await watch.isVisible().catch(() => false)) await watch.click();
    await expect(
      host.getByText(/is not sharing/),
      'the share viewer must stop claiming nobody is sharing',
    ).toHaveCount(0, { timeout: 60_000 });

    const watching = await waitForDecodedVideo(
      [{ label: 'host', page: host }],
      beforeWatching + 30,
    );
    expect(
      watching.get('host')!.decodedFrames - beforeWatching,
      'the host must decode the guest’s screen, with no camera of its own running',
    ).toBeGreaterThanOrEqual(30);

    const shareCanvas = host.locator('[data-stream-canvas]').first();
    await expect(shareCanvas).toBeVisible({ timeout: 30_000 });
    const shareTile = await tileBrightness(host, shareCanvas);
    // A headless tab capture of the app's own dark UI is very nearly black, so
    // brightness proves nothing here; what proves there is a picture is that it
    // is a *picture*. A canvas nobody painted is one colour.
    expect(
      shareTile.distinctColours,
      `the guest's share canvas is blank (${JSON.stringify(shareTile)})`,
    ).toBeGreaterThan(32);

    await host.screenshot({ path: shotPath('browser-video-share-seen.png') });

    // The numbers, so a passing run says what it proved rather than only that
    // it passed.
    const finalRoom = await readRelayRoom(host, channelId);
    console.log(
      '[video proof] relay ' +
        finalRoom.participants
          .map(
            (entry) =>
              `${entry.user_id}: streams in ${entry.stream_frames_received} / out ` +
              `${entry.stream_frames_sent}, video datagrams ${entry.video_datagrams_received}`,
          )
          .join(' | ') +
        ` — guest decoded ${(await readVideoProbe(guest)).decodedFrames} camera frames, ` +
        `host decoded ${(await readVideoProbe(host)).decodedFrames - beforeWatching} share frames ` +
        `with its own camera off; camera tile ${JSON.stringify(cameraTile)}, ` +
        `share canvas ${JSON.stringify(shareTile)}`,
    );

    // 5. Publishing video must not throw on the page. Every keyframe opens a
    //    fresh WebTransport unidirectional stream, and the browser refuses once
    //    the connection's credit runs out; those rejections used to escape the
    //    encoder callback as uncaught errors — 299 of 552 stream opens in one
    //    measured screen-share run.
    expect(pageErrors, 'publishing video must not raise an uncaught page error').toEqual([]);
  });
});
