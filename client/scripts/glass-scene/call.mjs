// The Lounge call: Vincent sharing his screen, Brendan on camera and talking,
// Nick muted — each in their own Chromium, joined through the app's own
// controls, publishing over the app's own media engine. Held until closed.

import { CALL, CAST } from './scene.mjs';
import { FACES, STREAM_SCENE } from './art.mjs';
import { CONTROLS, channelPath, findControl, joinVoice, launchBrowser, openAs, press, waitForControl } from './ui.mjs';

/** Read the relay's live view of the room (side-effect free). */
export async function readRoom(api, token, channelId) {
  return api.request(token, 'GET', `/voice/${channelId}/media-stats`);
}

/**
 * True when another process is holding the call right now: every member is
 * connected at the relay *and* video is still arriving from the publishers.
 * Connection alone is not enough — a holder that just exited leaves its
 * participants registered until the relay retires them.
 */
export async function callAlreadyHeld(api, people, ids) {
  const channelId = ids.servers[CALL.server].channels[CALL.channel];
  const read = async () => {
    const room = await readRoom(api, people.jeremy.token, channelId).catch(() => null);
    return new Map((room?.participants ?? []).map(p => [String(p.user_id), p]));
  };
  const before = await read();
  if (!CALL.members.every(m => before.has(people[m.who].id))) return false;
  await new Promise(resolve => setTimeout(resolve, 2500));
  const after = await read();
  return CALL.members.every(m => {
    const id = people[m.who].id;
    if (!after.has(id)) return false;
    if (!m.share && !m.camera) return true;
    return (after.get(id).video_datagrams_received ?? 0) > (before.get(id).video_datagrams_received ?? 0);
  });
}

/** Leave through the API as well as the UI, so the relay retires the seat now rather than on idle. */
export async function leaveCall(api, person, channelId) {
  await api.request(person.token, 'POST', `/api/v2/voice/${channelId}/leave`, {}).catch(() => {});
}

export async function startCall({ api, base, people, ids, headless = true, log = () => {} }) {
  const path = channelPath(ids, CALL.server, CALL.channel);
  const channelId = ids.servers[CALL.server].channels[CALL.channel];
  const members = [];

  async function bringIn(spec) {
    const person = people[spec.who];
    const browser = await launchBrowser({ headless });
    const media = {
      display: Boolean(spec.share),
      camera: Boolean(spec.camera),
      voice: spec.voice ?? 'quiet',
      face: FACES[CAST[spec.who].name],
      scene: STREAM_SCENE,
    };
    const session = await openAs(browser, base, person, { viewport: { width: 1280, height: 800 }, media, log });
    const member = { spec, person, browser, session };
    await joinVoice(session, path, { log });
    const { page } = session;
    if (spec.share) {
      await press(page, CONTROLS.share);
      await waitForControl(page, CONTROLS.stopShare, 30_000);
    }
    if (spec.camera) {
      await press(page, CONTROLS.cameraOn);
      await waitForControl(page, CONTROLS.cameraOff, 30_000);
    }
    if (spec.mute) {
      await press(page, CONTROLS.mute);
      await waitForControl(page, CONTROLS.unmute, 15_000);
    }
    const doing = [spec.share && 'sharing', spec.camera && 'camera on', spec.voice === 'talking' && 'talking', spec.mute && 'muted'].filter(Boolean);
    log(`  ${person.name} joined Lounge${doing.length ? ` (${doing.join(', ')})` : ''}`);
    return member;
  }

  log('\nLounge call');
  try {
    for (const spec of CALL.members) members.push(await bringIn(spec));
  } catch (error) {
    for (const member of members) await member.browser.close().catch(() => {});
    throw error;
  }

  // The server has to agree, not just the buttons: everyone connected at the
  // relay, and video actually arriving from the ones who publish it.
  const deadline = Date.now() + 90_000;
  let room = null;
  for (;;) {
    room = await readRoom(api, people.jeremy.token, channelId);
    const byUser = new Map((room.participants ?? []).map(p => [String(p.user_id), p]));
    const ready = CALL.members.every(spec => {
      const p = byUser.get(people[spec.who].id);
      if (!p) return false;
      if (spec.share || spec.camera) return (p.video_datagrams_received ?? 0) > 0 || (p.stream_frames_received ?? 0) > 0;
      return true;
    });
    if (ready) break;
    if (Date.now() > deadline) {
      throw new Error(`the relay never showed the whole call publishing: ${JSON.stringify(room).slice(0, 800)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  log(`  relay: ${room.connected_participants} connected over ${[...new Set(room.participants.map(p => p.transport))].join('/')}`);

  return {
    channelId,
    members,
    /** Rejoin anyone the relay no longer has (a crashed tab, a dropped session). */
    async heal(connectedIds) {
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (connectedIds.has(member.person.id)) continue;
        log(`  ${member.person.name} dropped out of the call; bringing them back`);
        await member.browser.close().catch(() => {});
        members[i] = await bringIn(member.spec);
      }
    },
    /** Everyone leaves and joins again in fresh browsers (SIGUSR2 on a holder). */
    async recycle() {
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        await leaveCall(api, member.person, channelId);
        await member.browser.close().catch(() => {});
        members[i] = await bringIn(member.spec);
      }
    },
    async close() {
      for (const member of members) {
        const leave = await findControl(member.session.page, CONTROLS.leave).catch(() => null);
        if (leave) await leave.click({ timeout: 2000 }).catch(() => {});
        await leaveCall(api, member.person, channelId);
        await member.browser.close().catch(() => {});
      }
      // A page's own leave can still be in flight when its browser goes; make
      // sure nobody is left registered in the room for the next run.
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const room = await readRoom(api, people.jeremy.token, channelId).catch(() => null);
        const still = members.filter(m => (room?.participants ?? []).some(p => String(p.user_id) === m.person.id));
        if (still.length === 0) break;
        for (const member of still) await leaveCall(api, member.person, channelId);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    },
  };
}

/** Frames each cast page has produced (display scene / camera) and the talker's level. */
export async function mediaProbe(member) {
  return member.session.page.evaluate(() => {
    const s = window.__glassSceneMedia;
    return s ? { displayFrames: s.displayFrames, cameraFrames: s.cameraFrames, voiceLevel: s.voiceLevel } : null;
  }).catch(() => null);
}
