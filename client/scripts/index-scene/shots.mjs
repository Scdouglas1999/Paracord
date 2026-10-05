// Named states of the viewer, one per reference render
// (output/design-reference/index/ref/<state>.png), captured from the viewer's
// own browser to <out>/<state>.png.
//
// A state is one small object:
//
//   's1-someone-arrives': {
//     at: 'arrived',                 // the story position it needs (story.mjs)
//     talking: true,                 // wait for a talking cue before the shot (best effort)
//     async run(ctx) { ... },        // navigate and wait; the driver takes the shot
//     async after(ctx) { ... },      // undo anything the state left behind
//   }
//
// `run` may return `{ pending: '...' }` when the interface under it cannot show
// the state yet (a control only Index carries); the state is then reported
// pending, not failed, and not shot. Every shot records which interface was on
// screen (`ui: 'glass' | 'index'`) so a run against today's build is never
// mistaken for a run against Index.
//
// Where the Index build is on screen the state asserts the test ids it is
// specified to carry (docs/design/index-plan.md 1.3); on Glass it asserts
// nothing beyond "the text the state is about is on screen".

import { CONTROLS, freshFrame, sceneOnScreen } from '../scene-lib/ui.mjs';
import { IX, backToChat, dismissOverlays, findControl, openCall, press, uiKind } from './ui.mjs';
import { ENCRYPTION_PASSWORD } from './scene.mjs';

/** Wait for text on screen, then let entrance motion finish. */
async function settleOn(ctx, text, timeoutMs = 30_000) {
  await ctx.page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout: timeoutMs });
  await dismissOverlays(ctx.page, 400, 2500);
  await ctx.viewer.settle({ minMs: 1200 });
}

/**
 * Wait until somebody is on screen as talking: Glass says "X is talking"; Index
 * runs its waveform loop only while a person talks (spec 4.4), which shows as an
 * animation with no end. A synthetic voice speaks in phrases with pauses
 * between, so a shot taken at a random moment can land in a pause; waiting for
 * the cue makes the talking ring part of the frame. Best effort: it reports
 * whether the cue was seen, never fails the shot.
 */
async function waitForTalking(page, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const seen = await page.evaluate(() =>
      /\b(is|are) talking\b/i.test(document.body.innerText)
      || document.getAnimations().some(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity),
    ).catch(() => false);
    if (seen) return true;
    await page.waitForTimeout(120);
  }
  return false;
}

/**
 * On Index, a selector the spec promises must be there; on Glass it is not
 * asked for. With `--lenient` (a build that is half Glass, half Index) a
 * missing one is listed on the shot instead of failing it.
 */
async function expectIndex(ctx, selector, what, timeoutMs = 10_000) {
  if ((await uiKind(ctx.page)) !== 'index') return;
  const there = await ctx.page.locator(selector).first().waitFor({ state: 'visible', timeout: timeoutMs }).then(() => true).catch(() => false);
  if (there) return;
  const message = `the Index build has no ${what} (${selector}) in this state`;
  if (!ctx.lenient) throw new Error(message);
  ctx.missing.push(message);
}

/** The conversation's own scroller: the largest scrollable box in main. */
async function scrollFeed(page, to) {
  const scrolled = await page.evaluate(target => {
    const root = document.querySelector('main') ?? document.body;
    let best = null;
    for (const el of root.querySelectorAll('*')) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY)) continue;
      if (el.scrollHeight <= el.clientHeight + 2) continue;
      if (!best || el.clientHeight > best.clientHeight) best = el;
    }
    if (!best) return null;
    const max = best.scrollHeight - best.clientHeight;
    best.scrollTop = target === 'bottom' ? max : Math.min(target, max);
    best.dispatchEvent(new Event('scroll'));
    return { top: best.scrollTop, max };
  }, to);
  await page.waitForTimeout(600);
  return scrolled;
}

/** Unlock encryption here if the page offers it (a conversation that is locked). */
async function unlockHere(ctx) {
  const { page } = ctx;
  const link = page.getByRole('link', { name: 'Unlock encryption' });
  if (!(await link.isVisible().catch(() => false))) return;
  await link.click();
  const password = page.locator('input[type="password"]').first();
  await password.waitFor({ state: 'visible', timeout: 15_000 });
  await password.fill(ENCRYPTION_PASSWORD);
  await page.getByRole('button', { name: 'Unlock', exact: true }).click();
  await page.waitForURL(url => !url.pathname.startsWith('/unlock'), { timeout: 30_000 });
}

