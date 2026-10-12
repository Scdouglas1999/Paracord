/**
 * The first-run review harness checks itself (docs/design/setup-plan.md S13a).
 * There is no first-run UI yet in the package that owns this file: what is held
 * here is the scene a UI is later held against, driven through the real
 * `@tauri-apps/api` the app will use, from a blank page on the dev server.
 *
 *   PARACORD_E2E_SETUP_SPEC=setup-harness npx playwright test -c e2e/setup-review.config.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { FINGERPRINT, INVITES, THIS_COMPUTER, inviteUrl, installSetupScene, portableInviteUrl, showWords, trustWords, type ProgressEvent } from './fixtures/setup';
import { wordlist } from '../src/lib/bip39-wordlist';

const BLANK = '/__setup-blank';

async function blank(page: Page): Promise<void> {
  await page.route(`**${BLANK}`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>blank</title><body></body>' }));
  await page.goto(BLANK);
}

/** The real Tauri JS API, loaded from the dev server, bound to window helpers. */
async function tauri(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const core = await import('/node_modules/@tauri-apps/api/core.js' as string);
    const event = await import('/node_modules/@tauri-apps/api/event.js' as string);
    const w = window as unknown as Record<string, unknown>;
    w.__invoke = async (cmd: string, args?: unknown) => {
      try {
        return { ok: true, value: await core.invoke(cmd, args) };
      } catch (error) {
        return { ok: false, error: String(error) };
      }
    };
    w.__events = [] as unknown[];
    for (const name of ['host://progress', 'trust://identity-changed']) await event.listen(name, (e: { payload: unknown }) => (w.__events as unknown[]).push({ name, payload: e.payload }));
  });
}

const invoke = <T = unknown>(page: Page, cmd: string, args?: unknown) =>
  page.evaluate(([c, a]) => (window as unknown as { __invoke: (c: string, a?: unknown) => Promise<{ ok: boolean; value?: unknown; error?: string }> }).__invoke(c as string, a), [cmd, args] as const) as Promise<
    { ok: true; value: T } | { ok: false; error: string }
  >;

const events = (page: Page, name: string) => page.evaluate((n) => ((window as unknown as { __events: Array<{ name: string; payload: unknown }> }).__events).filter((e) => e.name === n).map((e) => e.payload), name);

