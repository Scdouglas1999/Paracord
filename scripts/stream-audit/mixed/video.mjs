// video.mjs: share, watch, step Viewing quality; screenshots + marks (stream-fix V7 item 1/2).
//   RUN=<run> node video.mjs --preset 1080p60 --tag x
import { appendFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, sleep, mono, log, OUT } from './drv.mjs';
const arg = (n, f) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? f : process.argv[i + 1]; };
const preset = arg('preset', '1080p60'); const tag = arg('tag', 'vid');
const qualities = arg('qualities', 'auto,low,medium,high,source,auto').split(',');
const LABEL = { '720p30': '720p 30fps', '1080p60': '1080p 60fps', '1440p60': '1440p 60fps' };
const H = join(dirname(fileURLToPath(import.meta.url)), '..');
const mark = (e, info = {}) => appendFileSync(join(OUT, 'video-marks.log'), `${mono()} ${e} ${JSON.stringify({ tag, ...info })}\n`);
const shot = (role, name) => { try { execFileSync('bash', [`${H}/shot.sh`, join(OUT, role), join(OUT, `${tag}-${name}.png`)], { stdio: 'ignore' }); } catch {} return `${tag}-${name}.png`; };
async function senderOpenCall() {
  await run('sender', `
    if (!$('[data-testid=ix-card-leave]')) { await click($('[data-testid=ix-card-join]') ?? $('[data-testid=ix-room-row]')); await waitFor(() => $('[data-testid=ix-card-leave]'), 30000); }
    if (!$('[data-testid=ix-call]')) { await click($('[data-testid=ix-card-open-call]')); await waitFor(() => $('[data-testid=ix-call]'), 15000); }
    return true;`, 60000);
}
async function senderQuality(p) {
  return run('sender', `
    await click(await waitFor(() => btn('More call actions'), 15000)); await sleep(500);
    const item = $$('[role=menuitem]').find((b) => /^Share quality/.test(text(b)));
    await click(item); await sleep(500);
    const opt = $$('[aria-label="Share quality"] button').find((b) => text(b).startsWith(${JSON.stringify(LABEL[preset])}));
    if (!opt) throw new Error('no option');
    await click(opt); await sleep(1500);
    if ($('[aria-label="Share quality"]')) { document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await sleep(300); }
    return true;`, 30000);
}
async function senderStart() {
  return run('sender', `
    if (btn('Stop sharing your screen')) return 'already';
    await click(btn('Share your screen'));
    await waitFor(() => $('[role=radiogroup][aria-label="What to share"] [role=radio]'), 15000);
    await click($('[role=radio]')); await sleep(300);
    await click($$('button').filter((b) => text(b) === 'Share').pop());
    await waitFor(() => btn('Stop sharing your screen'), 40000);
    return true;`, 60000);
}
const VIEW_STATE = `const s = $('.ix-call-stream'); return { live: s?.dataset.underlay ?? null, picture: s?.dataset.picture ?? null, call: !!$('[data-testid=ix-call]'), notice: $('.ix-call-notice')?.textContent ?? null };`;
async function viewerWatch() {
  for (let i = 0; i < 4; i++) {
    const st = await run('viewer', VIEW_STATE).catch(() => null);
    if (st?.live === 'live' && st.picture === 'true') return st;
    await run('viewer', `
      if (!$('[data-testid=ix-card-leave]')) { const j = $('[data-testid=ix-card-join]'); if (j) { await click(j); await waitFor(() => $('[data-testid=ix-card-leave]'), 30000); } }
      const again = $$('button').find((b) => text(b) === 'Watch again');
      if (again) await click(again);
      else { const w = btn(/^Watch vincent/i); if (w) await click(w); else if (!$('[data-testid=ix-call]')) { const o = $('[data-testid=ix-card-open-call]'); if (o) await click(o); } }
      await waitFor(() => $('.ix-call-stream')?.dataset.underlay === 'live' && $('.ix-call-stream')?.dataset.picture === 'true', 30000, 200).catch(() => null);
      return true;`, 45000).catch((e) => log('watch', e.message));
    await sleep(1500);
  }
  return run('viewer', VIEW_STATE);
}
async function viewerQuality(value) {
  return run('viewer', `
    if (!$('.glass-stage-popover__select')) { await click(btn('Stream sound and quality')); await sleep(500); }
    const sel = $('.glass-stage-popover__select');
    if (!sel) return 'no select';
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(value)});
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    if ($('.glass-stage-popover__select')) await click(btn('Stream sound and quality'));
    return [...sel.options].map((o) => o.value + (o.selected ? '*' : '')).join(',');`);
}
await senderOpenCall();
await senderQuality(preset);
log('share', await senderStart());
await sleep(3000);
log('watch', JSON.stringify(await viewerWatch()));
await sleep(4000);
for (const q of qualities) {
  const r = await viewerQuality(q);
  mark('quality', { q, options: r });
  log('quality', q, r);
  await sleep(6000);
  const st = await run('viewer', VIEW_STATE);
  mark('shot', { q, st, file: shot('viewer', q) });
  log('  state', JSON.stringify(st));
}