const composer = page => page.locator('textarea[data-composer-input]').first();

export const STATES = {
  's0-quiet': {
    at: 'quiet',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await expectIndex(ctx, IX.welcome, 'welcome ("Fuel is ready")');
      await ctx.viewer.settle({ minMs: 1500 });
    },
  },

  's0-plan-a-night': {
    at: 'quiet',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      if ((await uiKind(ctx.page)) !== 'index') {
        return { pending: 'Plan a night is an Index action card (ix-action-card, IX-15); Glass has no such card' };
      }
      await ctx.page.locator(`${IX.actionCard}[data-action="plan"]`).first().click({ timeout: 10_000 });
      await ctx.viewer.settle({ minMs: 1500 });
    },
    async after(ctx) {
      // The draft is the client's; going somewhere else and back drops it.
      if ((await uiKind(ctx.page)) !== 'index') return;
      await ctx.viewer.go('fuel', 'clips', { settleMs: 300 });
      await ctx.viewer.go('fuel', 'general', { settleMs: 300 });
    },
  },

  's0-message-box-open': {
    at: 'quiet',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await composer(ctx.page).click({ timeout: 10_000 });
      await ctx.page.keyboard.type('testing the box');
      await ctx.viewer.settle({ minMs: 1200 });
    },
    async after(ctx) {
      const box = composer(ctx.page);
      await box.fill('').catch(() => {});
      await box.blur().catch(() => {});
    },
  },

  's1-someone-arrives': {
    talking: true,
    at: 'arrived',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await settleOn(ctx, 'who’s up for a run tonight');
      await expectIndex(ctx, IX.card, 'live room card');
    },
  },

  's2-joined': {
    talking: true,
    at: 'joined',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await settleOn(ctx, 'who’s up for a run tonight');
      await expectIndex(ctx, IX.cardLeave, 'leave control on your card');
    },
  },

  's3-call-open': {
    talking: true,
    at: 'joined',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await openCall(ctx.page);
      await ctx.viewer.settle({ minMs: 2000 });
    },
    async after(ctx) {
      await backToChat(ctx.page).catch(() => {});
      await ctx.viewer.settle({ minMs: 600 });
    },
  },

  's4-other-server': {
    talking: true,
    at: 'joined',
    async run(ctx) {
      await ctx.viewer.go('gameNight', 'lounge');
      await settleOn(ctx, 'streaming in Lounge if anyone wants to watch');
      await expectIndex(ctx, IX.card, 'Game Night’s own live card');
    },
    async after(ctx) {
      await ctx.viewer.go('fuel', 'general', { settleMs: 300 });
    },
  },

  's5-busy': {
    talking: true,
    at: 'busy',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await settleOn(ctx, 'yep, bringing the projector');
      const at = await scrollFeed(ctx.page, 'bottom');
      ctx.log(`  ${' '.repeat(22)} feed at ${at ? `${Math.round(at.top)} of ${Math.round(at.max)}` : 'no scroller'}`);
      await ctx.viewer.settle({ minMs: 800 });
    },
  },

  's5-busy-title-folded': {
    talking: true,
    at: 'busy',
    async run(ctx) {
      await ctx.viewer.go('fuel', 'general');
      await settleOn(ctx, 'yep, bringing the projector');
      // The reference scrolls the feed to 120px from its top: the large title is gone.
      const at = await scrollFeed(ctx.page, 120);
      ctx.log(`  ${' '.repeat(22)} feed at ${at ? `${Math.round(at.top)} of ${Math.round(at.max)}` : 'no scroller'}`);
      if (at && at.top < 60) ctx.log(`  ${' '.repeat(22)} (the conversation scrolls only ${Math.round(at.max)}px here, too little to fold a title)`);
      await ctx.viewer.settle({ minMs: 800 });
    },
  },

  's6-people': {
    talking: true,
    at: 'busy',
    async run(ctx) {
      await ctx.viewer.goDm(ctx.dms.jeremy);
      await unlockHere(ctx);
      await settleOn(ctx, 'see you tonight');
    },
    async after(ctx) {
      await ctx.viewer.go('fuel', 'general', { settleMs: 300 });
    },
  },
};

/**
 * Not reference renders (`--shot all` skips them, `--check` does not count
 * them): checks that the scene is what it claims to be.
 */