test.describe('desktop scene', () => {
  test('the page is a Tauri window and every unscripted command fails loudly', async ({ page }) => {
    const scene = await installSetupScene(page);
    await blank(page);
    await tauri(page);
    expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window)).toBe(true);
    const r = await invoke(page, 'native_render_attach', {});
    expect(r).toEqual({ ok: false, error: expect.stringContaining('"native_render_attach" is not stubbed') });
    expect(() => scene.expectNothingUnhandled()).toThrow(/Tauri native_render_attach/);
  });

  for (const reason of ['no_user_services', 'no_keychain', 'existing_server', 'no_port', 'no_space'] as const) {
    test(`preflight refuses with ${reason}`, async ({ page }) => {
      await installSetupScene(page, { preflight: reason });
      await blank(page);
      await tauri(page);
      const r = await invoke<{ ok: boolean; reason: string; existing_url?: string }>(page, 'host_preflight');
      expect(r.ok && r.value).toMatchObject({ ok: false, reason });
      if (reason === 'existing_server') expect((r as { value: { existing_url: string } }).value.existing_url).toBe('https://127.0.0.1:8443');
    });
  }

  test('preflight ok and already_hosting never block', async ({ page }) => {
    const scene = await installSetupScene(page);
    await blank(page);
    await tauri(page);
    for (const preflight of ['ok', 'already_hosting'] as const) {
      scene.host!.preflight = preflight;
      expect(await invoke(page, 'host_preflight')).toEqual({ ok: true, value: { ok: true, port: THIS_COMPUTER.port } });
    }
  });

  const REACH: Array<[Parameters<typeof installSetupScene>[1] extends infer O ? NonNullable<O>['reach'] : never, string, string]> = [
    ['open', 'ok', 'Your router opened the way. Friends can reach you at 73.162.4.19.'],
    ['direct', 'ok', 'This computer has its own public address (73.162.4.19). Friends can reach it if your firewall allows port 8443.'],
    ['refused', 'warn', "Your router didn't allow it, so for now only people on your home network can join."],
    ['no_answer', 'warn', "Your router didn't answer, so for now only people on your home network can join."],
    ['shared_address', 'warn', "Your internet connection shares its public address with others (your provider, or another router in front of yours), so friends outside can't reach this computer. People on your home network can join."],
    ['firewall_blocked', 'warn', 'Windows Firewall is blocking friends.'],
  ];
  for (const [reach, state, detail] of REACH) {
    test(`setup progress plays rows 1, 2, then 4, 5 and the reach row is ${reach}`, async ({ page }) => {
      await installSetupScene(page, { reach, progressDelayMs: 5 });
      await blank(page);
      await tauri(page);
      // S7's contract: rows 1-2, then (after the page's row 3 and escrow) rows 4-5.
      expect((await invoke(page, 'host_setup_start', { port: THIS_COMPUTER.port })).ok).toBe(true);
      await expect.poll(async () => (await events(page, 'host://progress')).some((e) => (e as ProgressEvent).row === 2 && (e as ProgressEvent).state === 'ok')).toBe(true);
      expect((await invoke(page, 'host_write_escrow', { wrappingKey: 'x' })).ok).toBe(true);
      expect((await invoke(page, 'host_setup_start', { port: THIS_COMPUTER.port })).ok).toBe(true);
      await expect.poll(async () => (await events(page, 'host://progress')).some((e) => (e as ProgressEvent).row === 5 && (e as ProgressEvent).state === 'ok')).toBe(true);
      const got = (await events(page, 'host://progress')) as ProgressEvent[];
      expect(got.map((e) => e.row)).toEqual([...got.map((e) => e.row)].sort((a, b) => a - b));
      expect(got.find((e) => e.row === 4 && e.state !== 'run')).toMatchObject({ state, detail, code: reach });
    });
  }

  test('a failing row stops the sequence; manual mode steps one event at a time', async ({ page }) => {
    const scene = await installSetupScene(page, { setup: 'start_fail', progress: 'manual' });
    await blank(page);
    await tauri(page);
    await invoke(page, 'host_setup_start', { port: 8443 });
    expect(await events(page, 'host://progress')).toHaveLength(0); // nothing until stepped
    expect(await scene.host!.step()).toBe(true);
    await expect.poll(async () => (await events(page, 'host://progress')).length).toBe(1);
    await scene.host!.finish();
    await expect.poll(async () => (await events(page, 'host://progress')).length).toBeGreaterThan(5);
    const got = (await events(page, 'host://progress')) as ProgressEvent[];
    expect(got.at(-1)).toMatchObject({ row: 1, step: 'start', state: 'fail', detail: "Paracord on this computer didn't start." });
    expect(got.some((e) => e.row >= 2)).toBe(false);
    expect(await scene.host!.step()).toBe(false);
  });

  test('the clipboard and a pending deep link are what the page reads', async ({ page }) => {
    const scene = await installSetupScene(page, { clipboard: inviteUrl('Rf8kQ2'), pendingDeepLinks: [portableInviteUrl('Rf8kQ2')] });
    await blank(page);
    await tauri(page);
    expect(await invoke(page, 'plugin:clipboard-manager|read_text')).toEqual({ ok: true, value: 'https://kanto.home.arpa:8443/invite/Rf8kQ2' });
    expect(await invoke(page, 'take_pending_deep_links')).toEqual({ ok: true, value: ['paracord://invite/kanto.home.arpa:8443/Rf8kQ2'] });
    expect(await invoke(page, 'take_pending_deep_links')).toEqual({ ok: true, value: [] }); // taken once
    scene.host!.setClipboard(null);
    expect(await invoke(page, 'plugin:clipboard-manager|read_text')).toEqual({ ok: true, value: null });
  });

  test('first contact: probe shows the identity, trust pins only what was shown, a change is announced', async ({ page }) => {
    const scene = await installSetupScene(page);
    await blank(page);
    await tauri(page);
    const probe = await invoke<{ fingerprint: string; ca_verified: boolean }>(page, 'probe_server', { serverUrl: 'https://kanto.home.arpa:8443' });
    expect(probe).toMatchObject({ ok: true, value: { fingerprint: FINGERPRINT.kanto, ca_verified: false } });
    // A self-signed host shows four words; a CA-issued one does not need them.
    expect(await invoke(page, 'probe_server', { serverUrl: 'https://kanto.example.com:8443' })).toMatchObject({ ok: true, value: { ca_verified: true } });
    expect(await invoke(page, 'trust_server', { url: 'https://kanto.home.arpa:8443', fingerprint: FINGERPRINT.kantoReissued })).toEqual({
      ok: false,
      error: "This server's identity changed while you were looking at it.",
    });
    expect((await invoke(page, 'trust_server', { url: 'https://kanto.home.arpa:8443', fingerprint: FINGERPRINT.kanto })).ok).toBe(true);
    await scene.host!.rekey('kanto.home.arpa', { fingerprint: FINGERPRINT.kantoReissued, caVerified: false });
    await expect.poll(async () => (await events(page, 'trust://identity-changed')).length).toBe(1);
    expect((await events(page, 'trust://identity-changed'))[0]).toEqual({ host: 'kanto.home.arpa', pinned_fp: FINGERPRINT.kanto, presented_fp: FINGERPRINT.kantoReissued });
    expect((await invoke(page, 'accept_changed_identity', { host: 'kanto.home.arpa', presented_fp: FINGERPRINT.kanto })).ok).toBe(false);
    expect((await invoke(page, 'accept_changed_identity', { host: 'kanto.home.arpa', presented_fp: FINGERPRINT.kantoReissued })).ok).toBe(true);
    expect(scene.host!.pinned.get('kanto.home.arpa')).toBe(FINGERPRINT.kantoReissued);
  });
});

