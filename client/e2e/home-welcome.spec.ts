import { expect, test } from '@playwright/test';
import { installGlassScene } from './fixtures/glass/install';

for (const width of [1440, 390]) {
  test(`fresh Home has a restrained tint and useful actions at ${width}px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await installGlassScene(page, { quiet: true, noTyping: true, roomFixture: false });
    await page.addInitScript(() => {
      const w = window as unknown as { __pcStream: { once: Array<{ d: { guilds?: unknown[] } }>; repeat: unknown[] } };
      w.__pcStream.once.forEach(frame => { if (frame.d?.guilds) frame.d.guilds = []; });
      w.__pcStream.repeat = [];
    });
    for (const endpoint of ['guilds', 'dms', 'read-states', 'relationships']) {
      await page.route(`**/api/v1/users/@me/${endpoint}`, route => route.fulfill({ headers: { 'X-Paracord-History-Epoch': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }, json: [] }));
    }
    await page.goto('/app');
    await expect(page.getByRole('heading', { name: 'A place for your people.' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Find friends' })).toBeInViewport();
    await expect(page.getByText('Checking for new messages…').first()).toHaveCount(0, { timeout: 30_000 });
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--room-rgb').trim())).toBe('82, 143, 219');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `/tmp/paracord-home-slate-${width}.png` });
    await page.getByRole('button', { name: 'Join with an invite' }).click();
    await expect(page.getByRole('tab', { name: 'Join', exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}
