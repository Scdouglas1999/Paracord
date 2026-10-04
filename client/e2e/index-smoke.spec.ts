import { expect, test, type Page } from '@playwright/test';
import {
  CH,
  CLOCK,
  GUILD,
  PEOPLE,
  SCENE_TIMEZONE,
  actionCard,
  channelRow,
  composer,
  dockItem,
  installIndexScene,
  navigate,
  outDir,
  roomCard,
  shoot,
  TEST_IDS,
  type IndexHarness,
} from './fixtures/index';

/**
 * IX-0 (review harness): the Index reference scene loads, and every step of its
 * story reaches the page, in TODAY's UI (Glass, until the Index packages replace
 * it). Nothing here asserts Index chrome: it asserts the scene (the stores the
 * page fills from REST and the gateway) and a few facts today's UI shows
 * regardless, so it stays green while the UI is rebuilt around it.
 *
 *   cd client
 *   PARACORD_E2E_INDEX_SPEC=index-smoke PARACORD_E2E_INDEX_WP=ix0 \
 *     npx playwright test -c e2e/index-review.config.ts
 *
 * Output: output/design-reference/index-build/<WP>/ (gitignored): the story's
 * states as today's UI draws them, named like the references they are held
 * against; `node e2e/index-compare.mjs <WP>` pairs them with `ref/`.
 */