test.describe('invite previews', () => {
  test('every scripted invite answers what its scenario says', async ({ page }) => {
    const scene = await installSetupScene(page);
    await blank(page);
    const get = (code: string, host = 'kanto.home.arpa') =>
      page.evaluate(async ([c, h]) => {
        try {
          const r = await fetch(`https://${h}:8443/api/v1/invites/${c}`);
          return { status: r.status, body: await r.json() };
        } catch (error) {
          return { failed: String(error) };
        }
      }, [code, host]);

    const good = (await get('Rf8kQ2')) as { status: number; body: { guild: { name: string; hue: number; online_count: number; member_count: number }; faces: unknown[]; instance: { credential_version: number } } };
    expect(good.status).toBe(200);
    expect(good.body.guild).toMatchObject({ name: 'Kanto Friends', hue: 200, online_count: 9, member_count: 41 });
    expect(good.body.faces).toHaveLength(3);
    expect(good.body.instance.credential_version).toBe(2);

    expect(await get('Gone404')).toMatchObject({ status: 404 });
    const old = (await get('OldSrv1')) as { status: number; body: Record<string, unknown> };
    expect(old.status).toBe(200);
    expect('instance' in old.body).toBe(false); // absent instance = an older server (spec 3.12)
    expect(await get('Unreach1', 'nowhere.home.arpa')).toHaveProperty('failed');
    expect(await get('NotAnInvite')).toMatchObject({ status: 404 });
    expect(scene.unhandled).toEqual([]);
    for (const code of Object.keys(INVITES)) expect(inviteUrl(code as keyof typeof INVITES)).toContain(`/invite/${code}`);
  });

  test('an API call the scene does not know is a recorded 404, not a made-up answer', async ({ page }) => {
    const scene = await installSetupScene(page);
    await blank(page);
    const status = await page.evaluate(async () => (await fetch('https://kanto.home.arpa:8443/api/v1/guilds')).status);
    expect(status).toBe(404);
    expect(scene.unhandled).toEqual(['GET /api/v1/guilds']);
    expect(() => scene.expectNothingUnhandled()).toThrow(/GET \/api\/v1\/guilds/);
  });
});

test('the web scene has no Tauri at all', async ({ page }) => {
  const scene = await installSetupScene(page, { desktop: false });
  await blank(page);
  expect(scene.host).toBeNull();
  expect(await page.evaluate(() => '__TAURI_INTERNALS__' in window || '__TAURI__' in window)).toBe(false);
});

test('trust words: four BIP39 words, stable, and different per certificate', () => {
  const words = trustWords(FINGERPRINT.kanto);
  expect(words).toHaveLength(4);
  for (const w of words) expect(wordlist).toContain(w);
  expect(showWords(FINGERPRINT.kanto)).toBe(words.join(' · '));
  expect(trustWords(FINGERPRINT.kanto)).toEqual(words);
  expect(trustWords(FINGERPRINT.kantoReissued)).not.toEqual(words);
  for (const fp of Object.values(FINGERPRINT)) expect(fp).toMatch(/^[0-9a-f]{64}$/);
  expect(() => trustWords('abcd')).toThrow(/32 bytes/);
});

test('the scene reports a reference-sized viewport', async ({ page }) => {
  const scene = await installSetupScene(page);
  await blank(page);
  expect(page.viewportSize()).toEqual({ width: 1280, height: 800 });
  const file = await scene.shoot('harness-blank');
  expect(file).toMatch(/setup-build\/[^/]+\/harness-blank\.png$/);
});