export const DIAGNOSTICS = {
  /**
   * Vincent's share reaches a viewer's screen as pixels: the viewer watches it
   * from Game Night without joining, and the teal crystal light and amber glow
   * of his canvas scene (scene-lib/media-init.mjs) are counted in a fresh
   * screenshot. DOM state alone has been wrong about "the share is on screen".
   */
  'x-lounge-share': {
    at: 'quiet',
    async run(ctx) {
      await ctx.viewer.go('gameNight', 'lounge');
      await settleOn(ctx, 'streaming in Lounge if anyone wants to watch');
      if ((await uiKind(ctx.page)) === 'index') {
        await ctx.page.getByRole('button', { name: /^Watch Vincent/ }).first().click({ timeout: 15_000 });
      } else {
        await press(ctx.page, CONTROLS.watch, { timeoutMs: 30_000 });
      }
      const deadline = Date.now() + 60_000;
      let seen = { teal: 0, amber: 0 };
      for (;;) {
        seen = await sceneOnScreen(ctx.page);
        if (seen.teal > 300 && seen.amber > 1500) break;
        if (Date.now() > deadline) throw new Error(`Vincent's share never showed on screen (teal ${seen.teal}px, amber ${seen.amber}px)`);
        await ctx.page.waitForTimeout(1000);
      }
      ctx.log(`  ${' '.repeat(22)} Vincent's scene on the viewer's screen: ${seen.teal}px teal, ${seen.amber}px amber`);
      return { png: seen.png };
    },
    async after(ctx) {
      const stop = await findControl(ctx.page, CONTROLS.stopWatching);
      if (stop) await stop.click().catch(() => {});
      await ctx.viewer.go('fuel', 'general', { settleMs: 300 });
    },
  },
};

const ALL_STATES = { ...STATES, ...DIAGNOSTICS };
export const STATE_NAMES = Object.keys(STATES);

export function resolveStates(arg) {
  if (!arg) return STATE_NAMES;
  return arg.split(',').flatMap(name => {
    name = name.trim();
    if (name === 'all') return STATE_NAMES;
    if (!ALL_STATES[name]) throw new Error(`no state named "${name}". Known: ${STATE_NAMES.join(', ')}; diagnostics: ${Object.keys(DIAGNOSTICS).join(', ')}`);
    return [name];
  });
}

/** One state: get the scene to its position, run it, shoot. Returns the result record. */
export async function shoot(ctx, name, { out, writeFile, join, viewport }) {
  const state = ALL_STATES[name];
  const { story, viewer, log } = ctx;
  const record = { name, status: 'ok', ui: null, path: join(out, `${name}.png`), at: state.at };
  try {
    record.stage = 'scene';
    await story.ensure(state.at);
    record.stage = 'state';
    await viewer.size(viewport);
    ctx.missing = [];
    const outcome = await state.run(ctx);
    if (ctx.missing.length) {
      record.missing = ctx.missing;
      for (const message of ctx.missing) log(`  ${' '.repeat(22)} (missing: ${message})`);
    }
    record.ui = await uiKind(ctx.page);
    if (outcome?.pending) {
      record.status = 'pending';
      record.reason = outcome.pending;
      delete record.path;
      log(`  ${name.padEnd(22)} pending — ${outcome.pending}`);
    } else {
      if (outcome?.png) {
        writeFile(record.path, outcome.png);
        log(`  ${name.padEnd(22)} ${record.path}  [${record.ui}]`);
        return record;
      }
      if (state.talking) {
        record.talking = await waitForTalking(ctx.page);
        if (!record.talking) log(`  ${' '.repeat(22)} (nobody showed as talking within 15s; the frame has no ring)`);
      }
      const lag = await freshFrame(ctx.page);
      if (lag > 1000) log(`  ${' '.repeat(22)} (waited ${lag}ms for a fresh frame)`);
      await ctx.page.screenshot({ path: record.path });
      log(`  ${name.padEnd(22)} ${record.path}  [${record.ui}]`);
    }
  } catch (error) {
    record.status = 'failed';
    record.error = error.message.split('\n')[0];
    record.path = join(out, `${name}--failed.png`);
    await ctx.page.screenshot({ path: record.path }).catch(() => {});
    log(`  ${name.padEnd(22)} FAILED: ${record.error}  (${record.path})`);
  } finally {
    if (state.after) await state.after(ctx).catch(error => log(`  ${' '.repeat(22)} (cleanup: ${error.message.split('\n')[0]})`));
  }
  return record;
}