/** Read what the page believes, from its own stores. */
async function snapshot(page: Page) {
  return page.evaluate(
    async ({ fuelRoom, lounge }) => {
      const m = async (path: string) => (await import(/* @vite-ignore */ path)) as any;
      const guilds = (await m('/src/stores/guildStore.ts')).useGuildStore.getState().guilds as Array<Record<string, unknown>>;
      const voice = (await m('/src/stores/voiceStore.ts')).useVoiceStore.getState();
      const names = (id: string) => ((voice.channelParticipants.get(id) ?? []) as Array<{ display_name: string }>).map((s) => s.display_name);
      return {
        guilds: guilds
          .map((g) => ({ id: g.id, name: g.name as string, hue: g.hue ?? null, members: g.member_count as number }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        fuelRoom: names(fuelRoom),
        lounge: names(lounge),
        call: { connected: voice.connected as boolean, channelId: voice.channelId as string | null, mode: voice.callMode as string | null },
      };
    },
    { fuelRoom: CH.fuelRoomGeneral, lounge: CH.gnRoomLounge },
  );
}

async function open(page: Page, route?: string): Promise<IndexHarness> {
  await page.setViewportSize({ width: 1280, height: 800 });
  const h = await installIndexScene(page);
  await h.open(route ?? h.routes.channel('fuelGeneral'));
  return h;
}

const heading = (page: Page) => page.getByRole('main').getByRole('heading', { level: 1 });

test.describe('the scene in today\'s UI', () => {
  test('s0: Fuel is new and quiet, Game Night has a live Lounge', async ({ page }) => {
    const h = await open(page);
    await expect(heading(page)).toHaveText('general');

    const seen = await snapshot(page);
    expect(seen.guilds.map((g) => g.name)).toEqual(['Basecamp', 'Fuel', 'Game Night']);
    expect(seen.fuelRoom).toEqual([]);
    expect(seen.lounge.sort()).toEqual(['Brendan', 'Nick', 'Vincent']);
    expect(seen.call.connected).toBe(false);

    // The clock is pinned to the scene and the page is in the scene's zone.
    const time = await page.evaluate(() => ({
      iso: new Date().toISOString(),
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      label: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
    }));
    expect(time.zone).toBe(SCENE_TIMEZONE);
    expect(time.iso).toBe(new Date(CLOCK.start).toISOString());
    expect(time.label).toBe('9:38 PM');
    expect(h.world.nowMs).toBe(Date.parse(CLOCK.start));

    await shoot(page, 's0-quiet');
  });

  test('s1: someone arrives (messages, a clip, the room goes live)', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');

    // Jeremy's two messages arrive live, through the gateway, into the open channel.
    await expect(page.getByText('hey! finally made it in', { exact: true })).toBeVisible();
    await expect(page.getByText('who’s up for a run tonight? I’m in General', { exact: true })).toBeVisible();

    const seen = await snapshot(page);
    expect(seen.fuelRoom).toEqual(['Jeremy']);
    expect(seen.guilds.find((g) => g.name === 'Fuel')?.members).toBe(2);
    expect(h.world.voiceIn('fuelRoomGeneral').map((r) => r.who)).toEqual(['jeremy']);
    // The clock ran through the story and stopped at "just now".
    expect(await page.evaluate(() => new Date().toISOString())).toBe(new Date(CLOCK.arrive).toISOString());

    await shoot(page, 's1-someone-arrives');
  });

  test('s2: you join General (the call is held, in the store)', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');

    const seen = await snapshot(page);
    expect(seen.call).toMatchObject({ connected: true, channelId: CH.fuelRoomGeneral, mode: 'joined' });
    expect(seen.fuelRoom.sort()).toEqual(['Jeremy', 'Sean']);
    await shoot(page, 's2-joined');
  });

  test('s4/s5: another server while in the call, then back to a busy Fuel', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.step('join');

    // Moving between places with a history push keeps the page, its stores and the call.
    await h.setClock(CLOCK.visit);
    await navigate(page, h.routes.place('gameNight'));
    await expect(heading(page)).toHaveText('lounge');
    expect((await snapshot(page)).call.connected).toBe(true);
    // The Lounge went live at 9:12:50 PM; the clock says 9:46:50 PM. The label follows a
    // clock jump without waiting a real minute (the harness fires the page's minute tick).
    await expect(page.getByText(/live 34 min/i).first()).toBeVisible();
    await shoot(page, 's4-other-server');

    await navigate(page, h.routes.channel('fuelGeneral'));
    await expect(heading(page)).toHaveText('general');
    await h.step('crowd');
    await h.step('busy', { pace: 0 });
    await expect(page.getByText('yep, bringing the projector', { exact: true })).toBeVisible();

    const seen = await snapshot(page);
    expect(seen.fuelRoom).toEqual(['Jeremy', 'Sean', 'Vincent', 'Brendan', 'Maya']);
    expect(seen.guilds.find((g) => g.name === 'Fuel')?.members).toBe(6);
    expect(await page.evaluate(() => new Date().toISOString())).toBe(new Date(CLOCK.busy).toISOString());
    await shoot(page, 's5-busy');

    // People: Jeremy's conversation.
    await navigate(page, h.routes.place('people'));
    // Today's UI titles a DM with the username ("jeremy"); the Index titles use the display name.
    await expect(heading(page)).toHaveText(/^jeremy$/i);
    await shoot(page, 's6-people');
  });

  test('a reload lands in the current world (READY carries the changes)', async ({ page }) => {
    const h = await open(page);
    await h.step('arrive');
    await h.reload();

    // Nothing was said while the page was away: the history and the room come from REST and READY.
    await expect(page.getByText('who’s up for a run tonight? I’m in General', { exact: true })).toBeVisible();
    const seen = await snapshot(page);
    expect(seen.fuelRoom).toEqual(['Jeremy']);
    // The call is the page's own state and goes with the reload, as it would for real.
    expect(seen.call.connected).toBe(false);
  });

  test('what you send is stored, announced and shown once', async ({ page }) => {
    const h = await open(page, undefined);
    await h.step('arrive');
    const box = page.getByRole('main').getByRole('textbox').first();
    await box.click();
    await page.keyboard.type('testing the harness');
    await page.keyboard.press('Enter');

    // One bubble (the sidebar preview says "You: testing the harness", a different string).
    await expect(page.getByText('testing the harness', { exact: true })).toHaveCount(1);
    await expect.poll(() => h.world.lastMessageIn('fuelGeneral')?.content).toBe('testing the harness');
    expect(h.world.lastMessageIn('fuelGeneral')?.author).toBe('you');
  });

  test('a step from a package\'s own file is just an object', async ({ page }) => {
    const { defineStep, frames } = await import('./fixtures/index');
    const nickTypes = defineStep('nickTypes', async ({ world, emit }) => {
      await emit(frames.typing(world, 'fuelGeneral', 'nick'));
    });
    const h = await open(page);
    await h.step(nickTypes);
    // The typing store is what every Index conversation reads; the indicator is UI.
    await expect
      .poll(() =>
        page.evaluate(async (channel) => {
          const typing = (await import(/* @vite-ignore */ '/src/stores/typingStore.ts' as string)) as any;
          return (typing.useTypingStore.getState().typingByChannel[channel] ?? []) as string[];
        }, CH.fuelGeneral),
      )
      .toEqual([PEOPLE.nick.id]);
  });
});

