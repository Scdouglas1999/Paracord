// The people other than the viewer: each in their own Chromium, signed in
// through the app's own login page, joined to rooms through the app's own
// controls, publishing over the app's own media engine. Held until closed.
//
// What is shared with the other scene drivers, by import (`../scene-lib/`): the
// synthetic media (`media-init.mjs`, through `openAs`: Vincent's canvas share,
// a speech-like microphone, silence), and the relay probes (`call.mjs`:
// `readRoom`, `leaveCall`, `mediaProbe`). `call.mjs`'s own `startCall` is not
// called because it is fixed to the Glass cast (Brendan on camera and talking,
// Vincent quiet) and to Glass's pill; the Index story needs members that join
// and move at a step, and this file runs them through `ui.mjs`, which speaks
// both Glass and Index.

import { leaveCall, mediaProbe, readRoom } from '../scene-lib/call.mjs';
import { FACES, STREAM_SCENE } from '../scene-lib/art.mjs';
import { launchBrowser, openAs } from '../scene-lib/ui.mjs';
import { SERVERS } from './scene.mjs';
import { guildPath, isJoined, joinRoom, leaveRoom, navigate, setMic, startShare } from './ui.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Cast {
  constructor({ api, uiBase, ids, people, headless = true, log = () => {} }) {
    this.api = api;
    this.uiBase = uiBase;
    this.ids = ids;
    this.people = people;
    this.headless = headless;
    this.log = log;
    /** key → { key, person, browser, session, spec, room } */
    this.members = new Map();
  }

  /** The scene ids changed (Fuel was rebuilt): later joins use the new ones. */
  useIds(ids) { this.ids = ids; }

  has(key) { return this.members.has(key); }
  get(key) {
    const member = this.members.get(key);
    if (!member) throw new Error(`${key} has no browser open`);
    return member;
  }

  /** Open a browser for this person and sign them in. Online from here on. */
  async start(key, spec = {}) {
    if (this.members.has(key)) return this.members.get(key);
    const person = this.people[key];
    const browser = await launchBrowser({ headless: this.headless });
    const media = {
      display: Boolean(spec.share),
      camera: Boolean(spec.camera),
      voice: spec.voice ?? 'quiet',
      face: FACES[person.name],
      scene: STREAM_SCENE,
    };
    let session;
    try {
      session = await openAs(browser, this.uiBase, person, { viewport: { width: 1280, height: 800 }, media, log: this.log });
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
    // `sharing` is what the member is doing now, not what they were set up to
    // do: leaving a room ends the share.
    const member = { key, person, browser, session, spec, room: null, sharing: false };
    this.members.set(key, member);
    return member;
  }

  roomChannelId(serverKey, roomKey) {
    const id = this.ids.servers[serverKey]?.channels[roomKey];
    if (!id) throw new Error(`no room ${serverKey}/${roomKey} in the scene`);
    return id;
  }

  /** Join a room and turn the microphone on (or leave it off for `spec.mute`). */
  async join(key, serverKey, roomKey) {
    const member = this.get(key);
    const spec = SERVERS.find(s => s.key === serverKey);
    const room = spec.channels.find(c => c.key === roomKey);
    const text = spec.channels.find(c => c.type === 0);
    this.roomChannelId(serverKey, roomKey);
    await joinRoom(member.session, {
      roomPath: guildPath(this.ids, serverKey, roomKey),
      textPath: guildPath(this.ids, serverKey, text.key),
      roomName: room.name,
      log: this.log,
    });
    member.room = { server: serverKey, room: roomKey };
    // Everyone who is not meant to be muted turns the microphone on; the app
    // joins muted by default.
    await setMic(member.session, !member.spec.mute);
    const doing = [member.spec.share && 'will share', member.spec.voice === 'talking' && 'talking', member.spec.mute && 'muted'].filter(Boolean);
    this.log(`  ${member.person.name} joined ${spec.name} › ${room.name}${doing.length ? ` (${doing.join(', ')})` : ''}`);
  }

  async share(key) {
    const member = this.get(key);
    await startShare(member.session);
    member.sharing = true;
    this.log(`  ${member.person.name} is sharing their screen`);
  }

  async setMic(key, on) {
    await setMic(this.get(key).session, on);
  }

  /** Leave through the app, and through the API so the relay retires the seat now. */
  async leave(key) {
    const member = this.get(key);
    if (!member.room) return;
    const channelId = this.roomChannelId(member.room.server, member.room.room);
    if (await isJoined(member.session.page)) await leaveRoom(member.session);
    await leaveCall(this.api, member.person, channelId);
    this.log(`  ${member.person.name} left ${this.roomName(member.room)}`);
    member.room = null;
    member.sharing = false;
  }

  roomName(room) {
    const spec = SERVERS.find(s => s.key === room.server);
    return `${spec.name} › ${spec.channels.find(c => c.key === room.room).name}`;
  }

  /** Move to another room: leave, wait until the relay agrees, join. */
  async move(key, serverKey, roomKey) {
    const member = this.get(key);
    const from = member.room;
    await this.leave(key);
    if (from) await this.untilGone(key, from);
    // Back to a text channel of the new server, without a reload (a reload
    // would be a fresh page that never held the old call anyway; this is what
    // a person's click does).
    const spec = SERVERS.find(s => s.key === serverKey);
    const text = spec.channels.find(c => c.type === 0);
    await navigate(member.session.page, guildPath(this.ids, serverKey, text.key));
    await this.join(key, serverKey, roomKey);
  }

  /** Close the browser, leaving first. */
  async stop(key) {
    const member = this.members.get(key);
    if (!member) return;
    if (member.room) {
      const channelId = this.roomChannelId(member.room.server, member.room.room);
      await leaveCall(this.api, member.person, channelId).catch(() => {});
    }
    await member.browser.close().catch(() => {});
    this.members.delete(key);
    this.log(`  ${member.person.name} is offline`);
  }

  /**
   * Everyone leaves and goes offline. A page's own leave can still be in flight
   * when its browser goes, so afterwards the relay is asked until nobody from
   * the cast is left in any room: the next run starts from an empty Lounge.
   */
  async stopAll() {
    const keys = [...this.members.keys()];
    // The viewer is not the cast's, but their seat goes with the scene too.
    const everyone = [...new Set([...keys, 'sean'].map(key => this.people[key].id))];
    for (const key of keys) await this.stop(key);
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      let left = 0;
      for (const [serverKey, server] of Object.entries(this.ids.servers)) {
        for (const [roomKey, channelId] of Object.entries(server.channels)) {
          const spec = SERVERS.find(s => s.key === serverKey).channels.find(c => c.key === roomKey);
          if (spec.type !== 2) continue;
          const here = await this.occupants(serverKey, roomKey).catch(() => new Set());
          for (const id of everyone) {
            if (!here.has(id)) continue;
            left += 1;
            const person = Object.values(this.people).find(p => p.id === id);
            await leaveCall(this.api, person, channelId);
          }
        }
      }
      if (left === 0) return;
      await sleep(1000);
    }
  }

  // ---------------------------------------------------------- the relay

  async room(serverKey, roomKey) {
    const viewer = this.people.sean;
    return readRoom(this.api, viewer.token, this.roomChannelId(serverKey, roomKey));
  }

  /** The user ids the relay has in a room. */
  async occupants(serverKey, roomKey) {
    const room = await this.room(serverKey, roomKey).catch(() => null);
    return new Set((room?.participants ?? []).map(p => String(p.user_id)));
  }

  async untilGone(key, room, timeoutMs = 20_000) {
    const id = this.people[key].id;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (!(await this.occupants(room.server, room.room)).has(id)) return;
      if (Date.now() > deadline) throw new Error(`the relay still has ${this.people[key].name} in ${this.roomName(room)} after ${timeoutMs / 1000}s`);
      await sleep(500);
    }
  }

  /**
   * The server has to agree, not just the buttons: everyone connected at the
   * relay, and video actually arriving from whoever shares.
   */
  async untilPublishing(serverKey, roomKey, keys, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    let room = null;
    for (;;) {
      room = await this.room(serverKey, roomKey);
      const byUser = new Map((room.participants ?? []).map(p => [String(p.user_id), p]));
      const ready = keys.every(key => {
        const p = byUser.get(this.people[key].id);
        if (!p) return false;
        const member = this.members.get(key);
        if (member?.sharing || member?.spec.camera) return (p.video_datagrams_received ?? 0) > 0 || (p.stream_frames_received ?? 0) > 0;
        return true;
      });
      if (ready) return room;
      if (Date.now() > deadline) {
        throw new Error(`the relay never showed ${keys.join(', ')} publishing in ${serverKey}/${roomKey}: ${JSON.stringify(room).slice(0, 700)}`);
      }
      await sleep(1000);
    }
  }

  /**
   * One line about each room that has anyone in it, for the holder's status:
   * who is there, who shares, and what the relay is receiving from each (video
   * and audio packets a second since the last line), so "Lounge holds with real
   * audio and a real share" is a number, not a feeling.
   */
  async statusLine() {
    const parts = [];
    const now = Date.now();
    const seconds = Math.max(1, (now - (this.lastStatusAt ?? now - 30_000)) / 1000);
    const last = this.lastCounters ?? new Map();
    const next = new Map();
    for (const [serverKey, server] of Object.entries(this.ids.servers)) {
      for (const [roomKey, channelId] of Object.entries(server.channels)) {
        const spec = SERVERS.find(s => s.key === serverKey).channels.find(c => c.key === roomKey);
        if (spec.type !== 2) continue;
        const room = await readRoom(this.api, this.people.sean.token, channelId).catch(() => null);
        const here = (room?.participants ?? []).map(p => {
          const id = String(p.user_id);
          const who = Object.values(this.people).find(x => x.id === id)?.name ?? id;
          const member = [...this.members.values()].find(m => m.person.id === id);
          const video = p.video_datagrams_received ?? 0;
          const audio = p.audio_datagrams_received ?? 0;
          const before = last.get(id);
          next.set(id, { video, audio });
          const tags = [];
          if (member?.sharing) tags.push('sharing');
          if (before && video > before.video) tags.push(`${Math.round((video - before.video) / seconds)} video pkt/s`);
          if (before && audio > before.audio) tags.push(`${Math.round((audio - before.audio) / seconds)} audio pkt/s`);
          return `${who}${tags.length ? ` (${tags.join(', ')})` : ''}`;
        });
        if (here.length) parts.push(`${spec.name}: ${here.join(', ')}`);
      }
    }
    this.lastCounters = next;
    this.lastStatusAt = now;
    return parts.length ? parts.join(' \u00b7 ') : 'no room has anyone in it';
  }

  /** Rejoin anyone the relay no longer has (a crashed tab, a dropped session). */
  async heal() {
    for (const member of this.members.values()) {
      if (!member.room) continue;
      const here = await this.occupants(member.room.server, member.room.room);
      if (here.has(member.person.id)) continue;
      this.log(`  ${member.person.name} dropped out of ${this.roomName(member.room)}; bringing them back`);
      const room = member.room;
      const wasSharing = member.sharing;
      member.room = null;
      member.sharing = false;
      await navigate(member.session.page, '/app');
      await this.join(member.key, room.server, room.room);
      if (wasSharing) await this.share(member.key);
    }
  }

  /** What each browser is producing: frames and the talker's level. */
  async probe() {
    const out = {};
    for (const member of this.members.values()) out[member.key] = await mediaProbe(member);
    return out;
  }
}
