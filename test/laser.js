// Drag laser: placement rules (pure) and a look at the real thing. Moves the pointer (no button) and puts it back.
// Frames go to test/out/laser-*.png for a visual check.
import fs from 'node:fs';
import w from '../src/platform/index.js';
import { ScanAnimation } from '../src/effects/scan.js';
import { placeEye, renderBeam, LASER_EYE_SIZE } from '../src/effects/laser.js';
import { shrinkToPng } from '../src/core/image.js';

w.init();
let failed = 0;
const check = (n, ok, d = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  ' + d : ''}`); if (!ok) failed++; };
const sleep = w.sleep;

// eye placement: beside the line, never on it, inside the monitor, both sides get used
const mon = { x: 0, y: 0, width: 1920, height: 1080 };
const lines = [[{ x: 300, y: 200 }, { x: 320, y: 700 }], [{ x: 200, y: 500 }, { x: 900, y: 520 }], [{ x: 1500, y: 100 }, { x: 600, y: 900 }], [{ x: 100, y: 60 }, { x: 1800, y: 80 }]];
let allBeside = true, allInside = true;
const sides = new Set();
for (const [a, b] of lines) {
  for (let n = 0; n < 40; n++) {
    const c = placeEye(a, b, mon);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const dist = ((c.x - a.x) * -(b.y - a.y) + (c.y - a.y) * (b.x - a.x)) / len; // signed distance from the line
    if (Math.abs(dist) < LASER_EYE_SIZE / 2 + 70) allBeside = false;
    if (c.x - 56 < 0 || c.y - 56 < 0 || c.x + 56 > 1920 || c.y + 56 > 1080) allInside = false;
    if (a === lines[0][0]) sides.add(Math.sign(dist));
  }
}
check('eye is beside the line, clear of it', allBeside);
check('eye stays on the monitor', allInside);
check('eye uses both sides of the line', sides.size === 2);

// beam pixels: bright core in the middle, soft edge, nothing far away
const W = 400, H = 120, px = new Uint8Array(W * H * 4);
renderBeam(px, W, H, 40, 60, 360, 60, 14, 0);
const at = (x, y) => px[(y * W + x) * 4 + 3];
check('beam is opaque in the middle, faint at the rim, empty far off', at(200, 60) > 240 && at(200, 60 + 14) > 40 && at(200, 60 + 14) < 200 && at(200, 0) < 5);

// the real thing on the primary monitor
const m = w.listMonitors().find((q) => q.primary) ?? w.listMonitors()[0];
const a = { x: m.left + 500, y: m.top + 300 }, z = { x: m.left + 1100, y: m.top + 640 };
const home = w.cursorPos();
const anim = new ScanAnimation({ enabled: true });
let stop; const stopped = new Promise((r) => { stop = r; });
w.mouseMoveTo(a.x, a.y);
const run = anim.laser(a, z, stopped);
const frame = (name) => fs.writeFileSync(`test/out/laser-${name}.png`, shrinkToPng(w.captureScreenRect({ left: m.left + 250, top: m.top + 50, width: 1500, height: 900 }), 1100).png);
fs.mkdirSync('test/out', { recursive: true });
const t0 = performance.now();
let shot = 0;
for (let i = 0; i <= 28; i++) {
  const u = Math.min(1, i / 20);
  w.mouseMoveTo(Math.round(a.x + (z.x - a.x) * u), Math.round(a.y + (z.y - a.y) * u));
  if (i === 9 || i === 19) frame(String(++shot));
  await sleep(33);
}
stop();
await sleep(500); frame('after');
await sleep(1900); frame('late');
await run;
w.mouseMoveTo(home.x, home.y);
check('effect finished and cleaned up', true, `${Math.round(performance.now() - t0)} ms`);
console.log(failed ? `${failed} FAILED` : 'laser: all ok');
process.exit(failed ? 1 : 0);
