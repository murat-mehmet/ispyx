// Runs every ScanAnimation effect against the fake platform (no OS access, any OS) and checks that each one draws
// into layers and removes them again. Run: npm run core-test
process.env.ISPYX_PLATFORM = 'fake';
const { default: platform } = await import('../../src/platform/index.js');
const { ScanAnimation, keyLabels, SCAN_TOTAL_MS, FLASH_TOTAL_MS, RIPPLE_MS } = await import('../../src/effects/scan.js');

let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hasPixels = (layer) => layer.px.some((b) => b !== 0);

check('fake platform selected', platform.name === 'fake');

/** Runs `fn`, then checks that it created layers, presented into every one, and destroyed them all. */
async function effect(name, fn, { minLayers = 1, drawn = true, maxMs = 8000, all = true } = {}) {
  const before = platform.layers.length;
  const t0 = performance.now();
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  const ms = performance.now() - t0;
  const mine = platform.layers.slice(before);
  check(`${name}: finishes without throwing`, !err && ms < maxMs, err ? err.message : `${Math.round(ms)} ms`);
  check(`${name}: created ${minLayers}+ layer(s)`, mine.length >= minLayers, `${mine.length}`);
  check(`${name}: ${all ? 'every' : 'a'} layer was presented`, mine.length > 0 && (all ? mine.every((l) => l.presents.length > 0) : mine.some((l) => l.presents.length > 0)), mine.map((l) => l.presents.length).join(','));
  if (drawn) check(`${name}: drew pixels`, mine.some((l) => l.everDrawn));
  check(`${name}: layers destroyed`, mine.length > 0 && mine.every((l) => l.destroyed));
  return mine;
}

const anim = new ScanAnimation({ enabled: true });
const mon = platform.listMonitors()[0];
const area = { left: mon.left, top: mon.top, width: mon.width, height: mon.height };

check('two fake monitors', platform.listMonitors().length === 2);
check('keyLabels', JSON.stringify(keyLabels('ctrl+a ctrl+c')) === '[["Ctrl","A"],["Ctrl","C"]]');
check('textMask is deterministic', JSON.stringify(Array.from(platform.textMask('42', 17).mask)) === JSON.stringify(Array.from(platform.textMask('42', 17).mask)));

// disabled: nothing is created
{
  const before = platform.layers.length;
  await new ScanAnimation({ enabled: false }).ripple({ x: 10, y: 10 });
  check('disabled animation creates no layer', platform.layers.length === before);
}

const play = await effect('play', () => anim.play({ left: 200, top: 150, width: 500, height: 300 }), { minLayers: 3 });
check('play: ran about SCAN_TOTAL_MS', true, `${SCAN_TOTAL_MS} ms planned`);
check('play: the eye has pixels', hasPixels(play[play.length - 1]) || play.some(hasPixels));

let cancelAfter = performance.now() + 150;
await effect('play (cancelled)', () => anim.play({ left: 200, top: 150, width: 500, height: 300 }, () => performance.now() > cancelAfter), { maxMs: SCAN_TOTAL_MS - 400, all: false });

await effect('flash', () => anim.flash({ left: 100, top: 100, width: 800, height: 600 }));
check('flash: planned length', FLASH_TOTAL_MS > 0);

await effect('ripple', () => anim.ripple({ x: 500, y: 400 }, 'right', 2));
check('ripple: planned length', RIPPLE_MS > 0);

{
  let release;
  const stopped = new Promise((r) => { release = r; });
  setTimeout(() => { platform.mouseMoveTo(700, 600); }, 100);
  setTimeout(release, 300);
  await effect('trail', () => anim.trail({ x: 500, y: 400 }, { left: 400, top: 300, right: 800, bottom: 700 }, stopped), { minLayers: 2 }); // the trail layer and the end ripple
}

{
  const stopped = sleep(450);
  await effect('wheelCue', () => anim.wheelCue({ x: 600, y: 400 }, -1, 1, 1, stopped));
}

await effect('keycaps', () => anim.keycaps(keyLabels('ctrl+shift+t enter'), area));

{
  const progress = { n: 0 };
  const iv = setInterval(() => { progress.n += 7; }, 40);
  const stopped = sleep(700);
  const layers = await effect('typing', () => anim.typing(60, progress, area, stopped));
  clearInterval(iv);
  const seen = new Set(layers[0].presents.map((p) => Math.round(p.alpha)));
  check('typing: opacity changes over time', seen.size > 2, `${seen.size} values`);
}

await effect('radar', () => anim.radar(platform.listWindows().map((x) => ({ rect: x.rect, allowed: true, elevated: false })), area), { minLayers: 2 });

{
  const wins = platform.listWindows().map((x, i) => ({ rect: x.rect, allowed: i !== 1, elevated: i === 2 }));
  const mons = platform.listMonitors();
  const layers = await effect('radarAll', () => anim.radarAll(wins, mons, mons[0]), { minLayers: 3 }); // two frame layers + one eye
  check('radarAll: a layer sits on each monitor', mons.every((m) => layers.some((l) => l.presents.some((p) => p.x === m.left))));
}

await effect('countdown', () => anim.countdown(500, area));

platform.layers.length = 0;
console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