test.describe('the harness itself', () => {
  test('ids carry the palette hues the prototype paints (no purples)', async () => {
    const { paletteHueOf, PALETTE } = await import('./fixtures/index');
    // Prototype: Fuel 350, Basecamp 150; Game Night's 195 is an explicit server color.
    expect(paletteHueOf(GUILD.fuel.id)).toBe(350);
    expect(paletteHueOf(GUILD.basecamp.id)).toBe(150);
    expect(GUILD.gameNight.hue).toBe(195);
    expect(paletteHueOf(PEOPLE.you.id)).toBe(200);
    expect(paletteHueOf(PEOPLE.jeremy.id)).toBe(22);
    expect(paletteHueOf(PEOPLE.vincent.id)).toBe(36);
    expect(paletteHueOf(PEOPLE.brendan.id)).toBe(214);
    expect(paletteHueOf(PEOPLE.nick.id)).toBe(162);
    expect(paletteHueOf(PEOPLE.maya.id)).toBe(350);
    for (const hue of PALETTE) expect(hue >= 250 && hue <= 320).toBe(false);
  });

  test('every §1.3 test id resolves through the drivers', async ({ page }) => {
    // A synthetic page with each id once (and the attributes the plan names).
    await page.setContent(`
      <aside data-testid="ix-sidebar">
        <header data-testid="ix-sidebar-header"></header>
        <button data-testid="ix-search-field"></button>
        <div data-testid="ix-room-card" data-state="yours">
          <button data-testid="ix-card-join"></button>
          <button data-testid="ix-card-open-call"></button>
          <button data-testid="ix-card-leave"></button>
        </div>
        <button data-testid="ix-channel-row" data-channel-id="${CH.fuelGeneral}"></button>
        <button data-testid="ix-channel-row" data-channel-id="${CH.fuelClips}"></button>
        <button data-testid="ix-room-row">General</button>
        <nav data-testid="ix-dock">
          <button data-testid="ix-dock-item" data-place="people"></button>
          <button data-testid="ix-dock-item" data-place="${GUILD.fuel.id}"></button>
        </nav>
      </aside>
      <main>
        <div data-testid="ix-toolbar"></div>
        <h1 data-testid="ix-title">general</h1>
        <section data-testid="ix-welcome"><button data-testid="ix-action-card" data-action="plan"></button></section>
        <div data-testid="ix-composer"><input type="text" role="textbox" /></div>
        <div data-testid="ix-call"><button data-testid="ix-call-back"></button><button data-testid="ix-call-leave"></button></div>
      </main>`);
    const { sidebar, sidebarHeader, searchField, dock, toolbar, title, welcome, composerInput, callView, roomRows, cardJoin, cardOpenCall, cardLeave, ix } = await import('./fixtures/index');
    for (const id of TEST_IDS) {
      if (id === 'ix-channel-row') expect(await ix(page, id).count(), id).toBe(2);
      else if (id === 'ix-dock-item') expect(await ix(page, id).count(), id).toBe(2);
      else expect(await ix(page, id).count(), id).toBe(1);
    }
    for (const locator of [sidebar(page), sidebarHeader(page), searchField(page), dock(page), toolbar(page), title(page), welcome(page), composer(page), composerInput(page), callView(page), roomRows(page)]) {
      await expect(locator).toHaveCount(1);
    }
    await expect(channelRow(page, 'fuelGeneral')).toHaveCount(1);
    await expect(channelRow(page, CH.fuelClips)).toHaveCount(1);
    await expect(channelRow(page, 'gnLounge')).toHaveCount(0);
    await expect(dockItem(page, 'people')).toHaveCount(1);
    await expect(dockItem(page, 'fuel')).toHaveCount(1);
    await expect(dockItem(page, 'basecamp')).toHaveCount(0);
    await expect(actionCard(page, 'plan')).toHaveCount(1);
    await expect(actionCard(page, 'hello')).toHaveCount(0);
    await expect(roomCard(page, 'yours')).toHaveCount(1);
    await expect(roomCard(page, 'live')).toHaveCount(0);
    await expect(cardJoin(roomCard(page))).toHaveCount(1);
    await expect(cardOpenCall(roomCard(page))).toHaveCount(1);
    await expect(cardLeave(roomCard(page))).toHaveCount(1);
  });

  test('shots land where the compare tool looks for them', async ({ page }) => {
    await page.setContent('<body style="margin:0;background:#222"></body>');
    const file = await shoot(page, 'harness-selftest', { wp: 'ix0', settle: 0 });
    expect(file).toBe(`${outDir('ix0')}/harness-selftest.png`);
    const small = await shoot(page, 'harness-selftest', { wp: 'ix0', settle: 0, size: 'phone' });
    expect(small).toBe(`${outDir('ix0')}/harness-selftest@390x844.png`);
  });
});
