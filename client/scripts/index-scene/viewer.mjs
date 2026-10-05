// The viewer: Sean, in one Chromium that lives as long as the scene does.
//
// One browser, because the story is one person's evening: they join a call in
// one place, open it, look at another server with the call still held, come
// back. Everything the viewer does is client-side navigation (ui.mjs
// `navigate`): a full page load would drop the call and lock their encryption
// again, and the Direct messages in People are unreadable while it is locked.

import { takeAnyUnlockOffer } from './dms.mjs';
import { dismissOverlays, guildPath, isJoined, joinRoom, leaveRoom, navigate, openPersistentSession, settle } from './ui.mjs';
import { SERVERS } from './scene.mjs';

export class Viewer {
  constructor({ uiBase, ids, person, dmId = null, profileDir, headless = true, log = () => {}, viewport = { width: 1280, height: 800 } }) {
    this.dmId = dmId;
    this.profileDir = profileDir;
    this.uiBase = uiBase;
    this.ids = ids;
    this.person = person;
    this.headless = headless;
    this.log = log;
    this.viewport = viewport;
    this.browser = null;
    this.session = null;
    /** Whether the page has seen its encryption unlocked since it last loaded. */
    this.unlocked = false;
  }

  get page() { return this.session.page; }
  useIds(ids) { this.ids = ids; }

  async open() {
    // A quiet synthetic microphone, so joining a call does not put Chromium's
    // test beep into the room.
    this.session = await openPersistentSession(this.uiBase, this.person, {
      profileDir: this.profileDir, headless: this.headless, viewport: this.viewport, media: { voice: 'quiet' }, log: this.log,
    });
    this.browser = null;
    await this.unlock();
  }

  /**
   * Unlock encryption once, the way a person does: open an encrypted
   * conversation and take the composer's "Unlock encryption" offer (the
   * /unlock page on its own bounces back while the runtime is still deciding
   * whether the account is enrolled). A full load, which is fine now: nothing
   * is held yet. Everything after is client-side.
   */
  async unlock() {
    const { page } = this;
    if (!this.dmId) {
      this.log('  (the scene has no Direct messages, so there is nothing to unlock; People will be empty)');
      return;
    }
    await page.goto(`/app/dms/${this.dmId}`);
    await dismissOverlays(page, 700, 6000);
    await page.locator('textarea[data-composer-input]').first().waitFor({ state: 'visible', timeout: 30_000 });
    await takeAnyUnlockOffer(page);
    // Unlocked once the composer stops offering to.
    this.unlocked = !(await page.getByRole('link', { name: 'Unlock encryption' }).isVisible().catch(() => false));
    this.log(`  ${this.person.name} ${this.unlocked ? 'unlocked' : 'could NOT unlock'} encryption`);
    if (!this.unlocked) {
      throw new Error(
        `the viewer could not unlock encryption, so People would show locked conversations. The identity lives in the viewer's profile for the origin the DMs were seeded from; ` +
        `the app is being served from ${new URL(this.uiBase).origin}. Serve the app from the instance itself, or run with --no-dms.`,
      );
    }
  }

  async size(viewport) {
    this.viewport = viewport;
    await this.page.setViewportSize(viewport);
  }

  /** A text channel of a server, without a reload. */
  async go(serverKey, channelKey, opts) {
    await navigate(this.page, guildPath(this.ids, serverKey, channelKey), opts);
  }

  async goDm(channelId, opts) {
    await navigate(this.page, `/app/dms/${channelId}`, opts);
  }

  async joined() { return isJoined(this.page); }

  async join(serverKey, roomKey) {
    const spec = SERVERS.find(s => s.key === serverKey);
    const room = spec.channels.find(c => c.key === roomKey);
    const text = spec.channels.find(c => c.type === 0);
    await joinRoom(this.session, {
      textPath: guildPath(this.ids, serverKey, text.key),
      roomName: room.name,
      log: this.log,
    });
    this.log(`  ${this.person.name} joined ${spec.name} › ${room.name}`);
  }

  async leave() {
    if (await this.joined()) {
      await leaveRoom(this.session);
      this.log(`  ${this.person.name} left the call`);
    }
  }

  async settle(opts) { await settle(this.page, opts); }

  async close() {
    await this.session?.context.close().catch(() => {});
    this.session = null;
  }
}
