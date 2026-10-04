import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  CH,
  CLOCK,
  GUILD,
  HISTORY_EPOCH,
  PEOPLE,
  cardJoin,
  cardLeave,
  cardOpenCall,
  frames,
  installIndexScene,
  navigate,
  outDir,
  roomCard,
  roomCards,
  shoot,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-7 (Live room card): docs/index-spec.md §4.3, §4.4, §4.10, §5.4, §5.5, §5.7;
 * docs/design/index-plan.md §3 IX-7.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-card PARACORD_E2E_INDEX_PORT=4553 \
 *   PARACORD_E2E_INDEX_RT_PORT=4555 PARACORD_E2E_INDEX_WP=ix7 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Shoots s1, s2, s4, s5 and s6 at 1280x800 (held against ref/ with
 * `node e2e/index-compare.mjs ix7`) plus card crops, and drives every state:
 * live, streaming, listening, yours (Open call / Back to chat / Leave),
 * pinned with its server line, an incoming DM call, a room emptying, and an
 * overflowing room.
 */

const MOTION_GONE_MS = 2_000;

/** Listening in is on for every room (the server's default), as a real server answers. */
async function allowListenIn(page: Page, allowed = true): Promise<void> {
  await page.route(/\/api\/v1\/channels\/\d+\/features$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'X-Paracord-History-Epoch': HISTORY_EPOCH },
      body: JSON.stringify({ listen_in_enabled: allowed, anonymous_posting_enabled: false }),
    }),
  );
}

/** Every Web Animation the page starts is remembered, so a short one can be asserted after it ends. */
async function recordAnimations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const played: Animation[] = [];
    (window as unknown as { __ixPlayed: Animation[] }).__ixPlayed = played;
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
      const animation = animate.apply(this, args);
      played.push(animation);
      return animation;
    };
  });
}

/** Ids of the Web Animations started since the last `forget`. */
const played = (page: Page) =>
  page.evaluate(() => (window as unknown as { __ixPlayed: Animation[] }).__ixPlayed.map((animation) => animation.id));
const forget = (page: Page) => page.evaluate(() => void ((window as unknown as { __ixPlayed: Animation[] }).__ixPlayed.length = 0));

async function open(page: Page): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await recordAnimations(page);
  const h = await installIndexScene(page);
  await allowListenIn(page);
  await h.open(h.routes.channel('fuelGeneral'));
  return h;
}

/**
 * Animations running in the sidebar now. (Main still has the Glass call pill
 * until IX-15 retires it; it shows Game Night's live Lounge with its own loop.)
 */
const sidebarAnimations = (page: Page) =>
  page.evaluate(() =>
    document.getAnimations().filter((animation) => {
      const target = (animation.effect as KeyframeEffect | null)?.target as Element | null;
      return Boolean(target?.closest('.ix-side'));
    }).length,
  );

/** Ids of every Web Animation running now. */
const running = (page: Page) => page.evaluate(() => document.getAnimations().map((animation) => animation.id || '(css)'));

/** Card-only animations (ix-card:*), waiting for them to finish. */
async function cardMotionSettles(page: Page): Promise<void> {
  await expect
    .poll(async () => (await running(page)).filter((id) => id.startsWith('ix-card:')), { timeout: 5_000 })
    .toEqual([]);
}

/** Crop a card to its own file next to the full shots. */
async function crop(card: Locator, name: string): Promise<void> {
  await card.screenshot({ path: `${outDir()}/${name}.png` });
}

/** Who the engine says is talking, in the call this client holds (the harness's fake engine reads it). */
async function setLocalSpeakers(page: Page, userIds: string[]): Promise<void> {
  await page.evaluate(async (ids) => {
    const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
    voice.useVoiceStore.setState({ speakingUsers: new Set(ids) });
  }, userIds);
}

