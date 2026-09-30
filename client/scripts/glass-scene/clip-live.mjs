#!/usr/bin/env node
// Live proof of clips (WP-G16, docs/glass-spec.md §6.4), driven through the
// app's own controls in the build the instance serves, against the Lounge call
// a `glass-scene.mjs` holder keeps running (Vincent sharing a video-only canvas
// scene).
//
//   node scripts/live-env.mjs --port <port> --data <dir>
//   node client/scripts/glass-scene.mjs --base http://127.0.0.1:<port> --out <dir>      # holds the call
//   node client/scripts/glass-scene/clip-live.mjs --base http://127.0.0.1:<port> --scene <dir>/scene.json
//
// 1. Sean watches Vincent from the pill (not joined), waits past 30 s, presses
//    Clip, sees the toast, posts to General. The posted file is downloaded
//    with Sean's token and checked with ffprobe and by playing it in Chromium:
//    about 30 s, VP9 frames of Vincent's scene.
// 2. Eric joins Lounge and shares a screen that carries its own audio (a
//    pulsing tone). Sean switches the stage to Eric and clips while still not
//    joined (whether that clip has audio is a NOTE: the view session does not
//    receive stream audio yet, an engine gap outside clips), then joins from
//    the stage and clips again: that file must have an Opus track that is not
//    silent, and play with decoded audio.
// Everything is read from the page, the server or the file. PASS/FAIL per step;
// exits non-zero on any FAIL.
//
// Options
//   --base <url>     instance (default http://127.0.0.1:18420)
//   --scene <file>   scene.json a glass-scene run wrote
//   --out <dir>      shots and the downloaded clips (default output/design-reference/glass-build/g16/live)
//   --headed         show the browsers

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi } from './api.mjs';
import { STREAM_SCENE } from './art.mjs';
import { CONTROLS, dismissOverlays, joinVoice, launchBrowser, openAs, press, waitForControl } from './ui.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const BASE = arg('base', 'http://127.0.0.1:18420').replace(/\/+$/, '');
const SCENE = arg('scene', join(repoRoot, 'output', 'design-reference', 'glass-build', 'live', 'scene.json'));
const OUT = resolve(arg('out', join(repoRoot, 'output', 'design-reference', 'glass-build', 'g16', 'live')));
const HEADLESS = !process.argv.includes('--headed');
/** How long to watch before clipping: past the 30 s window, so the clip is a full one. */
const WATCH_MS = 36_000;