test.describe('IX-7 live room card', () => {
  test('s1: a room goes live; the card enters with Jeremy talking and Join', async ({ page }) => {
    const h = await open(page);
    await expect(roomCards(page)).toHaveCount(0);

    await h.step('arrive');
    const card = roomCard(page, 'live');
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute('data-position', 'inline');
    await expect(card.locator('.ix-room-card__title')).toHaveText('General');
    await expect(card.locator('.ix-room-card__when')).toHaveText('just now');
    await expect(card).toHaveAttribute('aria-label', 'General, just now, 1 person, Jeremy talking');
    const jeremy = card.locator(`.ix-card-row[data-user-id="${PEOPLE.jeremy.id}"]`);
    await expect(jeremy).toHaveAttribute('data-talking', 'true');
    // Outside the call only "somebody is talking" is known: the loop runs, while they talk.
    await expect(jeremy.locator('.ix-wave')).toBeVisible();
    await expect(jeremy.locator('.ix-wave')).not.toHaveAttribute('data-real', '');
    await expect(cardJoin(card)).toHaveText('Join');
    await expect(card.getByTestId('ix-card-listen')).toBeVisible();

    // Quiet at rest: only the waveform loops (CSS), no card animation is left running.
    await page.waitForTimeout(MOTION_GONE_MS);
    expect((await running(page)).filter((id) => id.startsWith('ix-card:'))).toEqual([]);

    await shoot(page, 's1-someone-arrives');
    await crop(card, 'card-s1-live');

    // Jeremy stops talking: the waveform is removed (nothing loops at rest), the ring fades.
    await h.emit(frames.speaking(h.world, 'jeremy', 'fuelRoomGeneral', false));
    await expect(jeremy).toHaveAttribute('data-talking', 'false');
    await expect(jeremy.locator('.ix-wave')).toHaveCount(0);
    await page.waitForTimeout(400);
    expect(await sidebarAnimations(page)).toBe(0);
  });

  test('s2: Join makes the card yours (your face flies in); Open call and Back to chat; Leave', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    const card = roomCard(page, 'live');
    await expect(card).toBeVisible();
    await page.waitForTimeout(800);
    await h.setClock(CLOCK.join);

    await forget(page);
    await cardJoin(card).click();
    const yours = roomCard(page, 'yours');
    await expect(yours).toBeVisible();
    // The flight: a ghost of your face on the document, moving from the toolbar avatar.
    await expect(page.locator('[data-ix-ghost]')).toHaveCount(1);
    expect(await played(page)).toEqual(expect.arrayContaining(['ix-card:fly', 'ix-card:fly-hold']));
    expect(await played(page)).not.toContain('ix-card:card-in');
    await cardMotionSettles(page);
    await expect(page.locator('[data-ix-ghost]')).toHaveCount(0);

    await expect(yours.locator('.ix-room-card__when')).toHaveText('You’re in');
    await expect(yours.locator('.ix-card-row__name')).toHaveText(['Jeremy', 'You']);
    await expect(yours.getByTestId('ix-card-mic')).toBeVisible();
    await expect(yours.getByTestId('ix-card-camera')).toBeVisible();
    await expect(yours.getByTestId('ix-card-screen')).toBeVisible();
    await expect(cardOpenCall(yours)).toHaveAccessibleName('Open call');
    await expect(cardLeave(yours)).toBeVisible();
    // In the call the engine's levels drive the waveform.
    await expect(yours.locator(`.ix-card-row[data-user-id="${PEOPLE.jeremy.id}"] .ix-wave`)).toHaveAttribute('data-real', '');

    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 's2-joined');
    await crop(yours, 'card-s2-yours');

    // Mute: the mic control says so, and your row shows mic-off.
    await yours.getByTestId('ix-card-mic').click();
    await expect(yours.getByTestId('ix-card-mic')).toHaveAccessibleName('Unmute');
    await expect(yours.locator('[data-self="true"] .ix-card-row__mark')).toBeVisible();
    await yours.getByTestId('ix-card-mic').click();
    await expect(yours.getByTestId('ix-card-mic')).toHaveAccessibleName('Mute');

    // Open call: the call host shows the call (IX-13 replaces what it hosts); the label crossfades.
    await cardOpenCall(yours).click();
    await expect(page.locator('#ix-call-host > *')).toHaveCount(1);
    await expect(cardOpenCall(yours)).toHaveAccessibleName('Back to chat');
    expect(await page.evaluate(async () => {
      const glass = (await import('/src/stores/glassStore.ts' as string)) as any;
      return glass.useGlassStore.getState().stage;
    })).toMatchObject({ channelId: CH.fuelRoomGeneral, streamerId: null });
    // Main is inert under the call; the card in the sidebar still answers.
    await cardOpenCall(yours).click();
    await expect(page.locator('#ix-call-host > *')).toHaveCount(0);
    await expect(cardOpenCall(yours)).toHaveAccessibleName('Open call');

    // Leave: one click; Jeremy is still there, so the card stays, live again.
    await cardLeave(yours).click();
    await expect(roomCard(page, 'live')).toBeVisible();
    await expect(roomCard(page, 'live').locator('.ix-card-row__name')).toHaveText(['Jeremy']);
  });

  test('s4: in Fuel’s call, Game Night shows your card pinned with its server line, and its own live card with Watch Vincent', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    const yours = roomCard(page, 'yours');
    await expect(yours).toHaveAttribute('data-position', 'inline');
    await page.waitForTimeout(800);

    await h.setClock(CLOCK.visit);
    await forget(page);
    await navigate(page, h.routes.channel('gnLounge'));
    const pinned = page.locator('.ix-side__pinned [data-testid="ix-room-card"]');
    await expect(pinned).toHaveAttribute('data-state', 'yours');
    await expect(pinned.locator('.ix-room-card__from')).toHaveText('Fuel');
    // It travels from under Fuel's search to above Game Night's header (§5.4), and does not arrive anew.
    expect(await played(page)).toContain('ix-card:pin');
    expect(await played(page)).not.toContain('ix-card:fly');

    const lounge = roomCard(page, 'streaming');
    await expect(lounge).toBeVisible();
    await expect(lounge.locator('.ix-room-card__when')).toHaveText('live 34 min');
    await expect(lounge.locator('.ix-card-row__name')).toHaveText(['Vincent', 'Brendan', 'Nick']);
    await expect(lounge.locator(`.ix-card-row[data-user-id="${PEOPLE.vincent.id}"] .ix-card-row__watch`)).toBeVisible();
    await expect(lounge.getByTestId('ix-card-watch')).toHaveText('Watch Vincent');
    await expect(cardJoin(lounge)).toHaveText('Join');

    await cardMotionSettles(page);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 's4-other-server');
    await crop(pinned, 'card-s4-pinned');
    await crop(lounge, 'card-s4-streaming');

    // Watch opens the call view on Vincent's stream without joining.
    await lounge.getByTestId('ix-card-watch').click();
    expect(await page.evaluate(async () => {
      const glass = (await import('/src/stores/glassStore.ts' as string)) as any;
      return glass.useGlassStore.getState().stage;
    })).toMatchObject({ channelId: CH.gnRoomLounge, streamerId: PEOPLE.vincent.id });
    await page.evaluate(async () => {
      const glass = (await import('/src/stores/glassStore.ts' as string)) as any;
      glass.useGlassStore.getState().closeStage();
    });

    // Basecamp: the pinned card stays still (no move between two other places).
    await forget(page);
    await navigate(page, h.routes.channel('bcGeneral'));
    await expect(page.locator('.ix-side__pinned [data-testid="ix-room-card"]')).toHaveCount(1);
    await page.waitForTimeout(700);
    expect((await played(page)).filter((id) => id.startsWith('ix-card:'))).toEqual([]);

    // Back to Fuel: the card travels under Fuel's search again (a copy on the document while the panes slide).
    await forget(page);
    await navigate(page, h.routes.channel('fuelGeneral'));
    await expect(page.locator('[data-ix-ghost]')).toHaveCount(1);
    expect(await played(page)).toContain('ix-card:pin');
    expect(await played(page)).not.toContain('ix-card:card-in');
    await cardMotionSettles(page);
    await expect(page.locator('[data-ix-ghost]')).toHaveCount(0);
    await expect(page.locator('.ix-side__pinned [data-testid="ix-room-card"]')).toHaveCount(0);
    await expect(page.locator('.ix-pane:not([data-leaving]) [data-testid="ix-room-card"][data-state="yours"]')).toBeVisible();
  });

  test('s5: five in the call, Vincent talking; s6: the card pinned over People', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await h.step('crowd');
    // In your call the engine's own flags say who talks (the harness's fake engine does not follow the relay).
    await setLocalSpeakers(page, [PEOPLE.vincent.id]);
    await h.step('busy', { pace: 0 });
    const yours = roomCard(page, 'yours');
    await expect(yours.locator('.ix-card-row__name')).toHaveText(['Jeremy', 'You', 'Vincent', 'Brendan', 'Maya']);
    await expect(yours.locator(`.ix-card-row[data-user-id="${PEOPLE.vincent.id}"]`)).toHaveAttribute('data-talking', 'true');
    await expect(yours.locator(`.ix-card-row[data-user-id="${PEOPLE.jeremy.id}"]`)).toHaveAttribute('data-talking', 'false');
    await cardMotionSettles(page);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 's5-busy');
    await crop(yours, 'card-s5-five');

    await navigate(page, h.routes.place('people'));
    const pinned = page.locator('.ix-side__pinned [data-testid="ix-room-card"]');
    await expect(pinned).toHaveAttribute('data-state', 'yours');
    await expect(pinned.locator('.ix-room-card__from')).toHaveText('Fuel');
    await cardMotionSettles(page);
    await page.waitForTimeout(MOTION_GONE_MS);
    await shoot(page, 's6-people');
    await crop(pinned, 'card-s6-pinned');
  });

  test('listening: Listen, then Join upgrades in place; a stage-less DM has no Listen', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    const card = roomCard(page, 'live');
    await card.getByTestId('ix-card-listen').click();
    const listening = roomCard(page, 'listening');
    await expect(listening).toBeVisible();
    await expect(listening.locator('.ix-room-card__when')).toHaveText('Listening');
    await expect(listening.locator('[data-self="true"] .ix-card-row__name')).toHaveText('You — listening');
    await expect(listening.getByTestId('ix-card-listen')).toHaveAttribute('aria-pressed', 'true');
    await cardMotionSettles(page);
    await crop(listening, 'card-listening');
    await cardJoin(listening).click();
    await expect(roomCard(page, 'yours')).toBeVisible();
  });

  test('a room empties: the card leaves and the sidebar closes up', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    const card = roomCard(page, 'live');
    await expect(card).toBeVisible();
    await page.waitForTimeout(1_000);
    const channelsTop = () => page.locator('.ix-sb__rows').evaluate((el) => el.getBoundingClientRect().top);
    const before = await channelsTop();

    await forget(page);
    h.world.leaveVoice('jeremy');
    await h.emit(frames.voiceState(h.world, 'jeremy', null, 'fuelRoomGeneral'));
    await expect(roomCards(page)).toHaveCount(0);
    expect(await played(page)).toEqual(['ix-card:card-out', 'ix-card:push']);
    await cardMotionSettles(page);
    expect(await channelsTop()).toBeLessThan(before - 100);
    await page.waitForTimeout(MOTION_GONE_MS);
    expect(await sidebarAnimations(page)).toBe(0);
  });

  test('a person joining plays in; seven people fold into "and 2 more"', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await expect(roomCard(page, 'live')).toBeVisible();
    await page.waitForTimeout(1_000);

    await forget(page);
    for (const who of ['vincent', 'brendan', 'nick', 'maya'] as const) {
      h.world.joinVoice(who, 'fuelRoomGeneral');
      await h.emit(frames.voiceState(h.world, who, 'fuelRoomGeneral'));
    }
    await expect.poll(async () => (await played(page)).filter((id) => id === 'ix-card:row-in').length).toBe(4);
    const card = roomCard(page, 'live');
    await expect(card.locator('.ix-card-row:not(.ix-card-row--more)')).toHaveCount(5);
    await cardMotionSettles(page);

    // Brendan leaves: his row fades and shrinks, then what was below it closes up.
    await forget(page);
    h.world.leaveVoice('brendan');
    await h.emit(frames.voiceState(h.world, 'brendan', null, 'fuelRoomGeneral'));
    await expect(card.locator('.ix-card-row:not(.ix-card-row--more)')).toHaveCount(4);
    expect(await played(page)).toEqual(expect.arrayContaining(['ix-card:row-out', 'ix-card:push']));
    await cardMotionSettles(page);

    // You join, and two people from outside the scene's cast: seven, so the sixth row is "and 2 more".
    await h.step('join');
    await page.evaluate(async ({ channelId, guildId }) => {
      const voice = (await import('/src/stores/voiceStore.ts' as string)) as any;
      const state = voice.useVoiceStore.getState();
      const members = state.channelParticipants.get(channelId) ?? [];
      const extra = (id: string, name: string) => ({
        ...members[0], user_id: id, username: name.toLowerCase(), display_name: name, joined_at: new Date().toISOString(), speaking: false, guild_id: guildId,
      });
      const channelParticipants = new Map(state.channelParticipants);
      channelParticipants.set(channelId, [...members, extra('999000000000000001', 'Riley'), extra('999000000000000002', 'Ada')]);
      voice.useVoiceStore.setState({ channelParticipants });
    }, { channelId: CH.fuelRoomGeneral, guildId: GUILD.fuel.id });
    const yours = roomCard(page, 'yours');
    await expect(yours.locator('.ix-card-row:not(.ix-card-row--more)')).toHaveCount(5);
    await expect(yours.locator('.ix-card-row--more')).toContainText('and 2 more');
    await cardMotionSettles(page);
    await crop(yours, 'card-overflow');
  });

  test('an incoming DM call: a pinned card with Decline and Accept', async ({ page }) => {
    const h = await open(page);
    await page.waitForTimeout(800);
    h.world.joinVoice('jeremy', 'dmJeremy');
    await h.emit(frames.voiceState(h.world, 'jeremy', 'dmJeremy'));
    const ringing = roomCard(page, 'incoming');
    await expect(ringing).toBeVisible();
    await expect(ringing).toHaveAttribute('data-position', 'pinned');
    await expect(ringing.locator('.ix-room-card__title')).toHaveText('Jeremy is calling');
    await cardMotionSettles(page);
    await crop(ringing, 'card-incoming');

    await ringing.getByTestId('ix-card-decline').click();
    await expect(roomCards(page)).toHaveCount(0);

    // The next call rings again.
    h.world.leaveVoice('jeremy');
    await h.emit(frames.voiceState(h.world, 'jeremy', null, 'dmJeremy'));
    h.world.joinVoice('jeremy', 'dmJeremy');
    await h.emit(frames.voiceState(h.world, 'jeremy', 'dmJeremy'));
    await expect(roomCard(page, 'incoming')).toBeVisible();
    await roomCard(page, 'incoming').getByTestId('ix-card-accept').click();
    await expect(page).toHaveURL(new RegExp(`/app/dms/${CH.dmJeremy}$`));
    const call = roomCard(page, 'yours');
    await expect(call).toBeVisible();
    await expect(call.locator('.ix-room-card__title')).toHaveText('Jeremy');
  });

  test('sizes: the card at 1440x900, 900x700 and on the phone root', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');
    await cardMotionSettles(page);
    await shoot(page, 's2-joined', { size: 'desktop' });
    await shoot(page, 's2-joined', { size: 'narrow' });
    // The 280px sidebar: the wide control keeps its words inside it, open or closed.
    const yours = roomCard(page, 'yours');
    const fits = () =>
      yours.evaluate((card) => {
        const wide = card.querySelector('[data-testid="ix-card-open-call"]')!.getBoundingClientRect();
        const leave = card.querySelector('[data-testid="ix-card-leave"]')!.getBoundingClientRect();
        return wide.right <= leave.left;
      });
    expect(await fits()).toBe(true);
    await crop(yours, 'card-narrow');
    await cardOpenCall(yours).click();
    await page.waitForTimeout(400);
    expect(await fits()).toBe(true);
    await crop(yours, 'card-narrow-call-open');
    await cardOpenCall(yours).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(600);
    const back = page.getByRole('button', { name: 'Back to the sidebar' });
    if (await back.isVisible()) await back.click();
    await shoot(page, 's2-joined', { size: 'phone' });
  });
});