const scene = JSON.parse(readFileSync(SCENE, 'utf8'));
const gameNight = scene.servers.gameNight;
const lounge = gameNight.channels.lounge;
const generalId = gameNight.channels.general;
const general = `/app/guilds/${gameNight.id}/channels/${generalId}`;
const loungePath = `/app/guilds/${gameNight.id}/channels/${lounge}`;
const accounts = scene.accounts;
const ids = { sean: accounts.sean.id, vincent: accounts.vincent.id, eric: accounts.eric.id };
const api = createApi(BASE);
const results = [];
const t0 = Date.now();
const log = (line) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s] ${line}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const notes = [];
/** A finding that is not this package's to pass or fail (reported, not counted). */
function note(name, detail) {
  notes.push({ name, detail });
  log(`NOTE  ${name}${detail ? `: ${detail}` : ''}`);
}
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `: ${detail}` : ''}`);
}
async function until(fn, timeoutMs = 30_000, stepMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await fn();
    if (last) return last;
    if (Date.now() > deadline) return last;
    await sleep(stepMs);
  }
}
const stage = (page) => page.getByRole('region', { name: 'Stage' });
const pill = (page) => page.getByRole('region', { name: /live voice channel|voice call/ });
const visible = (locator) => locator.first().isVisible().catch(() => false);
const clipButton = (page) => stage(page).getByRole('button', { name: /^Clip( the last 30 seconds)?$/ });
const toast = (page) => page.getByRole('status', { name: 'Clip saved' });

async function relayHas(token, userId) {
  const room = await api.request(token, 'GET', `/voice/${lounge}/media-stats`);
  return room.participants.some((p) => String(p.user_id) === userId);
}
async function relaySending(token, userId) {
  const room = await api.request(token, 'GET', `/voice/${lounge}/media-stats`);
  const p = room.participants.find((entry) => String(entry.user_id) === userId);
  return p ? (p.video_datagrams_received ?? 0) + (p.stream_frames_received ?? 0) : 0;
}

/** A share with its own audio: the scene's canvas plus a tone that pulses twice a second. */
const SHARE_WITH_AUDIO = `(() => {
  const devices = navigator.mediaDevices;
  const original = devices.getDisplayMedia.bind(devices);
  devices.getDisplayMedia = async (constraints) => {
    const stream = await original(constraints);
    const ac = new AudioContext({ sampleRate: 48000 });
    const tone = ac.createOscillator();
    tone.frequency.value = 660;
    const gain = ac.createGain();
    gain.gain.value = 0.3;
    const lfo = ac.createOscillator();
    lfo.frequency.value = 2;
    const depth = ac.createGain();
    depth.gain.value = 0.25;
    lfo.connect(depth).connect(gain.gain);
    const out = ac.createMediaStreamDestination();
    tone.connect(gain).connect(out);
    tone.start();
    lfo.start();
    stream.addTrack(out.stream.getAudioTracks()[0]);
    return stream;
  };
})();`;

/** The newest attachment of Sean's in General whose name says it is a clip from `source`. */
async function postedClip(token, source) {
  const messages = await api.request(token, 'GET', `/channels/${generalId}/messages?limit=20`);
  for (const message of messages) {
    if (String(message.author?.id) !== ids.sean) continue;
    const attachment = (message.attachments ?? []).find((a) => a.filename?.startsWith('Clip ') && a.filename.includes(`from ${source}`));
    if (attachment) return { message, attachment };
  }
  return null;
}

function ffprobe(file) {
  const json = execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries',
    'format=duration,format_name:stream=codec_type,codec_name,width,height,channels,nb_read_frames', '-of', 'json', file]).toString();
  return JSON.parse(json);
}
/** ffmpeg's volumedetect on the audio track: its report (stderr), or '' when the file has no audio. */
function meanVolume(file) {
  const run = spawnSync('ffmpeg', ['-v', 'info', '-i', file, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
  return run.status === 0 ? run.stderr : '';
}

/** Play `bytes` in a plain Chromium page as the app does (a blob URL): duration, size, decoded audio, the picture at the start and near the end. */
async function playInChromium(browser, bytes, type) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('https://clip.test/**', (route) => route.fulfill({ status: 200, body: bytes, contentType: type }));
  await page.route('https://clip.test/', (route) => route.fulfill({ status: 200, body: '<!doctype html><body></body>', contentType: 'text/html' }));
  await page.goto('https://clip.test/');
  const result = await page.evaluate(async () => {
    const video = document.createElement('video');
    video.muted = false;
    video.volume = 0.01;
    document.body.appendChild(video);
    const sample = () => {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 36;
      const context = canvas.getContext('2d');
      context.drawImage(video, 0, 0, 64, 36);
      const px = context.getImageData(0, 0, 64, 36).data;
      let lit = 0, teal = 0, amber = 0;
      for (let i = 0; i < px.length; i += 4) {
        const [r, g, b] = [px[i], px[i + 1], px[i + 2]];
        if (r + g + b > 90) lit++;
        if (g > 110 && b > 90 && r < 130) teal++;
        if (r > 150 && g > 70 && b < 110 && r > b + 60) amber++;
      }
      return { lit, teal, amber };
    };
    return new Promise((resolve) => {
      video.onerror = () => resolve({ error: video.error?.message || `code ${video.error?.code}` });
      video.onloadedmetadata = async () => {
        try {
          const duration = video.duration;
          await video.play();
          await new Promise((r) => setTimeout(r, 2500));
          const start = { t: video.currentTime, ...sample() };
          video.currentTime = Math.max(0, duration - 1.5);
          await new Promise((r) => { video.onseeked = r; });
          await new Promise((r) => setTimeout(r, 800));
          const end = { t: video.currentTime, ...sample() };
          resolve({ duration, width: video.videoWidth, height: video.videoHeight, start, end,
            decodedFrames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? null,
            audioBytes: video.webkitAudioDecodedByteCount ?? null });
        } catch (error) {
          resolve({ error: String(error) });
        }
      };
      // As the app plays an attachment: fetched whole, then a blob URL (which is seekable).
      fetch('https://clip.test/clip').then((r) => r.blob()).then((blob) => { video.src = URL.createObjectURL(blob); });
    });
  });
  await context.close();
  return result;
}

async function clipAndPost(session, browser, token, source, name, { expectAudio }) {
  const { page } = session;
  log(`watching ${source} for ${WATCH_MS / 1000}s before clipping`);
  await sleep(WATCH_MS);
  const button = clipButton(page);
  check(`${name}: Clip is available while watching`, (await button.getAttribute('aria-disabled')) !== 'true', await button.getAttribute('title'));
  const cutAt = Date.now();
  await button.click();
  const shown = await until(() => visible(toast(page)), 10_000, 200);
  check(`${name}: the toast appears`, shown, shown ? `${Date.now() - cutAt} ms after the press` : 'no toast');
  const text = shown ? await toast(page).innerText() : '';
  check(`${name}: "Saved the last 30 seconds"`, text.includes('Saved the last 30 seconds'), text.replace(/\n/g, ' | '));
  check(`${name}: "From ${source}, <time>"`, new RegExp(`From ${source.replace(/'/g, "'")}, \\d{1,2}:\\d{2}`).test(text), undefined);
  const thumb = await until(async () => (await toast(page).locator('img').count()) > 0, 5_000, 250);
  check(`${name}: the toast has a still of the stream`, thumb);
  await page.screenshot({ path: join(OUT, `${name}-toast.png`) });
  const post = toast(page).getByRole('button', { name: 'Post to General' });
  check(`${name}: "Post to General" is offered`, await visible(post));
  await post.click();
  const posted = await until(async () => (await toast(page).innerText().catch(() => '')).includes('Posted to General'), 60_000, 300);
  check(`${name}: "Posted to General"`, posted, posted ? await toast(page).innerText() : await toast(page).innerText().catch(() => 'toast gone'));
  await page.screenshot({ path: join(OUT, `${name}-posted.png`) });

  const found = await until(() => postedClip(token, source), 20_000, 1000);
  check(`${name}: the message is in General with the clip attached`, Boolean(found), found ? `${found.attachment.filename}, ${found.attachment.size} bytes, ${found.attachment.content_type}` : 'no message');
  if (!found) return;
  const response = await api.request(token, 'GET', `/attachments/${found.attachment.id}`, undefined, { raw: true });
  const bytes = Buffer.from(await response.arrayBuffer());
  const file = join(OUT, `${name}-${found.attachment.filename.replace(/[^\w.-]+/g, '_')}`);
  writeFileSync(file, bytes);
  check(`${name}: the download is the file that was posted`, response.ok && bytes.length === found.attachment.size, `${bytes.length} bytes`);

  const probe = ffprobe(file);
  const duration = Number(probe.format?.duration);
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const audio = probe.streams.find((s) => s.codec_type === 'audio');
  check(`${name}: ffprobe reads ~30 s (30–36 s: from the last keyframe before now − 30 s)`, duration >= 29.5 && duration <= 36.5, `${probe.format?.format_name}, ${duration}s`);
  check(`${name}: ffprobe decodes the video`, video && Number(video.nb_read_frames) > duration * 5, video ? `${video.codec_name} ${video.width}x${video.height}, ${video.nb_read_frames} frames` : 'no video stream');
  if (expectAudio === 'note') {
    note(`${name}: stream audio in a clip cut while watching without joining`, audio ? `${audio.codec_name}, ${audio.nb_read_frames} packets` : 'none: the view session never receives the stream audio (see docs/design/glass-g16-checkpoint.md, "Stream audio when not joined")');
  } else if (expectAudio) {
    check(`${name}: ffprobe finds the stream's own audio`, audio?.codec_name === 'opus', audio ? `${audio.codec_name}, ${audio.channels} ch, ${audio.nb_read_frames} packets` : 'no audio stream');
    const volume = meanVolume(file);
    const mean = Number(/mean_volume: (-?[\d.]+) dB/.exec(volume)?.[1] ?? '-inf');
    check(`${name}: the audio is not silent`, Number.isFinite(mean) && mean > -50, `mean volume ${mean} dB`);
  } else {
    check(`${name}: no audio track (the stream has no audio of its own)`, !audio, audio ? audio.codec_name : 'video only');
  }

  const played = await playInChromium(browser, bytes, found.attachment.content_type || 'video/webm');
  check(`${name}: Chromium plays it`, !played.error && played.duration >= 29.5 && played.duration <= 36.5, JSON.stringify(played));
  check(`${name}: Chromium shows the stream's picture at the start and after seeking to the end`, played.start?.lit > 200 && played.end?.lit > 200 && played.end?.t > played.duration - 2, played.start && `${played.start.lit} lit px at ${played.start.t.toFixed(1)}s, ${played.end.lit} at ${played.end.t.toFixed(1)}s`);
  if (source === "Vincent's screen") {
    check(`${name}: it is Vincent's scene (teal and amber)`, played.start?.teal > 20 && played.start?.amber > 20, played.start && `teal ${played.start.teal}, amber ${played.start.amber}`);
  }
  if (expectAudio === true) check(`${name}: Chromium decodes its audio`, played.audioBytes > 0, `${played.audioBytes} bytes decoded`);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const seanToken = (await api.account(accounts.sean, { likelyExists: true })).token;
  if (!(await relayHas(seanToken, ids.vincent))) throw new Error('the Lounge call is not held; run glass-scene.mjs first');
  const browser = await launchBrowser({ headless: HEADLESS });
  let eric = null;
  try {
    const sean = await openAs(browser, BASE, accounts.sean, { media: { voice: 'quiet' } });
    const { page } = sean;
    await page.goto(general);
    await dismissOverlays(page, 700, 6000);
    await pill(page).waitFor({ state: 'visible', timeout: 30_000 });

    // Before watching, there is no clip control and nothing is buffered.
    check('no Clip control before watching', !(await visible(page.getByRole('button', { name: /^Clip( the last 30 seconds)?$/ }))));

    await pill(page).getByRole('button', { name: "Watch Vincent's screen" }).click();
    check('Watch opens the stage', await until(() => visible(stage(page)), 10_000));
    const live = await until(async () => (await clipButton(page).getAttribute('aria-disabled').catch(() => 'true')) !== 'true', 45_000, 500);
    check('Clip becomes available once the watch is live', live, await clipButton(page).getAttribute('title').catch(() => ''));
    check('watching did not join the call', !(await relayHas(seanToken, ids.sean)));

    await clipAndPost(sean, browser, seanToken, "Vincent's screen", 'vincent', { expectAudio: false });
    // A second clip, left unposted: switching streams must free it.
    await clipButton(page).click();
    check('a second clip can be cut right away', await until(async () => (await toast(page).innerText().catch(() => '')).includes('Saved the last'), 10_000, 200));

    // Eric shares a screen with its own audio.
    eric = await openAs(browser, BASE, accounts.eric, { media: { display: true, voice: 'quiet', scene: STREAM_SCENE } });
    await eric.context.addInitScript({ content: SHARE_WITH_AUDIO });
    await joinVoice(eric, loungePath, { log });
    await press(eric.page, CONTROLS.share);
    await waitForControl(eric.page, CONTROLS.stopShare, 30_000);
    const ericSending = await until(() => relaySending(seanToken, ids.eric), 30_000, 1000);
    check('Eric shares a screen with its own audio', ericSending > 0, `${ericSending} video datagrams at the relay`);

    // ERIC_SETTLE_MS: time between Eric's share starting and Sean switching to it (diagnostics).
    await sleep(Number(process.env.ERIC_SETTLE_MS ?? 0));
    const switchTo = stage(page).getByRole('button', { name: "Watch Eric's screen" });
    await until(() => visible(switchTo), 30_000, 500);
    await switchTo.first().click();
    const onEric = await until(async () => (await stage(page).innerText()).includes("Eric's screen"), 20_000, 500);
    check("the stage switches to Eric's screen", onEric);
    check("switching streams freed Vincent's unposted clip (the toast went with it)", !(await visible(toast(page))));
    const ericLive = await until(async () => (await clipButton(page).getAttribute('aria-disabled').catch(() => 'true')) !== 'true', 45_000, 500);
    check("Clip is available on Eric's stream", ericLive);
    await clipAndPost(sean, browser, seanToken, "Eric's screen", 'eric-watching', { expectAudio: 'note' });

    // Joined, the watch rides the call, whose engine carries the stream's own audio.
    await stage(page).getByRole('button', { name: 'Join Lounge' }).click();
    const joined = await until(async () => (await relayHas(seanToken, ids.sean)) && (await visible(stage(page).getByRole('button', { name: /^Leave/ }))), 30_000, 500);
    check('Sean joins from the stage and keeps watching Eric', joined && (await stage(page).innerText()).includes("Eric's screen"));
    await clipAndPost(sean, browser, seanToken, "Eric's screen", 'eric-joined', { expectAudio: true });
    await stage(page).getByRole('button', { name: /^Leave/ }).first().click();

    // The bubble in the conversation beside the stage.
    await page.screenshot({ path: join(OUT, 'conversation-after-posting.png') });

    // Stopping frees it: the toast and the control go with the stage.
    await stage(page).getByRole('button', { name: /Stop watching/ }).first().click();
    const closed = await until(async () => !(await visible(stage(page))), 10_000, 300);
    check('Stop watching closes the stage and its clip', closed && !(await visible(toast(page))));
    const pageErrors = sean.logs.filter((line) => line.startsWith('pageerror'));
    check("no page errors in Sean's client", pageErrors.length === 0, pageErrors.slice(0, 3).join(' / '));
  } finally {
    if (eric) {
      await press(eric.page, CONTROLS.stopShare, { timeoutMs: 5_000 }).catch(() => {});
      await press(eric.page, CONTROLS.leave, { timeoutMs: 5_000 }).catch(() => {});
    }
    await browser.close();
  }
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ results, notes }, null, 2));
  const failed = results.filter((r) => !r.ok);
  log(`${results.length - failed.length} of ${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(2);
});
